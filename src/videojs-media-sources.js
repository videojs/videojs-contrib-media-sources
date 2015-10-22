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
      scheduleTick,
      Cue,
      deprecateOldCue,
      removeCuesFromTrack,
      createTextTracksIfNecessary,
      addTextTrackData;

Cue = window.WebKitDataCue || window.VTTCue;

deprecateOldCue = function(cue) {
  Object.defineProperties(cue.frame, {
    'id': {
      get: function() {
        videojs.log.warn('cue.frame.id is deprecated. Use cue.value.key instead.');
        return cue.value.key;
      }
    },
    'value': {
      get: function() {
        videojs.log.warn('cue.frame.value is deprecated. Use cue.value.data instead.');
        return cue.value.data;
      }
    },
    'privateData': {
      get: function() {
        videojs.log.warn('cue.frame.privateData is deprecated. Use cue.value.data instead.');
        return cue.value.data;
      }
    }
  });
};

removeCuesFromTrack = function(start, end, track) {
  var i, cue;

  if (!track) {
    return;
  }

  i = track.cues.length;

  while(i--) {
    cue = track.cues[i];

    // Remove any overlapping cue
    if (cue.startTime <= end && cue.endTime >= start) {
      track.removeCue(cue);
    }
  }
};

createTextTracksIfNecessary = function (sourceHandler, mediaSource, segment) {
  // create an in-band caption track if one is present in the segment
  if (segment.captions &&
      segment.captions.length &&
      !sourceHandler.inbandTextTrack_) {
    sourceHandler.inbandTextTrack_ = mediaSource.player_.addTextTrack('captions');
  }

  if (segment.metadata &&
      segment.metadata.length &&
      !sourceHandler.metadataTrack_) {
    sourceHandler.metadataTrack_ = mediaSource.player_.addTextTrack('metadata', 'Timed Metadata');
    sourceHandler.metadataTrack_.inBandMetadataTrackDispatchType = segment.metadata.dispatchType;
  }
};

