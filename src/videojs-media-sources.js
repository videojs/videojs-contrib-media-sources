(function(window, muxjs, undefined){
  'use strict';
  var urlCount = 0,
      EventTarget = videojs.EventTarget,
      VirtualSourceBuffer,
      flvCodec = /video\/flv(;\s*codecs=["']vp6,aac["'])?$/,
      objectUrlPrefix = 'blob:vjs-media-source/',
      interceptBufferCreation,
      addSourceBuffer,
      scheduleTick;

  // ------------
  // Media Source
  // ------------

  videojs.MediaSource = videojs.extends(EventTarget, {
    constructor: function(){
      // if native MediaSources are supported, use them
      var self;
      if (window.MediaSource) {
        self = new window.MediaSource();
        interceptBufferCreation(self);
        return self;
      }

      // otherwise, emulate them through the SWF
      return new videojs.FlashMediaSource();
    }
  });
  videojs.MediaSource.supportsNativeMediaSources = function() {
    return window.MediaSource;
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
    var audio, video, buffer;
    // create a virtual source buffer to transmux MPEG-2 transport
    // stream segments into fragmented MP4s
    if (type === 'video/mp2t') {
      audio = this.addSourceBuffer_('audio/mp4;codecs=mp4a.40.2');
      video = this.addSourceBuffer_('video/mp4;codecs=avc1.4d400d');
      buffer = new VirtualSourceBuffer(audio, video)
      this.virtualBuffers.push(buffer);
      return buffer;
    }

    // delegate to the native implementation
    return this.addSourceBuffer_(type);
  };

  VirtualSourceBuffer = videojs.extends(EventTarget, {
    constructor: function VirtualSourceBuffer(audioBuffer, videoBuffer) {
      this.audioBuffer_ = audioBuffer;
      this.audioUpdating_ = false;
      this.videoBuffer_ = videoBuffer;
      this.videoUpdating_ = false;

      // append muxed segments to their respective native buffers as
      // soon as they are available
      this.transmuxer_ = new muxjs.mp2t.Transmuxer();
      this.transmuxer_.on('data', function(event) {
        var buffer;
        if (event.type === 'video') {
          buffer = this.videoBuffer_;
          this.videoUpdating_ = false;
        } else {
          buffer = this.audioBuffer_;
          this.audioUpdating_ = false;
        }
        if (this.timestampOffset !== undefined) {
          buffer.timestampOffset = this.timestampOffset;
        }
        buffer.appendBuffer(event.data);
      }.bind(this));

      // this buffer is "updating" if either of its native buffers are
      Object.defineProperty(this, 'updating', {
        get: function() {
          return this.audioUpdating_ || this.videoUpdating_ ||
            this.audioBuffer_.updating || this.videoBuffer_.updating;
        }
      });
      // the buffered property is the intersection of the buffered
      // ranges of the native source buffers
      Object.defineProperty(this, 'buffered', {
        get: function() {
          var start, end;
          if (this.videoBuffer_.buffered.length === 0 ||
              this.audioBuffer_.buffered.length === 0) {
            return videojs.createTimeRange();
          }
          start = Math.max(this.videoBuffer_.buffered.start(0),
                           this.audioBuffer_.buffered.start(0));
          end = Math.min(this.videoBuffer_.buffered.end(0),
                         this.audioBuffer_.buffered.end(0));
          return videojs.createTimeRange(start, end);
        }
      });
    },
    appendBuffer: function(segment) {
      this.audioUpdating_ = this.videoUpdating_ = true;
      this.transmuxer_.push(segment);
      this.transmuxer_.end();
    }
  });

  // -----
  // Flash
  // -----

  videojs.FlashMediaSource = videojs.extends(EventTarget, {
    constructor: function(){
      this.sourceBuffers = [];
      this.readyState = 'closed';

      this.on(['sourceopen', 'webkitsourceopen'], function(event){
        // find the swf where we will push media data
        this.swfObj = document.getElementById(event.swfId);
        this.readyState = 'open';

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
    if (type === 'video/mp2t') {
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
   */
  videojs.FlashMediaSource.prototype.endOfStream = function(){
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
  videojs.FlashSourceBuffer = videojs.extends(EventTarget, {

    constructor: function(source){
      var flvHeader;

      // byte arrays queued to be appended
      this.buffer_ = [];

      // the total number of queued bytes
      this.bufferSize_ =  0;

      this.source = source;

      // indicates whether the asynchronous continuation of an operation
      // is still being processed
      // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
      this.updating = false;

      // TS to FLV transmuxer
      this.segmentParser_ = new muxjs.SegmentParser();
      flvHeader = this.segmentParser_.getFlvHeader();
      this.source.swfObj.vjs_appendBuffer(flvHeader);

      Object.defineProperty(this, 'buffered', {
        get: function() {
          return videojs.createTimeRange(0, this.source.swfObj.vjs_getProperty('buffered'));
        }
      });
    },

    // accept video data and pass to the video (swf) object
    appendBuffer: function(uint8Array){
      var error, flvBytes;

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
      var chunk, i, length, payload, maxSize, b64str,
          binary = '';

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
      for (i = 0, length = payload.byteLength; i < length; i++) {
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
          i, j, segment;

      // transmux the TS to FLV
      this.segmentParser_.parseSegmentBinaryData(bytes);
      this.segmentParser_.flushTags();

      // assemble the FLV tags in decoder order
      while (this.segmentParser_.tagsAvailable()) {
        tags.push(this.segmentParser_.getNextTag());
      }

      // concatenate the bytes into a single segment
      for (i = 0; i < tags.length; i++) {
        segmentByteLength += tags[i].bytes.byteLength;
      }
      segment = new Uint8Array(segmentByteLength);
      for (i = 0, j = 0; i < tags.length; i++) {
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
        return window.URL.createObjectURL(object);
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
