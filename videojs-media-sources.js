(function(window){
  var urlCount = 0,
      NativeMediaSource = window.MediaSource || window.WebKitMediaSource || {},
      nativeUrl = window.URL || {},
      flvCodec = /video\/flv; codecs=["']vp6,aac["']/,
      objectUrlPrefix = 'blob:vjs-media-source/';

  // extend the media source APIs

  // Media Source
  videojs.MediaSource = function(){
    var self = this;

    this.sourceBuffers = [];
    this.readyState = 'closed';
    this.listeners = {
      sourceopen: [function(event){
        // find the swf where we will push media data
        self.swfObj = document.getElementById(event.swfId);
        self.readyState = 'open';
        
        // trigger load events
        if (self.swfObj) {
          self.swfObj.vjs_load();
        }
      }],
      webkitsourceopen: [function(event){
        self.trigger({
          type: 'sourceopen'
        });
      }]
    };
  };

  videojs.MediaSource.prototype = {

    // create a new source buffer to receive a type of media data
    addSourceBuffer: function(type){
      var sourceBuffer;

      // if this is an FLV type, we'll push data to flash
      if (flvCodec.test(type)) {
        // Flash source buffers
        sourceBuffer = new videojs.SourceBuffer(this);
      } else {
        // native source buffers
        sourceBuffer = this.nativeSource.addSourceBuffer.apply(this.nativeSource, arguments);
      }

      this.sourceBuffers.push(sourceBuffer);
      return sourceBuffer;
    },
    endOfStream: function(){
      this.readyState = 'ended';
    },
    addEventListener: function(type, listener){
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].unshift(listener);
    },
    trigger: function(event){
      var listeners = this.listeners[event.type] || [],
          i = listeners.length;
      while (i--) {
        listeners[i](event);
      }
    }
  };

  // store references to the media sources so they can be connected
  // to a video element (a swf object)
  videojs.mediaSources = {};
  // provide a method for a swf object to notify JS that a media source is now open
  videojs.MediaSource.open = function(msObjectURL, swfId){
    var ms = videojs.mediaSources[msObjectURL];

    if (ms) {
      ms.trigger({
        type: 'sourceopen',
        swfId: swfId
      });
    } else {
      throw new Error('Media Source not found (Video.js)');
    }
  };

  // Source Buffer
  videojs.SourceBuffer = function(source){
    this.source = source;
    this.buffer = [];
  };

  videojs.SourceBuffer.prototype = {

    // accept video data and pass to the video (swf) object
    appendBuffer: function(uint8Array){
      var array = [], 
          i = uint8Array.length, 
          self = this;

      this.buffer.push(uint8Array);
      while (i--) {
        array[i] = uint8Array[i];
      }
      if (this.source.swfObj) {
        this.source.swfObj.vjs_appendBuffer(array);
      }
      this.trigger('update');
      this.trigger('updateend');
    },
    trigger: function(type){
      videojs.trigger(this, type);
    },
    on: function(type, listener){
      videojs.on(this, type, listener);
    },
    off: function(type, listener){
      videojs.off(this, type, listener);
    }
  };

  // URL
  videojs.URL = {
    createObjectURL: function(object){
      var url = objectUrlPrefix + urlCount;
      
      urlCount++;

      // setup the mapping back to object
      videojs.mediaSources[url] = object;

      return url;
    }
  };

  // plugin
  videojs.plugin('mediaSource', function(options) {
    var player = this;
    
    player.on('loadstart', function() {
      var url = player.currentSrc(),
          trigger = function(event){
            mediaSource.trigger(event);
          },
          mediaSource;

      if (player.techName === 'Html5' && url.indexOf(objectUrlPrefix) === 0) {
        // use the native media source implementation
        mediaSource = videojs.mediaSources[url];

        if (!mediaSource.nativeUrl) {
          // initialize the native source
          mediaSource.nativeSource = new NativeMediaSource();
          mediaSource.nativeSource.addEventListener('sourceopen', trigger, false);
          mediaSource.nativeSource.addEventListener('webkitsourceopen', trigger, false);
          mediaSource.nativeUrl = nativeUrl.createObjectURL(mediaSource.nativeSource);
        }
        player.src(mediaSource.nativeUrl);
      }
    });
  });

})(this);
