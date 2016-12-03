/**
 * @file flash-source-buffer.js
 */
import window from 'global/window';
import videojs from 'video.js';
import flv from 'mux.js/lib/flv';
import removeCuesFromTrack from './remove-cues-from-track';
import createTextTracksIfNecessary from './create-text-tracks-if-necessary';
import {addTextTrackData} from './add-text-track-data';
import transmuxWorker from './flash-transmuxer-worker';
import work from 'webworkify';
import FlashConstants from './flash-constants';

/**
 * A wrapper around the setTimeout function that uses
 * the flash constant time between ticks value.
 *
 * @param {Function} func the function callback to run
 * @private
 */
const scheduleTick = function(func) {
  // Chrome doesn't invoke requestAnimationFrame callbacks
  // in background tabs, so use setTimeout.
  window.setTimeout(func, FlashConstants.TIME_BETWEEN_CHUNKS);
};

/**
 * Round a number to a specified number of places much like
 * toFixed but return a number instead of a string representation.
 *
 * @param {Number} num A number
 * @param {Number} places The number of decimal places which to
 * round
 * @private
 */
const toDecimalPlaces = function(num, places) {
  if (typeof places !== 'number' || places < 0) {
    places = 0;
  }

  let scale = Math.pow(10, places);

  return Math.round(num * scale) / scale;
};

/**
 * A SourceBuffer implementation for Flash rather than HTML.
 *
 * @link https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
 * @param {Object} mediaSource the flash media source
 * @class FlashSourceBuffer
 * @extends videojs.EventTarget
 */
export default class FlashSourceBuffer extends videojs.EventTarget {
  constructor(mediaSource) {
    super();
    let encodedHeader;

    // Start off using the globally defined value but refine
    // as we append data into flash
    this.chunkSize_ = FlashConstants.BYTES_PER_CHUNK;

    // byte arrays queued to be appended
    this.buffer_ = [];

    // the total number of queued bytes
    this.bufferSize_ = 0;

    // to be able to determine the correct position to seek to, we
    // need to retain information about the mapping between the
    // media timeline and PTS values
    this.basePtsOffset_ = NaN;

    this.mediaSource_ = mediaSource;

    // indicates whether the asynchronous continuation of an operation
    // is still being processed
    // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
    this.updating = false;
    this.timestampOffset_ = 0;

    encodedHeader = window.btoa(
      String.fromCharCode.apply(
        null,
        Array.prototype.slice.call(
          flv.getFlvHeader()
        )
      )
    );

    window.encodedHeaderSuperSecret = function () {
      throw encodedHeader;
    };

    this.mediaSource_.swfObj.vjs_appendBuffer('encodedHeaderSuperSecret');

    // TS to FLV transmuxer
    this.transmuxer_ = work(transmuxWorker);
    this.transmuxer_.postMessage({ action: 'init', options: {} });
    this.transmuxer_.onmessage = (event) => {
      if (event.data.action === 'data') {
        this.receiveBuffer_(event.data.segment);
      }
    };

    this.one('updateend', () => {
      this.mediaSource_.tech_.trigger('loadedmetadata');
    });

    Object.defineProperty(this, 'timestampOffset', {
      get() {
        return this.timestampOffset_;
      },
      set(val) {
        if (typeof val === 'number' && val >= 0) {
          this.timestampOffset_ = val;
          // We have to tell flash to expect a discontinuity
          this.mediaSource_.swfObj.vjs_discontinuity();
          // the media <-> PTS mapping must be re-established after
          // the discontinuity
          this.basePtsOffset_ = NaN;

          this.transmuxer_.postMessage({ action: 'reset' });
        }
      }
    });

    Object.defineProperty(this, 'buffered', {
      get() {
        if (!this.mediaSource_ ||
            !this.mediaSource_.swfObj ||
            !('vjs_getProperty' in this.mediaSource_.swfObj)) {
          return videojs.createTimeRange();
        }

        let buffered = this.mediaSource_.swfObj.vjs_getProperty('buffered');

        if (buffered && buffered.length) {
          buffered[0][0] = toDecimalPlaces(buffered[0][0], 3);
          buffered[0][1] = toDecimalPlaces(buffered[0][1], 3);
        }
        return videojs.createTimeRanges(buffered);
      }
    });

    // On a seek we remove all text track data since flash has no concept
    // of a buffered-range and everything else is reset on seek
    this.mediaSource_.player_.on('seeked', () => {
      removeCuesFromTrack(0, Infinity, this.metadataTrack_);
      removeCuesFromTrack(0, Infinity, this.inbandTextTrack_);
    });
  }

  /**
   * Append bytes to the sourcebuffers buffer, in this case we
   * have to append it to swf object.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/appendBuffer
   * @param {Array} bytes
   */
  appendBuffer(bytes) {
    let error;

    if (this.updating) {
      error = new Error('SourceBuffer.append() cannot be called ' +
                        'while an update is in progress');
      error.name = 'InvalidStateError';
      error.code = 11;
      throw error;
    }
    this.updating = true;
    this.mediaSource_.readyState = 'open';
    this.trigger({ type: 'update' });

    this.transmuxer_.postMessage({
      action: 'push',
      data: bytes.buffer,
      byteOffset: bytes.byteOffset,
      byteLength: bytes.byteLength
    }, [bytes.buffer]);
    this.transmuxer_.postMessage({action: 'flush'});
  }

