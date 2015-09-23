(function(window, muxjs, undefined){
  'use strict';
  var urlCount = 0,
      EventTarget = videojs.EventTarget,
      defaults,
      VirtualSourceBuffer,
      flvCodec = /video\/flv(;\s*codecs=["']vp6,aac["'])?$/,
      objectUrlPrefix = 'blob:vjs-media-source/',
      interceptBufferCreation,
      addSourceBuffer,
      aggregateUpdateHandler,
      scheduleTick;

  // ------------
  // Media Source
  // ------------

  defaults = {
    // how to determine the MediaSource implementation to use. There
    // are three available modes:
    // - auto: use native MediaSources where available and Flash
    //   everywhere else
    // - html5: always use native MediaSources
    // - flash: always use the Flash MediaSource polyfill
    mode: 'auto'
  };

  videojs.MediaSource = videojs.extend(EventTarget, {
    constructor: function(options){
      var self;

      this.settings_ = videojs.mergeOptions(defaults, options);

      // determine whether native MediaSources should be used
      if ((this.settings_.mode === 'auto' &&
           videojs.MediaSource.supportsNativeMediaSources()) ||
          this.settings_.mode === 'html5') {
        self = new window.MediaSource();
        interceptBufferCreation(self);

        // capture the associated player when the MediaSource is
        // successfully attached
        self.addEventListener('sourceopen', function() {
          var video = document.querySelector('[src="' + self.url_ + '"]');

          if (!video && video.parentNode) {
            return;
          }

          self.player_ = videojs(video.parentNode);
        });
        return self;
      }

      // otherwise, emulate them through the SWF
      return new videojs.FlashMediaSource();
    }
  });
  videojs.MediaSource.supportsNativeMediaSources = function() {
    return !!window.MediaSource;
  };

  // ----
  // HTML
  // ----

  interceptBufferCreation = function(mediaSource) {
    // virtual source buffers will be created as needed to transmux
    // MPEG-2 TS into supported ones
    mediaSource.virtualBuffers = [];

    // intercept calls to addSourceBuffer so video/mp2t can be
    // transmuxed to mp4s
    mediaSource.addSourceBuffer_ = mediaSource.addSourceBuffer;
    mediaSource.addSourceBuffer = addSourceBuffer;
  };

  addSourceBuffer = function(type) {
    var audio, video, buffer, codecs;
    // create a virtual source buffer to transmux MPEG-2 transport
    // stream segments into fragmented MP4s
    if ((/^video\/mp2t/i).test(type)) {
      codecs = type.split(';').slice(1).join(';');
      buffer = new VirtualSourceBuffer(this, codecs);
      this.virtualBuffers.push(buffer);
      return buffer;
    }

    // delegate to the native implementation
    return this.addSourceBuffer_(type);
  };

  aggregateUpdateHandler = function(mediaSource, guardBufferName, type) {
    return function() {
      if (!mediaSource[guardBufferName] || !mediaSource[guardBufferName].updating) {
        return mediaSource.trigger(type);
      }
    };
  };

  VirtualSourceBuffer = videojs.extend(EventTarget, {
    constructor: function VirtualSourceBuffer(mediaSource, codecs) {
      var self = this;

      this.timestampOffset_ = 0;
      this.timestampOffsetChanged_ = false;
      this.pendingBuffers_ = [];
      this.bufferUpdating_ = false;

      // append muxed segments to their respective native buffers as
      // soon as they are available
      this.transmuxer_ = new Worker(videojs.MediaSource.webWorkerURI || '/src/transmuxer_worker.js');

      this.transmuxer_.onmessage = function (event) {
        if (event.data.action === 'data') {
          var segment = event.data.segment;

          // Cast to type
          segment.data = new Uint8Array(segment.data);

          // If any sourceBuffers have not been created, do so now
          if (segment.type === 'video') {
            if (!self.videoBuffer_) {
              // Some common mp4 codec strings. Saved for future twittling:
              // 4d400d
              // 42c01e & 42c01f
              self.videoBuffer_ = mediaSource.addSourceBuffer_('video/mp4;' + (codecs || 'codecs=avc1.4d400d'));
              // aggregate buffer events
              self.videoBuffer_.addEventListener('updatestart',
                                                 aggregateUpdateHandler(self, 'audioBuffer_', 'updatestart'));
              self.videoBuffer_.addEventListener('update',
                                                 aggregateUpdateHandler(self, 'audioBuffer_', 'update'));
              self.videoBuffer_.addEventListener('updateend',
                                                 aggregateUpdateHandler(self, 'audioBuffer_', 'updateend'));
            }
          } else if (segment.type === 'audio') {
            if (!self.audioBuffer_) {
              self.audioBuffer_ = mediaSource.addSourceBuffer_('audio/mp4;' + (codecs || 'codecs=mp4a.40.2'));
              // aggregate buffer events
              self.audioBuffer_.addEventListener('updatestart',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updatestart'));
              self.audioBuffer_.addEventListener('update',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'update'));
              self.audioBuffer_.addEventListener('updateend',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updateend'));
            }
          } else if (segment.type === 'combined') {
            if (!self.videoBuffer_) {
              self.videoBuffer_ = mediaSource.addSourceBuffer_('video/mp4;' + (codecs || 'codecs=avc1.4d400d, mp4a.40.2'));
              // aggregate buffer events
              self.videoBuffer_.addEventListener('updatestart',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updatestart'));
              self.videoBuffer_.addEventListener('update',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'update'));
              self.videoBuffer_.addEventListener('updateend',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updateend'));
            }
          }

          // create an in-band caption track if one is present in the segment
          if (segment.captions &&
              segment.captions.length &&
              !self.inbandTextTrack_) {
            self.inbandTextTrack_ = mediaSource.player_.addTextTrack('captions');
          }

          // Add the segments to the pendingBuffers array
          self.pendingBuffers_.push(segment);
          return;
        }

        if (event.data.action === 'done') {
          // All buffers should have been flushed from the muxer
          // start processing anything we have received
          self.processPendingSegments_();

          return;
        }
      };

      // this timestampOffset is a property with the side-effect of resetting
      // baseMediaDecodeTime in the transmuxer on the setter
      Object.defineProperty(this, 'timestampOffset', {
        get: function() {
          return this.timestampOffset_;
        },
        set: function(val) {
          if (typeof val === 'number' && val >= 0) {
            this.timestampOffsetChanged_ = true;
            this.timestampOffset_ = val;
            // We have to tell the transmuxer to reset the baseMediaDecodeTime to
            // zero for the next segment
            this.transmuxer_.postMessage({action: 'resetTransmuxer'});
          }
        }
      });
      // this buffer is "updating" if either of its native buffers are
      Object.defineProperty(this, 'updating', {
        get: function() {
          return this.bufferUpdating_ ||
            (this.audioBuffer_ && this.audioBuffer_.updating) ||
            (this.videoBuffer_ && this.videoBuffer_.updating);
        }
      });
      // the buffered property is the intersection of the buffered
      // ranges of the native source buffers
      Object.defineProperty(this, 'buffered', {
        get: function() {
          var
            start = null,
            end = null,
            arity = 0,
            extents = [],
            ranges = [];

          // Handle the case where there is no buffer data
          if ((!this.videoBuffer_ || this.videoBuffer_.buffered.length === 0) &&
              (!this.audioBuffer_ || this.audioBuffer_.buffered.length === 0)) {
            return videojs.createTimeRange();
          }

          // Handle the case where we only have one buffer
          if (!this.videoBuffer_) {
            return this.audioBuffer_.buffered;
          } else if (!this.audioBuffer_) {
            return this.audioBuffer_.buffered;
          }

          // Handle the case where we have both buffers and create an
          // intersection of the two
          var videoIndex = 0, audioIndex = 0;
          var videoBuffered = this.videoBuffer_.buffered;
          var audioBuffered = this.audioBuffer_.buffered;
          var count = videoBuffered.length;

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
          extents.sort(function(a, b){return a.time - b.time;});

          // C) Go along one by one incrementing arity for start and decrementing
          //    arity for ends
          for(count = 0; count < extents.length; count++) {
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
    },
    appendBuffer: function(segment) {
      // Start the internal "updating" state
      this.bufferUpdating_ = true;

      this.transmuxer_.postMessage({action: 'push', data: segment.buffer}, [segment.buffer]);
      this.transmuxer_.postMessage({action: 'flush'});
    },
    remove: function(start, end) {
      if (this.videoBuffer_) {
        this.videoBuffer_.remove(start, end);
      }
      if (this.audioBuffer_) {
        this.audioBuffer_.remove(start, end);
      }
      // TODO: Remove TextTracks and Cues
    },
    /**
     * Process any segments that the muxer has output
     * Concatenate segments together based on type and append them into
     * their respective sourceBuffers
     */
    processPendingSegments_: function() {
      var sortedSegments = {
          video: {
            segments: [],
            captions: [],
            bytes: 0
          },
          audio: {
            segments: [],
            captions: [],
            bytes: 0
          }
        };

      // Sort segments into separate video/audio arrays and
      // keep track of their total byte lengths
      sortedSegments = this.pendingBuffers_.reduce(function (segmentObj, segment) {
        var
          type = segment.type,
          data = segment.data;

        // A "combined" segment type (unified video/audio) uses the videoBuffer
        if (type === 'combined') {
          type = 'video';
        }

        segmentObj[type].segments.push(data);
        segmentObj[type].bytes += data.byteLength;

        // append any captions in this segment
        if (segment.captions) {
          segmentObj[type].captions = segmentObj[type].captions.concat(segment.captions);
        }

        return segmentObj;
      }, sortedSegments);

      // add cues for any video captions encountered
      sortedSegments.video.captions.forEach(function(cue) {
        this.inbandTextTrack_.addCue(
          new VTTCue(
            cue.startTime + this.timestampOffset_,
            cue.endTime + this.timestampOffset_,
            cue.text
          ));
      }.bind(this));

      // Merge multiple video and audio segments into one and append
      this.concatAndAppendSegments_(sortedSegments.video, this.videoBuffer_);
      this.concatAndAppendSegments_(sortedSegments.audio, this.audioBuffer_);

      this.pendingBuffers_.length = 0;

      // We are no longer in the internal "updating" state
      this.bufferUpdating_ = false;
      this.timestampOffsetChanged_ = false;
    },
    /**
     * Combind all segments into a single Uint8Array and then append them
     * to the destination buffer
     */
    concatAndAppendSegments_: function(segmentObj, destinationBuffer) {
      var
        offset = 0,
        tempBuffer;

      if (segmentObj.bytes) {
        tempBuffer = new Uint8Array(segmentObj.bytes);

        // Combine the individual segments into one large typed-array
        segmentObj.segments.forEach(function (segment) {
          tempBuffer.set(segment, offset);
          offset += segment.byteLength;
        });

        // Set timestampOffset if it was changed before this append
        if (this.timestampOffsetChanged_) {
          destinationBuffer.timestampOffset = this.timestampOffset_;
        }

        destinationBuffer.appendBuffer(tempBuffer);
      }
    }
  });

  // -----
  // Flash
  // -----

  videojs.FlashMediaSource = videojs.extend(EventTarget, {
    constructor: function(){
      var self = this;
      this.sourceBuffers = [];
      this.readyState = 'closed';

      this.on(['sourceopen', 'webkitsourceopen'], function(event){
        // find the swf where we will push media data
        this.swfObj = document.getElementById(event.swfId);
        this.tech_ = this.swfObj.tech;
        this.readyState = 'open';

        this.tech_.on('seeking', function() {
          self.swfObj.vjs_abort();
        });

        // trigger load events
        if (this.swfObj) {
          this.swfObj.vjs_load();
        }
      });
    }
  });

  /**
   * The maximum size in bytes for append operations to the video.js
   * SWF. Calling through to Flash blocks and can be expensive so
   * tuning this parameter may improve playback on slower
   * systems. There are two factors to consider:
   * - Each interaction with the SWF must be quick or you risk dropping
   * video frames. To maintain 60fps for the rest of the page, each append
   * cannot take longer than 16ms. Given the likelihood that the page will
   * be executing more javascript than just playback, you probably want to
   * aim for ~8ms.
   * - Bigger appends significantly increase throughput. The total number of
   * bytes over time delivered to the SWF must exceed the video bitrate or
   * playback will stall.
   *
   * The default is set so that a 4MB/s stream should playback
   * without stuttering.
   */
  videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 4 * 1024 * 1024;
  videojs.FlashMediaSource.TICKS_PER_SECOND = 60;

  // create a new source buffer to receive a type of media data
  videojs.FlashMediaSource.prototype.addSourceBuffer = function(type){
    var sourceBuffer;

    // if this is an FLV type, we'll push data to flash
    if (type.indexOf('video/mp2t') === 0) {
      // Flash source buffers
      sourceBuffer = new videojs.FlashSourceBuffer(this);
    } else {
      throw new Error('NotSupportedError (Video.js)');
    }

    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  };

  /**
   * Set or return the presentation duration.
   * @param value {double} the duration of the media in seconds
   * @param {double} the current presentation duration
   * @see http://www.w3.org/TR/media-source/#widl-MediaSource-duration
   */
  Object.defineProperty(videojs.FlashMediaSource.prototype, 'duration', {
    get: function(){
      if (!this.swfObj) {
        return NaN;
      }
      // get the current duration from the SWF
      return this.swfObj.vjs_getProperty('duration');
    },
    set: function(value){
      this.swfObj.vjs_setProperty('duration', value);
      return value;
    }
  });

  /**
   * Signals the end of the stream.
   * @param error {string} (optional) Signals that a playback error
   * has occurred. If specified, it must be either "network" or
   * "decode".
   * @see https://w3c.github.io/media-source/#widl-MediaSource-endOfStream-void-EndOfStreamError-error
   */
  videojs.FlashMediaSource.prototype.endOfStream = function(error){
    if (error === 'network') {
      // MEDIA_ERR_NETWORK
      this.tech_.error(2);
    } else if (error === 'decode') {
      // MEDIA_ERR_DECODE
      this.tech_.error(3);
    }
    this.readyState = 'ended';
  };

  // store references to the media sources so they can be connected
  // to a video element (a swf object)
  videojs.mediaSources = {};
  // provide a method for a swf object to notify JS that a media source is now open
  videojs.MediaSource.open = function(msObjectURL, swfId){
    var mediaSource = videojs.mediaSources[msObjectURL];

    if (mediaSource) {
      mediaSource.trigger({
        type: 'sourceopen',
        swfId: swfId
      });
    } else {
      throw new Error('Media Source not found (Video.js)');
    }
  };

  scheduleTick = function(func) {
    // Chrome doesn't invoke requestAnimationFrame callbacks
    // in background tabs, so use setTimeout.
    window.setTimeout(func,
                      Math.ceil(1000 / videojs.FlashMediaSource.TICKS_PER_SECOND));
  };

  // Source Buffer
  videojs.FlashSourceBuffer = videojs.extend(EventTarget, {

    constructor: function(source){
      var encodedHeader;

      // byte arrays queued to be appended
      this.buffer_ = [];

      // the total number of queued bytes
      this.bufferSize_ =  0;

      this.source = source;

      // indicates whether the asynchronous continuation of an operation
      // is still being processed
      // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
      this.updating = false;
      this.timestampOffset_ = 0;

      // TS to FLV transmuxer
      this.segmentParser_ = new muxjs.SegmentParser();
      encodedHeader = window.btoa(String.fromCharCode.apply(null, Array.prototype.slice.call(this.segmentParser_.getFlvHeader())));
      this.source.swfObj.vjs_appendBuffer(encodedHeader);

      Object.defineProperty(this, 'timestampOffset', {
        get: function() {
          return this.timestampOffset_;
        },
        set: function(val) {
          if (typeof val === 'number' && val >= 0) {
            this.timestampOffset_ = val;
            // We have to tell flash to expect a discontinuity
            this.source.swfObj.vjs_discontinuity();
          }
        }
      });

      Object.defineProperty(this, 'buffered', {
        get: function() {
          return videojs.createTimeRange(0, this.source.swfObj.vjs_getProperty('buffered'));
        }
      });
    },

    // accept video data and pass to the video (swf) object
    appendBuffer: function(uint8Array){
      var error, flvBytes, ptsTarget;

      if (this.updating) {
        error = new Error('SourceBuffer.append() cannot be called ' +
                          'while an update is in progress');
        error.name = 'InvalidStateError';
        error.code = 11;
        throw error;
      }
      if (this.buffer_.length === 0) {
        scheduleTick(this.processBuffer_.bind(this));
      }

      this.updating = true;
      this.source.readyState = 'open';
      this.trigger({ type: 'update' });

      flvBytes = this.tsToFlv_(uint8Array);
      this.buffer_.push(flvBytes);
      this.bufferSize_ += flvBytes.byteLength;
    },

    // reset the parser and remove any data queued to be sent to the swf
    abort: function() {
      this.buffer_ = [];
      this.bufferSize_ = 0;
      this.source.swfObj.vjs_abort();

      // report any outstanding updates have ended
      if (this.updating) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }

    },

    // append a portion of the current buffer to the SWF
    processBuffer_: function() {
      var chunk, i, length, payload, maxSize, binary, b64str;

      if (!this.buffer_.length) {
        // do nothing if the buffer is empty
        return;
      }

      if (document.hidden) {
        // When the document is hidden, the browser will likely
        // invoke callbacks less frequently than we want. Just
        // append a whole second's worth of data. It doesn't
        // matter if the video janks, since the user can't see it.
        maxSize = videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL;
      } else {
        maxSize = Math.ceil(videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL/
                            videojs.FlashMediaSource.TICKS_PER_SECOND);
      }

      // concatenate appends up to the max append size
      payload = new Uint8Array(Math.min(maxSize, this.bufferSize_));
      i = payload.byteLength;
      while (i) {
        chunk = this.buffer_[0].subarray(0, i);

        payload.set(chunk, payload.byteLength - i);

        // requeue any bytes that won't make it this round
        if (chunk.byteLength < this.buffer_[0].byteLength) {
          this.buffer_[0] = this.buffer_[0].subarray(i);
        } else {
          this.buffer_.shift();
        }

        i -= chunk.byteLength;
      }
      this.bufferSize_ -= payload.byteLength;

      // base64 encode the bytes
      binary = '';
      length = payload.byteLength;
      for (i = 0; i < length; i++) {
        binary += String.fromCharCode(payload[i]);
      }
      b64str = window.btoa(binary);

      // bypass normal ExternalInterface calls and pass xml directly
      // IE can be slow by default
      this.source.swfObj.CallFunction('<invoke name="vjs_appendBuffer"' +
                                      'returntype="javascript"><arguments><string>' +
                                      b64str +
                                      '</string></arguments></invoke>');

      // schedule another append if necessary
      if (this.bufferSize_ !== 0) {
        scheduleTick(this.processBuffer_.bind(this));
      } else {
        this.updating = false;
        this.trigger({ type: 'updateend' });

        if (this.source.readyState === 'ended') {
          this.source.swfObj.vjs_endOfStream();
        }
      }
    },

    // transmux segment data from MP2T to FLV
    tsToFlv_: function(bytes) {
      var segmentByteLength = 0, tags = [],
          tech = this.source.tech_,
          start, i, j, segment, targetPts;

      // transmux the TS to FLV
      this.segmentParser_.parseSegmentBinaryData(bytes);
      this.segmentParser_.flushTags();

      // assemble the FLV tags in decoder order
      while (this.segmentParser_.tagsAvailable()) {
        tags.push(this.segmentParser_.getNextTag());
      }

      // if the player is seeking, determine the PTS value for the
      // target media timeline position
      if (tech.seeking()) {
        targetPts = tech.currentTime() - this.timestampOffset;
        targetPts *= 1e3; // PTS values are represented in milliseconds
        targetPts += tags[0].pts;
      }

      // skip tags less than the seek target
      for (start = 0;
           start < tags.length && tags[start].pts < targetPts;
           start++) {
      }
      // concatenate the bytes into a single segment
      for (i = start; i < tags.length; i++) {
        segmentByteLength += tags[i].bytes.byteLength;
      }
      segment = new Uint8Array(segmentByteLength);
      for (i = start, j = 0; i < tags.length; i++) {
        segment.set(tags[i].bytes, j);
        j += tags[i].bytes.byteLength;
      }
      return segment;
    }
  });

  // URL
  videojs.URL = {
    createObjectURL: function(object){
      var url;

      // if the object isn't an emulated MediaSource, delegate to the
      // native implementation
      if (!(object instanceof videojs.FlashMediaSource)) {
        url = window.URL.createObjectURL(object);
        object.url_ = url;
        return url;
      }

      // build a URL that can be used to map back to the emulated
      // MediaSource
      url = objectUrlPrefix + urlCount;

      urlCount++;

      // setup the mapping back to object
      videojs.mediaSources[url] = object;

      return url;
    }
  };

})(this, this.muxjs);
