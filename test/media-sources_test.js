(function(window, videojs, muxjs) {
  'use strict';
  var player, video, mediaSource, Flash,
      oldFlashSupport, oldBPS, oldMediaSourceConstructor, oldSTO, oldCanPlay,
      swfCalls,
      appendCalls,
      timers,
      fakeSTO = function() {
        oldSTO = window.setTimeout;
        timers = [];

        timers.run = function (num) {
          var timer;

          while(num--) {
            timer = this.pop();
            if (timer) {
              timer();
            }
          }
        };

        timers.runAll = function (){
          while(this.length) {
            this.pop()();
          }
        };

        window.setTimeout = function(callback) {
          timers.push(callback);
        };
        window.setTimeout.fake = true;
      },
      unfakeSTO = function() {
        timers = [];
        window.setTimeout = oldSTO;
      },
      makeFlvTag = function (pts, data) {
        return {
          pts: pts,
          bytes: data,
          finalize: function(){return this;}
        };
      },
      initializeNativeSourceBuffers,
      oldFlashTransmuxer,
      MockSegmentParser;

  // Override default webWorkerURI for karma
  if (!videojs.MediaSource.webWorkerURI) {
    videojs.MediaSource.webWorkerURI = '/base/src/transmuxer_worker.js';
  }

  module('General', {
    setup: function() {
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource;
    },
    teardown: function() {
      window.MediaSource = window.WebKitMediaSource = oldMediaSourceConstructor;
    }
  });

  test('implementation selection is overridable', function() {
    ok(new videojs.MediaSource({ mode: 'flash' }) instanceof videojs.FlashMediaSource,
       'forced Flash');
    // mock native MediaSources
    window.MediaSource = videojs.extend(videojs.EventTarget, {
      addSourceBuffer: function() {
        throw new Error('Testing Mock');
      }
    });
    ok(new videojs.MediaSource({ mode: 'html5' }) instanceof videojs.HtmlMediaSource,
       'forced HTML5');

    // 'auto' should use native MediaSources when they're available
    ok(new videojs.MediaSource() instanceof videojs.HtmlMediaSource,
       'used HTML5');
    window.MediaSource = null;
    // 'auto' should use Flash when native MediaSources are not available
    ok(new videojs.MediaSource({ mode: 'flash' }) instanceof videojs.FlashMediaSource,
       'used Flash');
  });

  module('HTML MediaSource', {
    setup: function(){
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource;
      window.MediaSource = videojs.extend(videojs.EventTarget, {
        constructor: function(){
          this.isNative = true;
          this.sourceBuffers = [];
          this.duration = NaN;
        },
        addSourceBuffer: function(type) {
          var buffer = new (videojs.extend(videojs.EventTarget, {
            type: type,
            appendBuffer: function() {}
          }))();
          this.sourceBuffers.push(buffer);
          return buffer;
        }
      });
      window.WebKitMediaSource = window.MediaSource;
    },
    teardown: function(){
      window.MediaSource = oldMediaSourceConstructor;
      window.WebKitMediaSource = window.MediaSource;
    }
  });

  test('constructs a native MediaSource', function(){
    ok(new videojs.MediaSource().mediaSource_.isNative, 'constructed a MediaSource');
  });

  // send fake data to the transmuxer to trigger the creation of the
  // native source buffers
  initializeNativeSourceBuffers = function(sourceBuffer) {
    // initialize an audio source buffer
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1).buffer
        }
      }
    });
    // initialize a video source buffer
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });
    // instruct the transmuxer to flush the "data" it has buffered so
    // far
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done'
      }
    });
  };

  test('creates mp4 source buffers for mp2t segments', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    initializeNativeSourceBuffers(sourceBuffer);

    equal(mediaSource.mediaSource_.sourceBuffers.length, 2, 'created two native buffers');
    equal(mediaSource.mediaSource_.sourceBuffers[0].type,
          'audio/mp4;codecs="mp4a.40.2"',
          'created an mp4a buffer');
    equal(mediaSource.mediaSource_.sourceBuffers[1].type,
          'video/mp4;codecs="avc1.4d400d"',
          'created an avc1 buffer');
    equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
    equal(mediaSource.sourceBuffers[0],
          sourceBuffer,
          'returned the virtual buffer');
    ok(sourceBuffer.transmuxer_, 'created a transmuxer');
  });

  test('abort on the fake source buffer calls abort on the real ones', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        messages = [],
        aborts = 0;

    initializeNativeSourceBuffers(sourceBuffer);
    sourceBuffer.transmuxer_.postMessage = function (message) {
      messages.push(message);
    };
    sourceBuffer.bufferUpdating_ = true;
    mediaSource.mediaSource_.sourceBuffers[0].abort = function () {
      aborts++;
    };
    mediaSource.mediaSource_.sourceBuffers[1].abort = function () {
      aborts++;
    };

    sourceBuffer.abort();

    equal(aborts, 2, 'called abort on both');
    equal(sourceBuffer.bufferUpdating_,
          false,
          'set updating to false');
    equal(messages.length, 1, 'has one message');
    equal(messages[0].action, 'reset', 'reset called on transmuxer');
  });

  test('calling remove deletes cues and invokes remove on any extant source buffers', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        messages = [],
        removedCue = [],
        removes = 0;

    initializeNativeSourceBuffers(sourceBuffer);
    sourceBuffer.inbandTextTrack_ = {
      removeCue: function (cue) {
        removedCue.push(cue);
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
      cues: [
        {startTime: 10, endTime: 20, text: 'delete me'},
        {startTime: 0, endTime: 2, text: 'save me'}
      ]
    };
    mediaSource.mediaSource_.sourceBuffers[0].remove = function (start, end) {
      if (start === 3 && end === 10) {
        removes++;
      }
    };
    mediaSource.mediaSource_.sourceBuffers[1].remove = function (start, end) {
      if (start === 3 && end === 10) {
        removes++;
      }
    };

    sourceBuffer.remove(3, 10);

    equal(removes, 2, 'called remove on both sourceBuffers');
    equal(sourceBuffer.inbandTextTrack_.cues.length, 1, 'one cue remains after remove');
    equal(removedCue[0].text, 'delete me', 'the cue that overlapped the remove region was removed');
  });

  test('readyState delegates to the native implementation', function() {
    var mediaSource = new videojs.HtmlMediaSource();

    equal(mediaSource.readyState,
          mediaSource.mediaSource_.readyState,
          'readyStates are equal');

    mediaSource.mediaSource_.readyState = 'nonsense stuff';
    equal(mediaSource.readyState,
          mediaSource.mediaSource_.readyState,
          'readyStates are equal');
  });

  test('addSeekableRange_ throws an error for media with known duration', function() {
    var mediaSource = new videojs.MediaSource();
    mediaSource.duration = 100;

    throws(function() {
      mediaSource.addSeekableRange_(0, 100);
    }, 'cannot add seekable range');
  });

  test('addSeekableRange_ adds to the native MediaSource duration', function() {
    var mediaSource = new videojs.MediaSource();
    mediaSource.duration = Infinity;

    mediaSource.addSeekableRange_(120, 240);
    equal(mediaSource.mediaSource_.duration, 240, 'set native duration');
    equal(mediaSource.duration, Infinity, 'emulated duration');

    mediaSource.addSeekableRange_(120, 220);
    equal(mediaSource.mediaSource_.duration, 240, 'ignored the smaller range');
    equal(mediaSource.duration, Infinity, 'emulated duration');
  });

  test('transmuxes mp2t segments', function(){
    var mp2tSegments = [], mp4Segments = [], data = new Uint8Array(1),
        mediaSource, sourceBuffer;
    mediaSource = new videojs.MediaSource();
    sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.transmuxer_.postMessage = function(segment) {
      if (segment.action === 'push') {
        var buffer = new Uint8Array(segment.data);
        mp2tSegments.push(buffer);
      }
    };

    sourceBuffer.appendBuffer(data);
    equal(mp2tSegments.length, 1, 'transmuxed one segment');
    equal(mp2tSegments[0].length, 1, 'did not alter the segment');
    equal(mp2tSegments[0][0], data[0], 'did not alter the segment');

    // an init segment
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });

    // Source buffer is not created until after the muxer starts emitting data
    mediaSource.mediaSource_.sourceBuffers[0].appendBuffer = function(segment) {
      mp4Segments.push(segment);
    };

    // a media segment
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });

    // Segments are concatenated
    equal(mp4Segments.length, 0, 'segments are not appended until after the `done` message');

    // send `done` message
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done',
      }
    });

    // Segments are concatenated
    equal(mp4Segments.length, 1, 'appended the segments');
  });

  test('handles codec strings in reverse order', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.5,avc1.64001f"');

    initializeNativeSourceBuffers(sourceBuffer);
    equal(mediaSource.mediaSource_.sourceBuffers[0].type,
          'audio/mp4;codecs="mp4a.40.5"',
          'passed the audio codec along');
    equal(mediaSource.mediaSource_.sourceBuffers[1].type,
          'video/mp4;codecs="avc1.64001f"',
          'passed the video codec along');
  });

  test('forwards codec strings to native buffers when specified', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.64001f,mp4a.40.5"');

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'combined',
          data: new Uint8Array(1).buffer
        }
      }
    });
    equal(mediaSource.mediaSource_.sourceBuffers[0].type,
          'video/mp4;codecs="avc1.64001f,mp4a.40.5"',
          'passed the codec along');
  });

  test('parses old-school apple codec strings to the modern standard', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.100.31,mp4a.40.5"');

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'combined',
          data: new Uint8Array(1).buffer
        }
      }
    });
    equal(mediaSource.mediaSource_.sourceBuffers[0].type,
          'video/mp4;codecs="avc1.64001f,mp4a.40.5"',
          'passed the codec along');
  });

  test('specifies reasonable codecs if none are specified', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'combined',
          data: new Uint8Array(1).buffer
        }
      }
    });
    equal(mediaSource.mediaSource_.sourceBuffers[0].type,
          'video/mp4;codecs="avc1.4d400d,mp4a.40.2"',
          'passed the codec along');
  });

  test('virtual buffers are updating if either native buffer is', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    initializeNativeSourceBuffers(sourceBuffer);

    mediaSource.mediaSource_.sourceBuffers[0].updating = true;
    mediaSource.mediaSource_.sourceBuffers[1].updating = false;

    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.mediaSource_.sourceBuffers[1].updating = true;
    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.mediaSource_.sourceBuffers[0].updating = false;
    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.mediaSource_.sourceBuffers[1].updating = false;
    equal(sourceBuffer.updating, false, 'virtual buffer is not updating');
  });

  test('virtual buffers have a position buffered if both native buffers do', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    // send fake buffers through to cause the creation of the source buffers
    initializeNativeSourceBuffers(sourceBuffer);

    mediaSource.mediaSource_.sourceBuffers[0].buffered = videojs.createTimeRanges([
      [0, 10],
      [20, 30]
    ]);
    mediaSource.mediaSource_.sourceBuffers[1].buffered = videojs.createTimeRanges([
      [0, 7],
      [11, 15],
      [16, 40]
    ]);

    equal(sourceBuffer.buffered.length, 2, 'two buffered ranges');
    equal(sourceBuffer.buffered.start(0), 0, 'first starts at zero');
    equal(sourceBuffer.buffered.end(0), 7, 'first ends at seven');
    equal(sourceBuffer.buffered.start(1), 20, 'second starts at twenty');
    equal(sourceBuffer.buffered.end(1), 30, 'second ends at 30');
  });

  test('sets transmuxer baseMediaDecodeTime on appends', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        resets = [];

    sourceBuffer.transmuxer_.postMessage = function(message) {
      if (message.action === 'setTimestampOffset') {
        resets.push(message.timestampOffset);
      }
    };

    sourceBuffer.timestampOffset = 42;

    initializeNativeSourceBuffers(sourceBuffer);


    equal(resets.length,
          1,
          'reset called');
    equal(resets[0],
          42,
          'set the baseMediaDecodeTime based on timestampOffset');
  });

  test('aggregates source buffer update events', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        updates = 0,
        updateends = 0,
        updatestarts = 0;

    initializeNativeSourceBuffers(sourceBuffer);

    sourceBuffer.addEventListener('updatestart', function() {
      updatestarts++;
    });
    sourceBuffer.addEventListener('update', function() {
      updates++;
    });
    sourceBuffer.addEventListener('updateend', function() {
      updateends++;
    });

    equal(updatestarts, 0, 'no updatestarts before a `done` message is received');
    equal(updates, 0, 'no updates before a `done` message is received');
    equal(updateends, 0, 'no updateends before a `done` message is received');

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done'
      }
    });

    // the video buffer begins updating first:
    sourceBuffer.videoBuffer_.updating = true;
    sourceBuffer.audioBuffer_.updating = false;
    sourceBuffer.videoBuffer_.trigger('updatestart');
    equal(updatestarts, 1, 'aggregated updatestart');
    sourceBuffer.audioBuffer_.updating = true;
    sourceBuffer.audioBuffer_.trigger('updatestart');
    equal(updatestarts, 1, 'aggregated updatestart');

    // the audio buffer finishes first:
    sourceBuffer.audioBuffer_.updating = false;
    sourceBuffer.videoBuffer_.updating = true;
    sourceBuffer.audioBuffer_.trigger('update');
    equal(updates, 0, 'waited for the second update');
    sourceBuffer.videoBuffer_.updating = false;
    sourceBuffer.videoBuffer_.trigger('update');
    equal(updates, 1, 'aggregated update');

    // audio finishes first:
    sourceBuffer.videoBuffer_.updating = true;
    sourceBuffer.audioBuffer_.updating = false;
    sourceBuffer.audioBuffer_.trigger('updateend');
    equal(updateends, 0, 'waited for the second updateend');
    sourceBuffer.videoBuffer_.updating = false;
    sourceBuffer.videoBuffer_.trigger('updateend');
    equal(updateends, 1, 'aggregated updateend');
  });

  test('translates caption events into WebVTT cues', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        types = [],
        cues = [];

    mediaSource.player_ = {
      addTextTrack: function(type) {
        types.push(type);
        return {
          addCue: function(cue) {
            cues.push(cue);
          }
        };
      }
    };
    sourceBuffer.timestampOffset = 10;
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1),
          captions: [{
            startTime: 1,
            endTime: 3,
            text: 'This is an in-band caption'
          }]
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done'
      }
    });

    equal(types.length, 1, 'created one text track');
    equal(types[0], 'captions', 'the type was captions');
    equal(cues.length, 1, 'created one cue');
    equal(cues[0].text, 'This is an in-band caption', 'included the text');
    equal(cues[0].startTime, 11, 'started at eleven');
    equal(cues[0].endTime, 13, 'ended at thirteen');
  });

  test('translates metadata events into WebVTT cues', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        metadata = [{
          cueTime: 2,
          frames: [
            {
              url: 'This is a url tag'
            },{
              value: 'This is a text tag'
            }
          ],
        },
        {
          cueTime: 12,
          frames: [
            {
              data: 'This is a priv tag'
            }
          ]
        }],
        types = [],
        cues = [];

    metadata.dispatchType = 0x10;

    mediaSource.player_ = {
      addTextTrack: function(type) {
        types.push(type);
        return {
          addCue: function(cue) {
            cues.push(cue);
          }
        };
      }
    };
    sourceBuffer.timestampOffset = 10;
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1),
          metadata: metadata
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done'
      }
    });

    equal(
      sourceBuffer.metadataTrack_.inBandMetadataTrackDispatchType,
      16,
      'in-band metadata track dispatch type correctly set');
    equal(types.length, 1, 'created one text track');
    equal(types[0], 'metadata', 'the type was metadata');
    equal(cues.length, 3, 'created three cues');
    equal(cues[0].text, 'This is a url tag', 'included the text');
    equal(cues[0].startTime, 12, 'started at twelve');
    equal(cues[0].endTime, 12, 'ended at twelve');
    equal(cues[1].text, 'This is a text tag', 'included the text');
    equal(cues[1].startTime, 12, 'started at twelve');
    equal(cues[1].endTime, 12, 'ended at twelve');
    equal(cues[2].text, 'This is a priv tag', 'included the text');
    equal(cues[2].startTime, 22, 'started at twenty two');
    equal(cues[2].endTime, 22, 'ended at twenty two');
  });

  test('does not wrap mp4 source buffers', function(){
    var mediaSource = new videojs.MediaSource(),
        video = mediaSource.addSourceBuffer('video/mp4;codecs=avc1.4d400d'),
        audio = mediaSource.addSourceBuffer('audio/mp4;codecs=mp4a.40.2');

    equal(mediaSource.sourceBuffers.length,
          mediaSource.mediaSource_.sourceBuffers.length,
          'did not need virtual buffers');
    equal(mediaSource.sourceBuffers.length, 2, 'created native buffers');
  });

  // return the sequence of calls to append to the SWF
  appendCalls = function(calls) {
    return calls.filter(function(call) {
      return call.callee && call.callee === 'vjs_appendBuffer';
    });
  };

  module('Flash MediaSource', {
    setup: function(assert) {
      var swfObj, tech;
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource;
      window.MediaSource = null;
      window.WebKitMediaSource = null;

      Flash = videojs.getComponent('Flash');
      oldFlashSupport = Flash.isSupported;
      oldCanPlay = Flash.canPlaySource;
      Flash.canPlaySource = Flash.isSupported = function() {
        return true;
      };

      oldBPS = videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL;
      oldFlashTransmuxer = muxjs.flv.Transmuxer;
      muxjs.flv.Transmuxer = MockSegmentParser;

      video = document.createElement('video');
      document.getElementById('qunit-fixture').appendChild(video);
      player = videojs(video);

      swfCalls = [];
      mediaSource = new videojs.MediaSource();
      player.src({
        src: videojs.URL.createObjectURL(mediaSource),
        type: "video/mp2t"
      });
      swfObj = document.createElement('fake-object');
      swfObj.id = 'fake-swf-' + assert.test.testId;
      player.el().replaceChild(swfObj, player.tech_.el());
      player.tech_.el_ = swfObj;
      swfObj.tech = player.tech_;
      swfObj.CallFunction = function(xml) {
        var parser = new DOMParser(), call = {}, doc;

        // parse as HTML because it's more forgiving
        doc = parser.parseFromString(xml, 'text/html');
        call.callee = doc.querySelector('invoke').getAttribute('name');

        // decode the function arguments
        call.arguments = Array.prototype.slice.call(doc.querySelectorAll('arguments > *')).map(function(arg) {
          return window.atob(arg.textContent).split('').map(function(c) {
            return c.charCodeAt(0);
          });
        });
        swfCalls.push(call);
      };
      swfObj.vjs_abort =  function() {
        swfCalls.push('abort');
      };
      swfObj.vjs_getProperty = function(attr) {
        if (attr === 'buffered') {
          return [];
        } else if (attr === 'currentTime') {
          return 0;
        }
        swfCalls.push({ attr: attr });
      };
      swfObj.vjs_load = function() {
        swfCalls.push('load');
      };
      swfObj.vjs_setProperty = function(attr, value) {
        swfCalls.push({ attr: attr, value: value });
      };
      swfObj.vjs_discontinuity = function(attr, value) {
        swfCalls.push({ attr: attr, value: value });
      };
      swfObj.vjs_appendBuffer = function(flvHeader) {
        // only the FLV header directly invokes this so we can
        // ignore it
      };
      mediaSource.trigger({
        type: 'sourceopen',
        swfId: swfObj.id
      });

      fakeSTO();
    },
    teardown: function() {
      window.MediaSource = oldMediaSourceConstructor;
      Flash.isSupported = oldFlashSupport;
      Flash.canPlaySource = oldCanPlay;
      videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = oldBPS;
      muxjs.flv.Transmuxer = oldFlashTransmuxer;
      unfakeSTO();
    }
  });

  MockSegmentParser = function() {
    var ons = {};
    this.on = function (type, fn) {
      if (!ons[type]) {
        ons[type] = [fn];
      } else {
        ons[type].push(fn);
      }
    };
    this.trigger = function (type, data) {
      if (ons[type]) {
        ons[type].forEach(function (fn) {
          fn(data);
        });
      }
    };
    this.getFlvHeader = function() {
      return new Uint8Array([1, 2, 3]);
    };
    var datas = [];
    this.push = function(data) {
      datas.push(data);
    };
    this.flush = function() {
      var tags = datas.reduce(function(output, data, i) {
        output.push(makeFlvTag(i, data));
        return output;
      }, []);
      datas.length = 0;
      this.trigger('data', {
        tags: {
          videoTags: tags,
          audioTags: []
        }
      });
    };
  };

  test('raises an exception for unrecognized MIME types', function() {
    try {
      mediaSource.addSourceBuffer('video/garbage');
    } catch(e) {
      ok(e, 'an error was thrown');
      return;
    }
    ok(false, 'no error was thrown');
  });

  test('creates FlashSourceBuffers for video/mp2t', function() {
    ok(mediaSource.addSourceBuffer('video/mp2t') instanceof videojs.FlashSourceBuffer,
       'create source buffer');
  });

  test('waits for the next tick to append', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    equal(swfCalls.length, 1, 'made one call on init');
    equal(swfCalls[0], 'load', 'called load');
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 0, 'no appends were made');
  });

  test('passes bytes to Flash', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    timers.runAll();

    ok(swfCalls.length, 'the SWF was called');
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls[0].callee, 'vjs_appendBuffer', 'called appendBuffer');
    deepEqual(swfCalls[0].arguments[0],
              [0, 1],
              'passed the base64 encoded data');
  });

  test('size of the append window changes based on timing information', function() {
    /* jshint -W020 */
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
      time = 0,
      oldDate = Date,
      swfObj = mediaSource.swfObj,
      callFunction = swfObj.CallFunction;

    // Set some easy-to-test values
    var BYTES_PER_CHUNK = videojs.FlashMediaSource.BYTES_PER_CHUNK;
    var MIN_CHUNK = videojs.FlashMediaSource.MIN_CHUNK;
    var MAX_CHUNK = videojs.FlashMediaSource.MAX_CHUNK;

    videojs.FlashMediaSource.BYTES_PER_CHUNK = 2;
    videojs.FlashMediaSource.MIN_CHUNK = 1;
    videojs.FlashMediaSource.MAX_CHUNK = 10;

    sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    time =  0;
    oldDate = Date;
    Date = function () {
      return {
        getTime: function () {
          return oldDate.now();
        },
        valueOf: function () {
          return time;
        }
      };
    };

    // Replace the CallFunction so that we can increment "time" in response
    // to appends
    swfObj.CallFunction = function(xml) {
      time += 0.5; // Take just half a millisecond per append
      return callFunction(xml);
    };

    sourceBuffer.appendBuffer(new Uint8Array(16));
    timers.runAll();

    equal(swfCalls.shift().indexOf('load'), 0, 'swf load called');
    equal(swfCalls.length, 8, 'called swf once per two-bytes');
    equal(sourceBuffer.chunkSize_, 4, 'sourceBuffer.chunkSize_ doubled');

    swfCalls.length = 0;

    // Replace the CallFunction so that we can increment "time" in response
    // to appends
    swfObj.CallFunction = function(xml) {
      time += 2; // Take 2 millisecond per append
      return callFunction(xml);
    };

    sourceBuffer.appendBuffer(new Uint8Array(16));
    timers.runAll();

    equal(swfCalls.length, 8, 'called swf once per byte');
    equal(swfCalls[0].arguments[0].length, 4, 'swf called with 4 bytes');
    equal(swfCalls[1].arguments[0].length, 4, 'swf called with 4 bytes twice');
    equal(swfCalls[2].arguments[0].length, 2, 'swf called with 2 bytes');
    equal(swfCalls[3].arguments[0].length, 2, 'swf called with 2 bytes twice');
    equal(swfCalls[4].arguments[0].length, 1, 'swf called with 1 bytes');
    equal(swfCalls[5].arguments[0].length, 1, 'swf called with 1 bytes twice');
    equal(swfCalls[6].arguments[0].length, 1, 'swf called with 1 bytes thrice');
    equal(swfCalls[7].arguments[0].length, 1, 'swf called with 1 bytes four times');
    equal(sourceBuffer.chunkSize_, 1, 'sourceBuffer.chunkSize_ reduced to 1');

    videojs.FlashMediaSource.BYTES_PER_CHUNK = BYTES_PER_CHUNK;
    videojs.FlashMediaSource.MIN_CHUNK = MIN_CHUNK;
    videojs.FlashMediaSource.MAX_CHUNK = MAX_CHUNK;
    Date = oldDate;
    /* jshint +W020 */
  });

  test('clears the SWF on seeking', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        aborts = 0,
        bytes = [];

    // track calls to abort()
    mediaSource.swfObj.vjs_abort = function() {
      aborts++;
    };

    mediaSource.tech_.trigger('seeking');
    strictEqual(1, aborts, 'aborted pending buffer');
  });

  test('drops tags before currentTime when seeking', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        i = 10,
        currentTime,
        tags_ = [];
    mediaSource.tech_.currentTime = function() {
      return currentTime;
    };

    // push a tag into the buffer to establish the starting PTS value
    currentTime = 0;
    sourceBuffer.segmentParser_.trigger('data', {
       tags: {
        videoTags: [makeFlvTag(19 * 1000, new Uint8Array(1))],
        audioTags: []
      }
    });
    timers.runAll();

    sourceBuffer.appendBuffer(new Uint8Array(10));
    timers.runAll();

    // mock out a new segment of FLV tags, starting 10s after the
    // starting PTS value
    while (i--) {
      tags_.unshift(
        makeFlvTag((i * 1000) + (29 * 1000),
          new Uint8Array([i])));
    }
    sourceBuffer.segmentParser_.trigger('data', {
      tags: {
        videoTags: tags_,
        audioTags: []
      }
    });

    // seek to 7 seconds into the new swegment
    mediaSource.tech_.seeking = function() {
      return true;
    };
    currentTime = 10 + 7;
    mediaSource.tech_.trigger('seeking');
    sourceBuffer.appendBuffer(new Uint8Array(10));
    swfCalls.length = 0;
    timers.runAll();

    deepEqual(swfCalls[0].arguments[0], [7, 8, 9],
              'three tags are appended');
  });

  test('drops tags before the buffered end always', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        i = 10,
        endTime,
        tags_ = [];
    mediaSource.tech_.buffered = function() {
      return videojs.createTimeRange([[0, endTime]]);
    };

    // push a tag into the buffer to establish the starting PTS value
    endTime = 0;
    sourceBuffer.segmentParser_.trigger('data', {
       tags: {
        videoTags: [makeFlvTag(19 * 1000, new Uint8Array(1))],
        audioTags: []
      }
    });
    timers.runAll();

    sourceBuffer.appendBuffer(new Uint8Array(10));
    timers.runAll();

    // mock out a new segment of FLV tags, starting 10s after the
    // starting PTS value
    while (i--) {
      tags_.unshift(
        makeFlvTag((i * 1000) + (29 * 1000),
          new Uint8Array([i])));
    }
    sourceBuffer.segmentParser_.trigger('data', {
      tags: {
        videoTags: tags_,
        audioTags: []
      }
    });

    endTime = 10 + 7;
    mediaSource.tech_.trigger('seeking');
    sourceBuffer.appendBuffer(new Uint8Array(10));
    swfCalls.length = 0;
    timers.runAll();

    deepEqual(swfCalls[0].arguments[0], [7, 8, 9],
              'three tags are appended');
  });

  test('seek targeting accounts for changing timestampOffsets', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        i = 10,
        tags_ = [],
        currentTime;
    mediaSource.tech_.currentTime = function() {
      return currentTime;
    };

    // push a tag into the buffer to establish the starting PTS value
    currentTime = 0;
    sourceBuffer.segmentParser_.trigger('data', {
       tags: {
        videoTags: [makeFlvTag(19 * 1000, new Uint8Array(1))],
        audioTags: []
      }
    });
    timers.runAll();

    // to seek across a discontinuity:
    // 1. set the timestamp offset to the media timeline position for
    //    the start of the segment
    // 2. set currentTime to the desired media timeline position
    sourceBuffer.timestampOffset = 22;
    currentTime = sourceBuffer.timestampOffset + 3.5;
    mediaSource.tech_.seeking = function() {
      return true;
    };

    // the new segment FLV tags are at disjoint PTS positions
    while (i--) {
      tags_.unshift(
         // (101 * 1000) !== the old PTS offset
        makeFlvTag((i * 1000) + (101 * 1000),
          new Uint8Array([i + sourceBuffer.timestampOffset])));
    }
    sourceBuffer.segmentParser_.trigger('data', {
      tags: {
        videoTags: tags_,
        audioTags: []
      }
    });

    mediaSource.tech_.trigger('seeking');
    swfCalls.length = 0;
    timers.runAll();

    deepEqual(swfCalls[0].arguments[0],
              [26, 27, 28, 29, 30, 31],
              'filtered the appended tags');
  });

  test('calling endOfStream sets mediaSource readyState to ended', function() {
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };
    sourceBuffer.addEventListener('updateend', function() {
      mediaSource.endOfStream();
    });

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    timers.runAll();

    strictEqual(sourceBuffer.mediaSource.readyState,
      'ended',
      'readyState is \'ended\'');
    strictEqual(swfCalls.length, 2, 'made two calls to swf');
    deepEqual(swfCalls.shift().arguments[0],
              [0, 1],
              'contains the data');

    ok(swfCalls.shift().indexOf('endOfStream') === 0,
       'the second call should be for the updateend');

    strictEqual(timers.length, 0, 'no more appends are scheduled');
  });

  test('opens the stream on sourceBuffer.appendBuffer after endOfStream', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };
    sourceBuffer.addEventListener('updateend', function foo() {
      mediaSource.endOfStream();
      sourceBuffer.removeEventListener('updateend', foo);
    });

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    timers.runAll();

    strictEqual(swfCalls.length, 2, 'made two calls to swf');
    deepEqual(swfCalls.shift().arguments[0],
              [0, 1],
              'contains the data');

    equal(swfCalls.shift(),
          'endOfStream',
          'the second call should be for the updateend');

    sourceBuffer.appendBuffer(new Uint8Array([2]));
    timers.run(2);

    sourceBuffer.buffer_.push(new Uint8Array([3]));
    timers.runAll();

    strictEqual(swfCalls.length, 2, 'made two appends');
    deepEqual(swfCalls.shift().arguments[0],
              [2],
              'contains the third byte');
    deepEqual(swfCalls.shift().arguments[0],
              [3],
              'contains the fourth byte');
    strictEqual(sourceBuffer.mediaSource.readyState,
                'open',
                'The streams should be open if more bytes are appended to an "ended" stream');
    strictEqual(timers.length, 0, 'no more appends are scheduled');
  });

  test('abort() clears any buffered input', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0]));
    sourceBuffer.abort();

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'called the swf');
    strictEqual(swfCalls[0], 'abort', 'invoked abort');
  });

  // requestAnimationFrame is heavily throttled or unscheduled when
  // the browser tab running contrib-media-sources is in a background
  // tab. If that happens, video data can continuously build up in
  // memory and cause the tab or browser to crash.
  test('does not use requestAnimationFrame', function() {
    var oldRFA = window.requestAnimationFrame, requests = 0, sourceBuffer;
    window.requestAnimationFrame = function() {
      requests++;
    };

    sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.appendBuffer(new Uint8Array([0, 1, 2, 3]));
    while (timers.length) {
      timers.pop()();
    }
    equal(requests, 0, 'no calls to requestAnimationFrame were made');
    window.requestAnimationFrame = oldRFA;
  });

  test('updating is true while an append is in progress', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'), ended = false;

    sourceBuffer.addEventListener('updateend', function() {
      ended = true;
    });

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    equal(sourceBuffer.updating, true, 'updating is set');

    while (!ended) {
      timers.pop()();
    }
    equal(sourceBuffer.updating, false, 'updating is unset');
  });

  test('throws an error if append is called while updating', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    throws(function() {
      sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    }, function(e) {
      return e.name === 'InvalidStateError' &&
        e.code === window.DOMException.INVALID_STATE_ERR;
    },'threw an InvalidStateError');
  });

  test('stops updating if abort is called', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'), updateEnds = 0;
    sourceBuffer.addEventListener('updateend', function() {
      updateEnds++;
    });
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    sourceBuffer.abort();
    equal(sourceBuffer.updating, false, 'no longer updating');
    equal(updateEnds, 1, 'triggered updateend');
  });

  test('forwards duration overrides to the SWF', function() {
    var ignored = mediaSource.duration;
    deepEqual(swfCalls[1], {
      attr: 'duration'
    }, 'requests duration from the SWF');

    mediaSource.duration = 101.3;
    // Setting a duration results in two calls to the swf
    // Ignore the first call (swfCalls[2]) as it was just to get the
    // current duration
    deepEqual(swfCalls[3], {
      attr: 'duration', value: 101.3
    }, 'set the duration override');

  });

  test('returns NaN for duration before the SWF is ready', function() {
    mediaSource.swfObj = undefined;

    ok(isNaN(mediaSource.duration), 'duration is NaN');
  });

  test('calculates the base PTS for the media', function() {
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
      tags_ = [];

    // seek to 15 seconds
    player.tech_.seeking = function() {
      return true;
    };
    player.tech_.currentTime = function() {
      return 15;
    };
    // FLV tags for this segment start at 10 seconds in the media
    // timeline
    tags_.push(
      // zero in the media timeline is PTS 3
      makeFlvTag((10 + 3) * 90000, new Uint8Array([10])),
      makeFlvTag((15 + 3) * 90000, new Uint8Array([15]))
    );

    sourceBuffer.segmentParser_.trigger('data', {
      tags: {
        videoTags: tags_,
        audioTags: []
      }
    });

    // let the source buffer know the segment start time
    sourceBuffer.timestampOffset = 10;

    swfCalls.length = 0;
    timers.runAll();

    equal(swfCalls.length, 1, 'made a SWF call');
    deepEqual(swfCalls[0].arguments[0], [15], 'dropped the early tag');
  });

  test('flushes the transmuxer after each append', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'), flushes = 0;
    sourceBuffer.segmentParser_.flush = function() {
      flushes++;
    };
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    timers.pop()();
    equal(flushes, 1, 'flushed the transmuxer');
  });

  test('remove fires update events', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        events = [];
    sourceBuffer.on(['update', 'updateend'], function(event) {
      events.push(event.type);
    });

    sourceBuffer.remove(0, 1);
    deepEqual(events, ['update', 'updateend'], 'fired update events');
    equal(sourceBuffer.updating, false, 'finished updating');
  });

  test('passes endOfStream network errors to the tech', function() {
    mediaSource.readyState = 'ended';
    mediaSource.endOfStream('network');
    equal(player.tech_.error().code, 2, 'set a network error');
  });

  test('passes endOfStream decode errors to the tech', function() {
    mediaSource.readyState = 'ended';
    mediaSource.endOfStream('decode');

    equal(player.tech_.error().code, 3, 'set a decode error');
  });

  test('has addSeekableRange()', function() {
    ok(mediaSource.addSeekableRange_, 'has addSeekableRange_');
  });

  module('createObjectURL', {
    setup: function() {
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource;

      // force MediaSource support
      if (!window.MediaSource) {
         window.MediaSource = function() {
           var result = new Blob();
           result.addEventListener = function() {};
           result.addSourceBuffer = function() {};
           return result;
         };
      }
    },
    teardown: function() {
      window.MediaSource = window.WebKitMediaSource = oldMediaSourceConstructor;
    }
  });

  test('delegates to the native implementation', function() {
    ok(!(/blob:vjs-media-source\//).test(videojs.URL.createObjectURL(new Blob())),
       'created a native blob URL');
  });

  test('uses the native MediaSource when available', function() {
    ok(!(/blob:vjs-media-source\//).test(videojs.URL.createObjectURL(new videojs.HtmlMediaSource())),
       'created a native blob URL');
  });

  test('emulates a URL for the shim', function() {
    ok((/blob:vjs-media-source\//).test(videojs.URL.createObjectURL(new videojs.FlashMediaSource())),
       'created an emulated blob URL');
  });

  test('stores the associated blob URL on the media source', function() {
    var blob = new Blob(),
        url = videojs.URL.createObjectURL(blob);

    equal(blob.url_, url, 'captured the generated URL');
  });

})(window, window.videojs, window.muxjs);