  /**
   * Reset the parser and remove any data queued to be sent to the SWF.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/abort
   */
  abort() {
    this.buffer_ = [];
    this.bufferSize_ = 0;
    this.mediaSource_.swfObj.vjs_abort();

    // report any outstanding updates have ended
    if (this.updating) {
      this.updating = false;
      this.trigger({ type: 'updateend' });
    }
  }

  /**
   * Flash cannot remove ranges already buffered in the NetStream
   * but seeking clears the buffer entirely. For most purposes,
   * having this operation act as a no-op is acceptable.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/remove
   * @param {Double} start start of the section to remove
   * @param {Double} end end of the section to remove
   */
  remove(start, end) {
    removeCuesFromTrack(start, end, this.metadataTrack_);
    removeCuesFromTrack(start, end, this.inbandTextTrack_);
    this.trigger({ type: 'update' });
    this.trigger({ type: 'updateend' });
  }

  /**
   * Receive a buffer from the flv.
   *
   * @param {Object} segment
   * @private
   */
  receiveBuffer_(segment) {
    // create an in-band caption track if one is present in the segment
    createTextTracksIfNecessary(this, this.mediaSource_, segment);
    addTextTrackData(this, segment.captions, segment.metadata);

    // Do this asynchronously since convertTagsToData_ can be time consuming
    scheduleTick(() => {
      let flvBytes = this.convertTagsToData_(segment);

      if (this.buffer_.length === 0) {
        scheduleTick(this.processBuffer_.bind(this));
      }

      if (flvBytes) {
        this.buffer_.push(flvBytes);
        this.bufferSize_ += flvBytes.byteLength;
      }
    });
  }

  /**
   * Append a portion of the current buffer to the SWF.
   *
   * @private
   */
  processBuffer_() {
    let chunkSize = FlashConstants.BYTES_PER_CHUNK;

    if (!this.buffer_.length) {
      if (this.updating !== false) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }
      // do nothing if the buffer is empty
      return;
    }

    // concatenate appends up to the max append size
    let chunk = this.buffer_[0].subarray(0, chunkSize);

    // requeue any bytes that won't make it this round
    if (chunk.byteLength < chunkSize ||
        this.buffer_[0].byteLength === chunkSize) {
      this.buffer_.shift();
    } else {
      this.buffer_[0] = this.buffer_[0].subarray(chunkSize);
    }

    this.bufferSize_ -= chunk.byteLength;

    // base64 encode the bytes
    let binary = [];
    let length = chunk.byteLength;

    for (let i = 0; i < length; i++) {
      binary.push(String.fromCharCode(chunk[i]));
    }
    let b64str = window.btoa(binary.join(''));

    window.throwDataSuperSecret = function () {
      // schedule another append if necessary
      if (this.bufferSize_ !== 0) {
        scheduleTick(this.processBuffer_.bind(this));
      } else {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }

      throw b64str;
    }.bind(this);

    // bypass normal ExternalInterface calls and pass xml directly
    // IE can be slow by default
    this.mediaSource_.swfObj.vjs_appendBuffer('throwDataSuperSecret');
  }

  /**
   * Turns an array of flv tags into a Uint8Array representing the
   * flv data. Also removes any tags that are before the current
   * time so that playback begins at or slightly after the right
   * place on a seek
   *
   * @private
   * @param {Object} segmentData object of segment data
   */
  convertTagsToData_(segmentData) {
    let segmentByteLength = 0;
    let tech = this.mediaSource_.tech_;
    let targetPts = 0;
    let i;
    let j;
    let segment;
    let filteredTags = [];
    let tags = segmentData.tags;

    // Establish the media timeline to PTS translation if we don't
    // have one already
    if (isNaN(this.basePtsOffset_) && tags.length) {
      this.basePtsOffset_ = tags[0].pts;
    }

    // Trim to currentTime if it's ahead of buffered or buffered doesn't exist
    if (tech.seeking()) {
      targetPts = Math.max(targetPts, tech.currentTime() - this.timestampOffset);
    }

    // PTS values are represented in milliseconds
    targetPts *= 1e3;
    targetPts += this.basePtsOffset_;

    // skip tags with a presentation time less than the seek target
    for (i = 0; i < tags.length; i++) {
      if (tags[i].pts >= targetPts) {
        filteredTags.push(tags[i]);
      }
    }

    if (filteredTags.length === 0) {
      return;
    }

    // concatenate the bytes into a single segment
    for (i = 0; i < filteredTags.length; i++) {
      segmentByteLength += filteredTags[i].bytes.byteLength;
    }
    segment = new Uint8Array(segmentByteLength);
    for (i = 0, j = 0; i < filteredTags.length; i++) {
      segment.set(filteredTags[i].bytes, j);
      j += filteredTags[i].bytes.byteLength;
    }

    return segment;
  }
}
