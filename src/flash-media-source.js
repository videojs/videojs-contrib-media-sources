import videojs from 'video.js';
import FlashSourceBuffer from './flash-source-buffer';
import FlashConstants from './flash-constants';

export default class FlashMediaSource extends videojs.EventTarget {
  constructor() {
    super(videojs.EventTarget);
    /* eslint-disable consistent-this */
    let self = this;
    /* eslint-enable consistent-this */

    this.sourceBuffers = [];
    this.readyState = 'closed';

    this.on(['sourceopen', 'webkitsourceopen'], function(event) {
      // find the swf where we will push media data
      this.swfObj = document.getElementById(event.swfId);
      this.player_ = videojs(this.swfObj.parentNode);
      this.tech_ = this.swfObj.tech;
      this.readyState = 'open';

      this.tech_.on('seeking', function() {
        let i = self.sourceBuffers.length;

        while (i--) {
          self.sourceBuffers[i].abort();
        }
      });

      // trigger load events
      if (this.swfObj) {
        this.swfObj.vjs_load();
      }
    });
  }

  addSeekableRange_() {
    // intentional no-op
  }

  // create a new source buffer to receive a type of media data
  addSourceBuffer(type) {
    let sourceBuffer;

    // if this is an FLV type, we'll push data to flash
    if (type.indexOf('video/mp2t') === 0) {
      // Flash source buffers
      sourceBuffer = new FlashSourceBuffer(this);
    } else {
      throw new Error('NotSupportedError (Video.js)');
    }

    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  /* eslint-disable max-len */
  /**
    * Signals the end of the stream.
    * @param error {string} (optional) Signals that a playback error
    * has occurred. If specified, it must be either "network" or
    * "decode".
    * @see https://w3c.github.io/media-source/#widl-MediaSource-endOfStream-void-EndOfStreamError-error
    */
  /* eslint-enable max-len */
  endOfStream(error) {
    if (error === 'network') {
      // MEDIA_ERR_NETWORK
      this.tech_.error(2);
    } else if (error === 'decode') {
      // MEDIA_ERR_DECODE
      this.tech_.error(3);
    }
    if (this.readyState !== 'ended') {
      this.readyState = 'ended';
      this.swfObj.vjs_endOfStream();
    }
  }

}

/**
  * Set or return the presentation duration.
  * @param value {double} the duration of the media in seconds
  * @param {double} the current presentation duration
  * @see http://www.w3.org/TR/media-source/#widl-MediaSource-duration
  */
try {
  Object.defineProperty(FlashMediaSource.prototype, 'duration', {
    get() {
      if (!this.swfObj) {
        return NaN;
      }
      // get the current duration from the SWF
      return this.swfObj.vjs_getProperty('duration');
    },
    set(value) {
      let i;
      let oldDuration = this.swfObj.vjs_getProperty('duration');

      this.swfObj.vjs_setProperty('duration', value);

      if (value < oldDuration) {
        // In MSE, this triggers the range removal algorithm which causes
        // an update to occur
        for (i = 0; i < this.sourceBuffers.length; i++) {
          this.sourceBuffers[i].remove(value, oldDuration);
        }
      }

      return value;
    }
  });
} catch (e) {
  // IE8 throws if defineProperty is called on a non-DOM node. We
  // don't support IE8 but we shouldn't throw an error if loaded
  // there.
  FlashMediaSource.prototype.duration = NaN;
}

for (let property in FlashConstants) {
  FlashMediaSource[property] = FlashConstants[property];
}

