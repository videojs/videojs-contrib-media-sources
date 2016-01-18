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
        return self.duration_;
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

    // the list of virtual and native SourceBuffers created by this
    // MediaSource
    this.sourceBuffers = [];

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
      if (!avcCodec || !avcCodec.length) {
        avcCodec = 'avc1.4d400d';
      }
      if (!mp4aCodec || !mp4aCodec.length) {
        mp4aCodec = 'mp4a.40.2';
      }

      buffer = new VirtualSourceBuffer(this, [avcCodec, mp4aCodec]);
      this.sourceBuffers.push(buffer);
      return buffer;
    }

    // delegate to the native implementation
    buffer = this.mediaSource_.addSourceBuffer(type);
    this.sourceBuffers.push(buffer);
    return buffer;
  }
}

