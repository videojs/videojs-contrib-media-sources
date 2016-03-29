import videojs from 'video.js';
import createTextTracksIfNecessary from './create-text-tracks-if-necessary';
import removeCuesFromTrack from './remove-cues-from-track';
import addTextTrackData from './add-text-track-data';
import work from 'webworkify';
import transmuxWorker from './transmuxer-worker';
import {isAudioCodec, isVideoCodec} from './codec-utils';

export default class VirtualSourceBuffer extends videojs.EventTarget {
  constructor(mediaSource, codecs) {
    super(videojs.EventTarget);
    this.timestampOffset_ = 0;
    this.pendingBuffers_ = [];
    this.bufferUpdating_ = false;
    this.mediaSource_ = mediaSource;
    this.nativeMediaSource = this.mediaSource_.mediaSource_;
    this.codecs_ = codecs;
    this.audioCodec_ = null;
    this.videoCodec_ = null;
    this.audioDisabled_ = false;

    let options = {
      remux: false
    };

    this.codecs_.forEach((codec) => {
      if (isAudioCodec(codec)) {
        this.audioCodec_ = codec;
      } else if (isVideoCodec(codec)) {
        this.videoCodec_ = codec;
      }
    });

    if (!this.videoCodec_) {
      options.aacfile = true;
    }

    // append muxed segments to their respective native buffers as
    // soon as they are available
    this.transmuxer_ = work(transmuxWorker);
    this.transmuxer_.postMessage({action: 'init', options });

    this.transmuxer_.onmessage = (event) => {
      if (event.data.action === 'data') {
        return this.data_(event);
      }

      if (event.data.action === 'done') {
        return this.done_(event);
      }
    };

    this.createRealSourceBuffers();

    // this timestampOffset is a property with the side-effect of resetting
    // baseMediaDecodeTime in the transmuxer on the setter
    Object.defineProperty(this, 'timestampOffset', {
      get() {
        return this.timestampOffset_;
      },
      set(val) {
        if (typeof val === 'number' && val >= 0) {
          this.timestampOffset_ = val;

          // We have to tell the transmuxer to set the baseMediaDecodeTime to
          // the desired timestampOffset for the next segment
          this.transmuxer_.postMessage({
            action: 'setTimestampOffset',
            timestampOffset: val
          });
        }
      }
    });

    // setting the append window affects both source buffers
    Object.defineProperty(this, 'appendWindowStart', {
      get() {
        return (this.videoBuffer_ || this.audioBuffer_).appendWindowStart;
      },
      set(start) {
        if (this.videoBuffer_) {
          this.videoBuffer_.appendWindowStart = start;
        }
        if (this.audioBuffer_) {
          this.audioBuffer_.appendWindowStart = start;
        }
      }
    });

    // this buffer is "updating" if either of its native buffers are
    Object.defineProperty(this, 'updating', {
      get() {
        return this.bufferUpdating_ ||
          (this.audioBuffer_ && this.audioBuffer_.updating) ||
          (this.videoBuffer_ && this.videoBuffer_.updating);
      }
    });

    // the buffered property is the intersection of the buffered
    // ranges of the native source buffers
    Object.defineProperty(this, 'buffered', {
      get() {
        let start = null;
        let end = null;
        let arity = 0;
        let extents = [];
        let ranges = [];

        if (!this.videoBuffer_ && (this.audioDisabled_ || !this.audioBuffer_)) {
          return videojs.createTimeRange();
        }

        // Handle the case where we only have one buffer
        if (!this.videoBuffer_) {
          return this.audioBuffer_.buffered;
        } else if (this.audioDisabled_ || !this.audioBuffer_) {
          return this.videoBuffer_.buffered;
        }

        // Handle the case where there is no buffer data
        if ((!this.videoBuffer_ || this.videoBuffer_.buffered.length === 0) &&
            (!this.audioBuffer_ || this.audioBuffer_.buffered.length === 0)) {
          return videojs.createTimeRange();
        }

        // Handle the case where we have both buffers and create an
        // intersection of the two
        let videoBuffered = this.videoBuffer_.buffered;
        let audioBuffered = this.audioBuffer_.buffered;
        let count = videoBuffered.length;

        // A) Gather up all start and end times
        while (count--) {
          extents.push({time: videoBuffered.start(count), type: 'start'});
          extents.push({time: videoBuffered.end(count), type: 'end'});
        }
        count = audioBuffered.length;
        while (count--) {
          extents.push({time: audioBuffered.start(count), type: 'start'});
          extents.push({time: audioBuffered.end(count), type: 'end'});
        }
        // B) Sort them by time
        extents.sort(function(a, b) {
          return a.time - b.time;
        });

        // C) Go along one by one incrementing arity for start and decrementing
        //    arity for ends
        for (count = 0; count < extents.length; count++) {
          if (extents[count].type === 'start') {
            arity++;

            // D) If arity is ever incremented to 2 we are entering an
            //    overlapping range
            if (arity === 2) {
              start = extents[count].time;
            }
          } else if (extents[count].type === 'end') {
            arity--;

            // E) If arity is ever decremented to 1 we leaving an
            //    overlapping range
            if (arity === 1) {
              end = extents[count].time;
            }
          }

          // F) Record overlapping ranges
          if (start !== null && end !== null) {
            ranges.push([start, end]);
            start = null;
            end = null;
          }
        }

        return videojs.createTimeRanges(ranges);
      }
    });
  }

  // Transmuxer message handlers
  data_(event) {
    let segment = event.data.segment;

    // Cast ArrayBuffer to TypedArray
    segment.data = new Uint8Array(
      segment.data,
      event.data.byteOffset,
      event.data.byteLength
    );

    createTextTracksIfNecessary(this, this.mediaSource_, segment);

    // Add the segments to the pendingBuffers array
    this.pendingBuffers_.push(segment);
    return;
  }
  done_() {
    // All buffers should have been flushed from the muxer
    // start processing anything we have received
    this.processPendingSegments_();
    return;
  }

