import videojs from 'video.js';
import VirtualSourceBuffer from './virtual-source-buffer';

// Replace the old apple-style `avc1.<dd>.<dd>` codec string with the standard
// `avc1.<hhhhhh>`
const translateLegacyCodecs = function(codecs) {
  return codecs.replace(/avc1\.(\d+)\.(\d+)/i, function(orig, profile, avcLevel) {
    let profileHex = ('00' + Number(profile).toString(16)).slice(-2);
    let avcLevelHex = ('00' + Number(avcLevel).toString(16)).slice(-2);

    return 'avc1.' + profileHex + '00' + avcLevelHex;
  });
};

export default class HtmlMediaSource extends videojs.EventTarget {
  constructor() {
    super(videojs.EventTarget);
    /* eslint-disable consistent-this */
    let self = this;
    /* eslint-enable consistent-this */
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
        if (self.duration_ === Infinity) {
          return self.duration_;
        }
        return self.mediaSource_.duration;
      },
      set(duration) {
        self.duration_ = duration;
        if (duration !== Infinity) {
          self.mediaSource_.duration = duration;
          return;
        }
      }
    });
    Object.defineProperty(this, 'seekable', {
      get() {
        if (this.duration_ === Infinity) {
          return videojs.createTimeRanges([[0, self.mediaSource_.duration]]);
        }
        return self.mediaSource_.seekable;
      }
    });

    Object.defineProperty(this, 'readyState', {
      get() {
        return self.mediaSource_.readyState;
      }
    });

    Object.defineProperty(this, 'activeSourceBuffers', {
      get() {
        return self.activeSourceBuffers_;
      }
    });

    // the list of virtual and native SourceBuffers created by this
    // MediaSource
    this.sourceBuffers = [];

    this.activeSourceBuffers_ = [];

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
    this.on('sourceopen', function(event) {
      let video = document.querySelector('[src="' + self.url_ + '"]');

      if (!video) {
        return;
      }

      self.player_ = videojs(video.parentNode);
      self.player_.audioTracks().on('change', self.updateActiveSourceBuffers_.bind(self));
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
    });
  }

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

  addSourceBuffer(type) {
    let buffer;
    let codecs;
    let avcCodec;
    let mp4aCodec;
    let avcRegEx = /avc1\.[\da-f]+/i;
    let mp4aRegEx = /mp4a\.\d+.\d+/i;

    // create a virtual source buffer to transmux MPEG-2 transport
    // stream segments into fragmented MP4s
    if ((/^video\/mp2t/i).test(type)) {
      codecs = type.split(';').slice(1).join(';');
      codecs = translateLegacyCodecs(codecs);

      // Pull out each individual codec string if it exists
      avcCodec = (codecs.match(avcRegEx) || [])[0];
      mp4aCodec = (codecs.match(mp4aRegEx) || [])[0];

      // If a codec is unspecified, use the defaults
      // TODO: FIXME
      if (!avcCodec && !mp4aCodec) {
        buffer = new VirtualSourceBuffer(this, ['avc1.4d400d', 'mp4a.40.2']);
      } else if (mp4aCodec && !avcCodec) {
        buffer = new VirtualSourceBuffer(this, [mp4aCodec]);
      } else if (avcCodec && !mp4aCodec) {
        buffer = new VirtualSourceBuffer(this, [avcCodec]);
      } else {
        buffer = new VirtualSourceBuffer(this, [avcCodec, mp4aCodec]);
      }
    } else {
      // delegate to the native implementation
      buffer = this.mediaSource_.addSourceBuffer(type);
    }

    // For combined audio/video tracks, we can only determine if a source buffer is
    // active after a completed update (once it has/doesn't have videoTracks).
    // Once https://github.com/videojs/video.js/issues/2981 is resolved, switch to using
    // buffer.one instead of buffer.on.
    //buffer.on('updateend', this.updateActiveSourceBuffers_.bind(this));

    this.sourceBuffers.push(buffer);
    return buffer;
  }

  updateActiveSourceBuffers_() {
    // Retain the reference but empty the array
    this.activeSourceBuffers_.length = 0;

    let combined = 'enable';
    let audioOnly = 'disable';

    // TODO: find a better way to determine which sourcebuffers audio
    // needs to be enabled this method relies on the track with kind 'main'
    // being in the combined sourcebuffer. It is possible for the main track
    // to have no audio and have a seprate track be the main audio
    for (let i = 0; i < this.player_.audioTracks().length; i++) {
      let track = this.player_.audioTracks()[i];
       if (track.enabled && track.kind !== 'main') {
          combined = 'disable';
          audioOnly = 'enable';
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
        sourceBuffer[`${combined}Audio`]();
      } else if (sourceBuffer.videoCodec_ && !sourceBuffer.audioCodec_) {
        // video only
        sourceBuffer.disableAudio();
        audioOnly = 'enable';
      } else if (!sourceBuffer.videoCodec_ && sourceBuffer.audioCodec_) {
        // audio only
        sourceBuffer[`${audioOnly}Audio`]();
      }

      this.activeSourceBuffers_.push(sourceBuffer);
    });
  }
}
