/**
 * @file html-media-source.js
 */
import videojs from 'video.js';
import VirtualSourceBuffer from './virtual-source-buffer';
import {isAudioCodec, isVideoCodec, parseContentType} from './codec-utils';

/**
 * Replace the old apple-style `avc1.<dd>.<dd>` codec string with the standard
 * `avc1.<hhhhhh>`
 *
 * @param {Array} codecs an array of codec strings to fix
 * @return {Array} the translated codec array
 * @private
 */
const translateLegacyCodecs = function(codecs) {
  return codecs.map((codec) => {
    return codec.replace(/avc1\.(\d+)\.(\d+)/i, function(orig, profile, avcLevel) {
      let profileHex = ('00' + Number(profile).toString(16)).slice(-2);
      let avcLevelHex = ('00' + Number(avcLevel).toString(16)).slice(-2);

      return 'avc1.' + profileHex + '00' + avcLevelHex;
    });
  });
};

/**
 * Our MediaSource implementation in HTML, mimics native
 * MediaSource where/if possible.
 *
 * @link https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
 * @class HtmlMediaSource
 * @extends videojs.EventTarget
 */
export default class HtmlMediaSource extends videojs.EventTarget {
  constructor() {
    super();
    let property;

    this.mediaSource_ = new window.MediaSource();
    // delegate to the native MediaSource's methods by default
    for (property in this.mediaSource_) {
      if (!(property in HtmlMediaSource.prototype) &&
          typeof this.mediaSource_[property] === 'function') {
        this[property] = this.mediaSource_[property].bind(this.mediaSource_);
      }
    }

    // emulate `duration` and `seekable` until seeking can be
    // handled uniformly for live streams
    // see https://github.com/w3c/media-source/issues/5
    this.duration_ = NaN;
    Object.defineProperty(this, 'duration', {
      get() {
        if (this.duration_ === Infinity) {
          return this.duration_;
        }
        return this.mediaSource_.duration;
      },
      set(duration) {
        this.duration_ = duration;
        if (duration !== Infinity) {
          this.mediaSource_.duration = duration;
          return;
        }
      }
    });
    Object.defineProperty(this, 'seekable', {
      get() {
        if (this.duration_ === Infinity) {
          return videojs.createTimeRanges([[0, this.mediaSource_.duration]]);
        }
        return this.mediaSource_.seekable;
      }
    });

    Object.defineProperty(this, 'readyState', {
      get() {
        return this.mediaSource_.readyState;
      }
    });

    Object.defineProperty(this, 'activeSourceBuffers', {
      get() {
        return this.activeSourceBuffers_;
      }
    });

    // the list of virtual and native SourceBuffers created by this
    // MediaSource
    this.sourceBuffers = [];

    this.activeSourceBuffers_ = [];

    /**
     * update the list of active source buffers based upon various
     * imformation from HLS and video.js
     *
     * @private
     */
    this.updateActiveSourceBuffers_ = () => {
      // Retain the reference but empty the array
      this.activeSourceBuffers_.length = 0;

      let combined = true;
      let audioOnly = false;

      // TODO: maybe we can store the sourcebuffers on the track objects?
      // safari may do something like this
      for (let i = 0; i < this.player_.audioTracks().length; i++) {
        let track = this.player_.audioTracks()[i];

        if (track.enabled && track.kind !== 'main') {
          combined = false;
          audioOnly = true;
          break;
        }
      }

      // Since we currently support a max of two source buffers, add all of the source
      // buffers (in order).
      this.sourceBuffers.forEach((sourceBuffer) => {
        /* eslinst-disable */
        // TODO once codecs are required, we can switch to using the codecs to determine
        //      what stream is the video stream, rather than relying on videoTracks
        /* eslinst-enable */

        if (sourceBuffer.videoCodec_ && sourceBuffer.audioCodec_) {
          // combined
          sourceBuffer.audioDisabled_ = combined;
        } else if (sourceBuffer.videoCodec_ && !sourceBuffer.audioCodec_) {
          // video only
          sourceBuffer.audioDisabled_ = true;
          audioOnly = true;
        } else if (!sourceBuffer.videoCodec_ && sourceBuffer.audioCodec_) {
          // audio only
          sourceBuffer.audioDisabled_ = audioOnly;
          if (!audioOnly) {
            return;
          }
        }

        this.activeSourceBuffers_.push(sourceBuffer);
      });
    };

    // Re-emit MediaSource events on the polyfill
    [
      'sourceopen',
      'sourceclose',
      'sourceended'
    ].forEach(function(eventName) {
      this.mediaSource_.addEventListener(eventName, this.trigger.bind(this));
    }, this);

    // capture the associated player when the MediaSource is
    // successfully attached
    this.on('sourceopen', (event) => {
      // Get the player this MediaSource is attached to
      let video = document.querySelector('[src="' + this.url_ + '"]');

      if (!video) {
        return;
      }

      this.player_ = videojs(video.parentNode);

      this.player_.audioTracks().on('change', this.updateActiveSourceBuffers_);
      this.player_.audioTracks().on('addtrack', this.updateActiveSourceBuffers_);
      this.player_.audioTracks().on('removetrack', this.updateActiveSourceBuffers_);
    });

    // explicitly terminate any WebWorkers that were created
    // by SourceHandlers
    this.on('sourceclose', function(event) {
      this.sourceBuffers.forEach(function(sourceBuffer) {
        if (sourceBuffer.transmuxer_) {
          sourceBuffer.transmuxer_.terminate();
        }
      });
      this.sourceBuffers.length = 0;
      if (!this.player_) {
        return;
      }

      this.player_.audioTracks().off('change', this.updateActiveSourceBuffers_);
      this.player_.audioTracks().off('addtrack', this.updateActiveSourceBuffers_);
      this.player_.audioTracks().off('removetrack', this.updateActiveSourceBuffers_);

    });
  }