  createRealSourceBuffers() {
    let types = ['audio', 'video'];

    types.forEach((type) => {
      if (!this[`${type}Codec_`]) {
        return;
      }
      // if the mediasource already has a buffer for the codec
      // use that
      if (this.mediaSource_[`${type}Buffer_`]) {
        this[`${type}Buffer_`] = this.mediaSource_[`${type}Buffer_`];
        return;
      }
      let buffer = this.nativeMediaSource.addSourceBuffer(
        type + '/mp4;codecs="' + this[`${type}Codec_`] + '"'
      );

      this.mediaSource_[`${type}Buffer_`] = buffer;
      this[`${type}Buffer_`] = buffer;
      // we only add audio event handlers here if we also have
      // a videoCodec. we will add seprate event handlers
      // for audio only after this block of code
      if (!this.videoCodec_) {
        return;
      }
      ['update', 'updatestart', 'updateend'].forEach((event) => {
        buffer.addEventListener(event, () => {
          // if audio is disabled
          if (type === 'audio' && !this.audioDisabled_) {
            return;
          }
          for (let t in types) {
            // if the other type if updating we don't trigger
            if (type !== t && this[`${t}Buffer_`] && this[`${t}Buffer_`].updating) {
              return;
            }
          }
          return this.trigger(event);
        });
      });
    });

    // if we onlt have an audioCodec_
    if (this.audioCodec_ && !this.videoCodec_) {
      ['updatestart', 'update', 'updateend'].forEach((event) => {
        this.audioBuffer_.addEventListener(event, () => {
          if (!this.audioDisabled_) {
            this.trigger(event);
          }
        });
      });
    }
  }

  // SourceBuffer Implementation
  appendBuffer(segment) {
    // Start the internal "updating" state
    this.bufferUpdating_ = true;

    this.transmuxer_.postMessage({
      action: 'push',
      // Send the typed-array of data as an ArrayBuffer so that
      // it can be sent as a "Transferable" and avoid the costly
      // memory copy
      data: segment.buffer,

      // To recreate the original typed-array, we need information
      // about what portion of the ArrayBuffer it was a view into
      byteOffset: segment.byteOffset,
      byteLength: segment.byteLength
    },
    [segment.buffer]);
    this.transmuxer_.postMessage({action: 'flush'});
  }
  remove(start, end) {
    if (this.videoBuffer_) {
      this.videoBuffer_.remove(start, end);
    }
    if (this.audioBuffer_) {
      this.audioBuffer_.remove(start, end);
    }

    // Remove Metadata Cues (id3)
    removeCuesFromTrack(start, end, this.metadataTrack_);

    // Remove Any Captions
    removeCuesFromTrack(start, end, this.inbandTextTrack_);
  }

  /**
    * Process any segments that the muxer has output
    * Concatenate segments together based on type and append them into
    * their respective sourceBuffers
    */
  processPendingSegments_() {
    let sortedSegments = {
      video: {
        segments: [],
        bytes: 0
      },
      audio: {
        segments: [],
        bytes: 0
      },
      captions: [],
      metadata: []
    };

    // Sort segments into separate video/audio arrays and
    // keep track of their total byte lengths
    sortedSegments = this.pendingBuffers_.reduce(function(segmentObj, segment) {
      let type = segment.type;
      let data = segment.data;

      segmentObj[type].segments.push(data);
      segmentObj[type].bytes += data.byteLength;

      // Gather any captions into a single array
      if (segment.captions) {
        segmentObj.captions = segmentObj.captions.concat(segment.captions);
      }

      // Gather any metadata into a single array
      if (segment.metadata) {
        segmentObj.metadata = segmentObj.metadata.concat(segment.metadata);
      }

      return segmentObj;
    }, sortedSegments);

    // Merge multiple video and audio segments into one and append
    if (this.videoBuffer_) {
      this.concatAndAppendSegments_(sortedSegments.video, this.videoBuffer_);
      // TODO: are video tracks the only ones with text tracks?
      addTextTrackData(this, sortedSegments.captions, sortedSegments.metadata);
    }
    if (!this.audioDisabled_ && this.audioBuffer_) {
      this.concatAndAppendSegments_(sortedSegments.audio, this.audioBuffer_);
    }

    this.pendingBuffers_.length = 0;

    // We are no longer in the internal "updating" state
    this.bufferUpdating_ = false;
  }
  /**
    * Combind all segments into a single Uint8Array and then append them
    * to the destination buffer
    */
  concatAndAppendSegments_(segmentObj, destinationBuffer) {
    let offset = 0;
    let tempBuffer;

    if (segmentObj.bytes) {
      tempBuffer = new Uint8Array(segmentObj.bytes);

      // Combine the individual segments into one large typed-array
      segmentObj.segments.forEach(function(segment) {
        tempBuffer.set(segment, offset);
        offset += segment.byteLength;
      });

      destinationBuffer.appendBuffer(tempBuffer);
    }
  }
  // abort any sourceBuffer actions and throw out any un-appended data
  abort() {
    if (this.videoBuffer_) {
      this.videoBuffer_.abort();
    }
    if (this.audioBuffer_) {
      this.audioBuffer_.abort();
    }
    if (this.transmuxer_) {
      this.transmuxer_.postMessage({action: 'reset'});
    }
    this.pendingBuffers_.length = 0;
    this.bufferUpdating_ = false;
  }

  disableAudio() {
    this.audioDisabled_ = true;
  }

  enableAudio() {
    this.audioDisabled_ = false;
  }
}