addTextTrackData = function (sourceHandler, captionArray, metadataArray) {
  if (captionArray) {
    captionArray.forEach(function (caption) {
      this.inbandTextTrack_.addCue(
        new VTTCue(
          caption.startTime + this.timestampOffset,
          caption.endTime + this.timestampOffset,
          caption.text
        ));
    }, sourceHandler);
  }

  if (metadataArray) {
    metadataArray.forEach(function(metadata) {
      var time = metadata.cueTime + this.timestampOffset;

      metadata.frames.forEach(function(frame) {
        var cue = new Cue(
            time,
            time,
            frame.value || frame.url || frame.data || '');

        cue.frame = frame;
        cue.value = frame;
        deprecateOldCue(cue);
        this.metadataTrack_.addCue(cue);
      }, this);
    }, sourceHandler);
  }
};

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

      // Replace the old apple-style `avc1.<dd>.<dd>` codec string with the standard
      // `avc1.<hhhhhh>`
      codecs = codecs.replace(/avc1\.(\d+)\.(\d+)/i, function(orig, profile, avcLevel) {
        var
          profileHex = ('00' + Number(profile).toString(16)).slice(-2),
          avcLevelHex = ('00' + Number(avcLevel).toString(16)).slice(-2);

        return 'avc1.' + profileHex + '00' + avcLevelHex;
      });

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
              self.videoBuffer_.timestampOffset = self.timestampOffset_;
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
              self.audioBuffer_.timestampOffset = self.timestampOffset_;
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
              self.videoBuffer_.timestampOffset = self.timestampOffset_;
              // aggregate buffer events
              self.videoBuffer_.addEventListener('updatestart',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updatestart'));
              self.videoBuffer_.addEventListener('update',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'update'));
              self.videoBuffer_.addEventListener('updateend',
                                                 aggregateUpdateHandler(self, 'videoBuffer_', 'updateend'));
            }
          }
          createTextTracksIfNecessary(self, mediaSource, segment);

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
            this.timestampOffset_ = val;

            if (this.videoBuffer_) {
              this.videoBuffer_.timestampOffset = val;
            }
            if (this.audioBuffer_) {
              this.audioBuffer_.timestampOffset = val;
            }

            // We have to tell the transmuxer to reset the baseMediaDecodeTime to
            // zero for the next segment
            this.transmuxer_.postMessage({action: 'resetTransmuxer'});
          }
        }
      });
      // setting the append window affects both source buffers
      Object.defineProperty(this, 'appendWindowStart', {
        get: function() {
          return (this.videoBuffer_ || this.audioBuffer_).appendWindowStart;
        },
        set: function(start) {
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
            return this.videoBuffer_.buffered;
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

      // Remove Metadata Cues (id3)
      removeCuesFromTrack(start, end, this.metadataTrack_);

      // Remove Any Captions
      removeCuesFromTrack(start, end, this.inbandTextTrack_);
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

      addTextTrackData(this, sortedSegments.captions, sortedSegments.metadata);

      // Merge multiple video and audio segments into one and append
      this.concatAndAppendSegments_(sortedSegments.video, this.videoBuffer_);
      this.concatAndAppendSegments_(sortedSegments.audio, this.audioBuffer_);

      this.pendingBuffers_.length = 0;

      // We are no longer in the internal "updating" state
      this.bufferUpdating_ = false;
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

        destinationBuffer.appendBuffer(tempBuffer);
      }
    },
    // abort any sourceBuffer actions and throw out any un-appended data
    abort: function() {
      if (this.videoBuffer_) {
        this.videoBuffer_.abort();
      }
      if (this.audioBuffer_) {
        this.audioBuffer_.abort();
      }
      if (this.transmuxer_) {
        this.transmuxer_.postMessage({action: 'resetTransmuxer'});
      }
      this.pendingBuffers_.length = 0;
      this.bufferUpdating_ = false;
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
        this.player_ = videojs(this.swfObj.parentNode);
        this.tech_ = this.swfObj.tech;
        this.readyState = 'open';

        this.tech_.on('seeking', function() {
          var i = self.sourceBuffers.length;
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
  });

  /**
   * The maximum size in bytes for append operations to the video.js
   * SWF. Calling through to Flash blocks and can be expensive so
   * tuning this parameter may improve playback on slower
   * systems. There are two factors to consider:
   * - Each interaction with the SWF must be quick or you risk dropping
   * video frames. To maintain 60fps for the rest of the page, each append
   * must not  take longer than 16ms. Given the likelihood that the page
   * will be executing more javascript than just playback, you probably
   * want to aim for less than 8ms. We aim for just 4ms.
   * - Bigger appends significantly increase throughput. The total number of
   * bytes over time delivered to the SWF must exceed the video bitrate or
   * playback will stall.
   *
   * We adaptively tune the size of appends to give the best throughput
   * possible given the performance of the system. To do that we try to append
   * as much as possible in TIME_PER_TICK and while tuning the size of appends
   * dynamically so that we only append about 4-times in that 4ms span.
   *
   * The reason we try to keep the number of appends around four is due to
   * externalities such as Flash load and garbage collection that are highly
   * variable and having 4 iterations allows us to exit the loop early if
   * an iteration takes longer than expected.
   */

  videojs.FlashMediaSource.TIME_BETWEEN_TICKS = Math.floor(1000 / 480);
  videojs.FlashMediaSource.TIME_PER_TICK = Math.floor(1000 / 240);
  videojs.FlashMediaSource.BYTES_PER_CHUNK = 1 * 1024; // 1kb
  videojs.FlashMediaSource.MIN_CHUNK = 1024;
  videojs.FlashMediaSource.MAX_CHUNK = 1024 * 1024;

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
  try {
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
  } catch (e) {
    // IE8 throws if defineProperty is called on a non-DOM node. We
    // don't support IE8 but we shouldn't throw an error if loaded
    // there.
    videojs.FlashMediaSource.prototype.duration = NaN;
  }

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
    window.setTimeout(func, videojs.FlashMediaSource.TIME_BETWEEN_TICKS);
  };

  // Source Buffer
  videojs.FlashSourceBuffer = videojs.extend(EventTarget, {

    constructor: function(mediaSource){
      var
        encodedHeader,
        self = this;

      // Start off using the globally defined value but refine
      // as we append data into flash
      this.chunkSize_ = videojs.FlashMediaSource.BYTES_PER_CHUNK;

      // byte arrays queued to be appended
      this.buffer_ = [];

      // the total number of queued bytes
      this.bufferSize_ =  0;

      // to be able to determine the correct position to seek to, we
      // need to retain information about the mapping between the
      // media timeline and PTS values
      this.basePtsOffset_ = NaN;

      this.mediaSource = mediaSource;

      // indicates whether the asynchronous continuation of an operation
      // is still being processed
      // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
      this.updating = false;
      this.timestampOffset_ = 0;

      // TS to FLV transmuxer
      this.segmentParser_ = new muxjs.flv.Transmuxer();
      this.segmentParser_.on('data', this.receiveBuffer_.bind(this));
      encodedHeader = window.btoa(String.fromCharCode.apply(null, Array.prototype.slice.call(this.segmentParser_.getFlvHeader())));
      this.mediaSource.swfObj.vjs_appendBuffer(encodedHeader);

      Object.defineProperty(this, 'timestampOffset', {
        get: function() {
          return this.timestampOffset_;
        },
        set: function(val) {
          if (typeof val === 'number' && val >= 0) {
            this.timestampOffset_ = val;
            this.segmentParser_ = new muxjs.flv.Transmuxer();
            this.segmentParser_.on('data', this.receiveBuffer_.bind(this));
            // We have to tell flash to expect a discontinuity
            this.mediaSource.swfObj.vjs_discontinuity();
            // the media <-> PTS mapping must be re-established after
            // the discontinuity
            this.basePtsOffset_ = NaN;
          }
        }
      });

      Object.defineProperty(this, 'buffered', {
        get: function() {
          return videojs.createTimeRanges(this.mediaSource.swfObj.vjs_getProperty('buffered'));
        }
      });

      // On a seek we remove all text track data since flash has no concept
      // of a buffered-range and everything else is reset on seek
      this.mediaSource.player_.on('seeked', function() {
        removeCuesFromTrack(0, Infinity, self.metadataTrack_);
        removeCuesFromTrack(0, Infinity, self.inbandTextTrack_);
      });
    },

    // accept video data and pass to the video (swf) object
    appendBuffer: function(bytes){
      var error, self = this;

      if (this.updating) {
        error = new Error('SourceBuffer.append() cannot be called ' +
                          'while an update is in progress');
        error.name = 'InvalidStateError';
        error.code = 11;
        throw error;
      }

      this.updating = true;
      this.mediaSource.readyState = 'open';
      this.trigger({ type: 'update' });

      var chunk = 512 * 1024;
      var i = 0;
      (function chunkInData() {
        self.segmentParser_.push(bytes.subarray(i, i + chunk));
        i += chunk;
        if (i < bytes.byteLength) {
          scheduleTick(chunkInData);
        } else {
          scheduleTick(self.segmentParser_.flush.bind(self.segmentParser_));
        }
      })();
    },

    // reset the parser and remove any data queued to be sent to the swf
    abort: function() {
      this.buffer_ = [];
      this.bufferSize_ = 0;
      this.mediaSource.swfObj.vjs_abort();

      // report any outstanding updates have ended
      if (this.updating) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }
    },

    // Flash cannot remove ranges already buffered in the NetStream
    // but seeking clears the buffer entirely. For most purposes,
    // having this operation act as a no-op is acceptable.
    remove: function() {
      removeCuesFromTrack(0, Infinity, this.metadataTrack_);
      removeCuesFromTrack(0, Infinity, this.inbandTextTrack_);
      this.trigger({ type: 'update' });
      this.trigger({ type: 'updateend' });
    },

    receiveBuffer_: function(segment) {
      var self = this;

      // create an in-band caption track if one is present in the segment
      createTextTracksIfNecessary(this, this.mediaSource, segment);
      addTextTrackData(this, segment.captions, segment.metadata);

      // Do this asynchronously since convertTagsToData_ can be time consuming
      scheduleTick(function() {
        if (self.buffer_.length === 0) {
          scheduleTick(self.processBuffer_.bind(self));
        }
        var flvBytes = self.convertTagsToData_(segment);
        if (flvBytes) {
          self.buffer_.push(flvBytes);
          self.bufferSize_ += flvBytes.byteLength;
        }
      });
    },

    // append a portion of the current buffer to the SWF
    processBuffer_: function() {
      var
        chunk,
        i,
        length,
        binary,
        b64str,
        startByte = 0,
        appendIterations = 0,
        startTime = +(new Date()),
        appendTime;

      if (!this.buffer_.length) {
        if (this.updating !== false) {
          this.updating = false;
          this.trigger({ type: 'updateend' });
        }
        // do nothing if the buffer is empty
        return;
      }

      do {
        appendIterations++;
        // concatenate appends up to the max append size
        chunk = this.buffer_[0].subarray(startByte, startByte + this.chunkSize_);

        // requeue any bytes that won't make it this round
        if (chunk.byteLength < this.chunkSize_ ||
            this.buffer_[0].byteLength === startByte + this.chunkSize_) {
          startByte = 0;
          this.buffer_.shift();
        } else {
          startByte += this.chunkSize_;
        }

        this.bufferSize_ -= chunk.byteLength;

        // base64 encode the bytes
        binary = '';
        length = chunk.byteLength;
        for (i = 0; i < length; i++) {
          binary += String.fromCharCode(chunk[i]);
        }
        b64str = window.btoa(binary);

        // bypass normal ExternalInterface calls and pass xml directly
        // IE can be slow by default
        this.mediaSource.swfObj.CallFunction('<invoke name="vjs_appendBuffer"' +
                                             'returntype="javascript"><arguments><string>' +
                                             b64str +
                                             '</string></arguments></invoke>');
        appendTime = (new Date()) - startTime;
      } while (this.buffer_.length &&
          appendTime < videojs.FlashMediaSource.TIME_PER_TICK);

      if (this.buffer_.length && startByte) {
        this.buffer_[0] = this.buffer_[0].subarray(startByte);
      }

      if (appendTime >= videojs.FlashMediaSource.TIME_PER_TICK) {
        // We want to target 4 iterations per time-slot so that gives us
        // room to adjust to changes in Flash load and other externalities
        // such as garbage collection while still maximizing throughput
        this.chunkSize_ = Math.floor(this.chunkSize_ * (appendIterations / 4));
      }

      // We also make sure that the chunk-size doesn't drop below 1KB or
      // go above 1MB as a sanity check
      this.chunkSize_ = Math.max(
        videojs.FlashMediaSource.MIN_CHUNK,
        Math.min(this.chunkSize_, videojs.FlashMediaSource.MAX_CHUNK));

      // schedule another append if necessary
      if (this.bufferSize_ !== 0) {
        scheduleTick(this.processBuffer_.bind(this));
      } else {
        this.updating = false;
        this.trigger({ type: 'updateend' });

        if (this.mediaSource.readyState === 'ended') {
          this.mediaSource.swfObj.vjs_endOfStream();
        }
      }
    },

    // Turns an array of flv tags into a Uint8Array representing the
    // flv data. Also removes any tags that are before the current
    // time so that playback begins at or slightly after the right
    // place on a seek
    convertTagsToData_: function (segmentData) {
      var
        segmentByteLength = 0,
        tech = this.mediaSource.tech_,
        start = 0,
        i, j, segment, targetPts,
        tags = this.getOrderedTags_(segmentData);

      // establish the media timeline to PTS translation if we don't
      // have one already
      if (isNaN(this.basePtsOffset_) && tags.length) {
        this.basePtsOffset_ = tags[0].pts;
      }

      // if the player is seeking, determine the PTS value for the
      // target media timeline position
      if (tech.seeking()) {
        targetPts = tech.currentTime() - this.timestampOffset;
        targetPts *= 1e3; // PTS values are represented in milliseconds
        targetPts += this.basePtsOffset_;

        // skip tags less than the seek target
        while (start < tags.length && tags[start].pts < targetPts) {
          start++;
        }
      }

      if (start >= tags.length) {
        return;
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
    },

    // assemble the FLV tags in decoder order
    getOrderedTags_: function(segmentData) {
      var
        videoTags = segmentData.tags.videoTags,
        audioTags = segmentData.tags.audioTags,
        tag,
        tags = [];

      while (videoTags.length || audioTags.length) {
        if (!videoTags.length) {
          // only audio tags remain
          tag = audioTags.shift();
        } else if (!audioTags.length) {
          // only video tags remain
          tag = videoTags.shift();
        } else if (audioTags[0].dts < videoTags[0].dts) {
          // audio should be decoded next
          tag = audioTags.shift();
        } else {
          // video should be decoded next
          tag = videoTags.shift();
        }

        tags.push(tag.finalize());
      }

      return tags;
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