  /**
   * Add a range that that can now be seeked to.
   *
   * @param {Double} start where to start the addition
   * @param {Double} end where to end the addition
   * @private
   */
  addSeekableRange_(start, end) {
    let error;

    if (this.duration !== Infinity) {
      error = new Error('MediaSource.addSeekableRange() can only be invoked ' +
                        'when the duration is Infinity');
      error.name = 'InvalidStateError';
      error.code = 11;
      throw error;
    }

    if (end > this.mediaSource_.duration ||
        isNaN(this.mediaSource_.duration)) {
      this.mediaSource_.duration = end;
    }
  }

  /**
   * Add a source buffer to the media source.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/addSourceBuffer
   * @param {String} type the content-type of the content
   * @return {Object} the created source buffer
   */
  addSourceBuffer(type) {
    let buffer;
    let parsedType = parseContentType(type);

    // create a virtual source buffer to transmux MPEG-2 transport
    // stream segments into fragmented MP4s
    if (parsedType.type === 'video/mp2t') {
      // default codecs
      let codecs = [];

      if (parsedType.parameters && parsedType.parameters.codecs) {
        codecs = parsedType.parameters.codecs.split(',');
        codecs = translateLegacyCodecs(codecs);
        codecs = codecs.filter((codec) => {
          return (isAudioCodec(codec) || isVideoCodec(codec));
        });
      }

      if (codecs.length === 0) {
        codecs = ['avc1.4d400d', 'mp4a.40.2'];
      }

      buffer = new VirtualSourceBuffer(this, codecs);
    } else {
      // delegate to the native implementation
      buffer = this.mediaSource_.addSourceBuffer(type);
    }

    // Automatically disable the audio on the first source buffer if
    // a second source buffer is ever created
    if (this.sourceBuffers.length !== 0) {
      this.sourceBuffers[0].audioDisabled_ = true;
    }

    this.sourceBuffers.push(buffer);
    return buffer;
  }
}
