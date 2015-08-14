(function(window, videojs, muxjs) {
  'use strict';
  var player, video, mediaSource, Flash,
      oldFlashSupport, oldBPS, oldMediaSourceConstructor, oldSTO, oldCanPlay,
      swfCalls,
      timers,
      fakeSTO = function() {
        oldSTO = window.setTimeout;
        timers = [];
        window.setTimeout = function(callback) {
          timers.push(callback);
        };
      },
      unfakeSTO = function() {
        window.setTimeout = oldSTO;
      },
      oldFlashTransmuxer,
      MockSegmentParser;

  module('HTML MediaSource', {
    setup: function(){
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource,
      window.MediaSource = window.WebKitMediaSource = function(){
        var sourceBuffers = [];
        this.sourceBuffers = sourceBuffers;
        this.isNative = true;
        this.addSourceBuffer = function(type) {
          var buffer = new (videojs.extends(videojs.EventTarget, {
            type: type,
            appendBuffer: function() {}
          }))();
          sourceBuffers.push(buffer);
          return buffer;
        };
      };
    },
    teardown: function(){
      window.MediaSource = window.WebKitMediaSource = oldMediaSourceConstructor;
    }
  });

  test('constructs a native MediaSource', function(){
    ok(new videojs.MediaSource().isNative, 'constructed a MediaSource');
  });

  test('creates mp4 source buffers for mp2t segments', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    equal(mediaSource.sourceBuffers.length, 2, 'created two native buffers');
    equal(mediaSource.sourceBuffers[0].type,
          'audio/mp4;codecs=mp4a.40.2',
          'created an mp4a buffer');
    equal(mediaSource.sourceBuffers[1].type,
          'video/mp4;codecs=avc1.4d400d',
          'created an avc1 buffer');
    equal(mediaSource.virtualBuffers.length, 1, 'created one virtual buffer');
    equal(mediaSource.virtualBuffers[0],
          sourceBuffer,
          'returned the virtual buffer');
    ok(sourceBuffer.transmuxer_, 'created a transmuxer');
  });

  test('transmuxes mp2t segments', function(){
    var mp2tSegments = [], mp4Segments = [], data = new Uint8Array(1),
        mediaSource, sourceBuffer;
    mediaSource = new videojs.MediaSource();
    sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.transmuxer_.push = function(segment) {
        mp2tSegments.push(segment);
    };

    sourceBuffer.appendBuffer(data);
    equal(mp2tSegments.length, 1, 'transmuxed one segment');
    equal(mp2tSegments[0], data, 'did not alter the segment');

    mediaSource.sourceBuffers[1].appendBuffer = function(segment) {
      mp4Segments.push(segment);
    };
    // an init segment
    sourceBuffer.transmuxer_.trigger('data', {
      type: 'video',
      data: new Uint8Array(1)
    });
    // a media segment
    sourceBuffer.transmuxer_.trigger('data', {
      type: 'video',
      data: new Uint8Array(1)
    });
    equal(mp4Segments.length, 2, 'appended the segments');
  });

  test('virtual buffers are updating if either native buffer is', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    mediaSource.sourceBuffers[0].updating = true;
    mediaSource.sourceBuffers[1].updating = false;

    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.sourceBuffers[1].updating = true;
    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.sourceBuffers[0].updating = false;
    equal(sourceBuffer.updating, true, 'virtual buffer is updating');
    mediaSource.sourceBuffers[1].updating = false;
    equal(sourceBuffer.updating, false, 'virtual buffer is not updating');
  });

  test('virtual buffers have a position buffered if both native buffers do', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    mediaSource.sourceBuffers[0].buffered = videojs.createTimeRange(0, 10);
    mediaSource.sourceBuffers[1].buffered = videojs.createTimeRange(0, 7);

    equal(sourceBuffer.buffered.length, 1, 'one buffered range');
    equal(sourceBuffer.buffered.start(0), 0, 'starts at zero');
    equal(sourceBuffer.buffered.end(0), 7, 'ends at the latest shared time');
  });

  test('sets native timestamp offsets on appends', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.timestampOffset = 42;
    sourceBuffer.appendBuffer(new Uint8Array(1));
    sourceBuffer.transmuxer_.trigger('data', {
      type: 'audio',
      data: new Uint8Array(1)
    });sourceBuffer.transmuxer_.trigger('data', {
      type: 'video',
      data: new Uint8Array(1)
    });

    equal(mediaSource.sourceBuffers[0].timestampOffset, 42, 'set the first offset');
    equal(mediaSource.sourceBuffers[1].timestampOffset, 42, 'set the second offset');
  });

  test('does not wrap mp4 source buffers', function(){
    var mediaSource = new videojs.MediaSource(),
        video = mediaSource.addSourceBuffer('video/mp4;codecs=avc1.4d400d'),
        audio = mediaSource.addSourceBuffer('audio/mp4;codecs=mp4a.40.2');

    equal(mediaSource.virtualBuffers.length,
          0,
          'did not need virtual buffers');
    equal(mediaSource.sourceBuffers.length, 2, 'created native buffers');
  });

  module('Flash MediaSource', {
    setup: function() {
      oldMediaSourceConstructor = window.MediaSource || window.WebKitMediaSource,
      window.MediaSource = window.WebKitMediaSource = null;

      Flash = videojs.getComponent('Flash');
      oldFlashSupport = Flash.isSupported;
      oldCanPlay = Flash.canPlaySource;
      Flash.canPlaySource = Flash.isSupported = function() {
        return true;
      };

      oldBPS = videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL;
      oldFlashTransmuxer = muxjs.SegmentParser;
      muxjs.SegmentParser = MockSegmentParser;

      video = document.createElement('video');
      document.getElementById('qunit-fixture').appendChild(video);
      player = videojs(video);

      swfCalls = [];
      mediaSource = new videojs.MediaSource();
      player.src({
        src: videojs.URL.createObjectURL(mediaSource),
        type: "video/mp2t"
      });
      mediaSource.trigger('sourceopen');
      mediaSource.swfObj = {
        CallFunction: function(xml) {
          swfCalls.push(xml);
        },
        vjs_abort: function() {
          swfCalls.push('abort');
        },
        vjs_getProperty: function(attr) {
          swfCalls.push({ attr: attr });
        },
        vjs_setProperty: function(attr, value) {
          swfCalls.push({ attr: attr, value: value });
        },
        vjs_appendBuffer: function(flvHeader) {
          // only the FLV header directly invokes this so we can
          // ignore it
        }
      };

      fakeSTO();
    },
    teardown: function() {
      window.MediaSource = window.WebKitMediaSource = oldMediaSourceConstructor;
      Flash.isSupported = oldFlashSupport;
      Flash.canPlaySource = oldCanPlay;
      videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = oldBPS;
      muxjs.SegmentParser = oldFlashTransmuxer;
      unfakeSTO();
    }
  });

  MockSegmentParser = function() {
    var tags = [];
    this.getFlvHeader = function() {
      return new Uint8Array([1, 2, 3]);
    }
    this.parseSegmentBinaryData = function(data) {
      tags.push({
        bytes: data
      });
    };
    this.flushTags = function() {};
    this.tagsAvailable = function() {
      return tags.length !== 0;
    };
    this.getNextTag = function() {
      return tags.shift();
    }
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

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    strictEqual(swfCalls.length, 0, 'no SWF calls were made');
  });

  test('passes bytes to Flash', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        expected = '<invoke name="vjs_appendBuffer"' +
                   'returntype="javascript"><arguments><string>' +
                   window.btoa(String.fromCharCode(0, 1)) +
                   '</string></arguments></invoke>';

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    timers.pop()();

    strictEqual(swfCalls.length, 1, 'the SWF was called');
    strictEqual(swfCalls[0], expected, 'contains the base64 encoded data');
  });

  test('splits appends that are bigger than the maximum configured size', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(0))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(1))) > 0,
       'contains the second byte');

    sourceBuffer.appendBuffer(new Uint8Array([2,3]));

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(2))) > 0,
       'contains the third byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(3))) > 0,
       'contains the fourth byte');

    strictEqual(timers.length, 0, 'no more appends are scheduled');

  });

  test('calls endOfStream on the swf after the last append', function() {
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    //ready state is ended when the last segment has been appended
    //to the mediaSource
    sourceBuffer.source.readyState = 'ended';

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(0))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 2, 'two calls should have been made');
    ok(swfCalls.shift().indexOf(window.btoa(String.fromCharCode(1))) > 0,
       'the first call should contain the second byte');
    ok(swfCalls.shift().indexOf('endOfStream') === 0,
       'the second call should be for the updateend');

    strictEqual(timers.length, 0, 'no more appends are scheduled');
  });

  test('opens the stream on sourceBuffer.appendBuffer after endOfStream', function() {
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    //ready state is ended when the last segment has been appended
    //to the mediaSource
    sourceBuffer.source.readyState = 'ended';

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(0))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 2, 'two calls should have been made');
    ok(swfCalls.shift().indexOf(window.btoa(String.fromCharCode(1))) > 0,
       'the first call should contain the second byte');
    ok(swfCalls.shift().indexOf('endOfStream') === 0,
       'the second call should be for the updateend');

    sourceBuffer.appendBuffer(new Uint8Array([2]));

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(2))) > 0,
       'contains the third byte');
    strictEqual(sourceBuffer.source.readyState, 'open',
      'The streams should be open if more bytes are appended to an "ended" stream');
    strictEqual(timers.length, 0, 'no more appends are scheduled');
  });

  test('abort() clears any buffered input', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
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
    deepEqual(swfCalls[0], {
      attr: 'duration'
    }, 'requests duration from the SWF');

    mediaSource.duration = 101.3;
    deepEqual(swfCalls[1], {
      attr: 'duration', value: 101.3
    }, 'set the duration override');

  });

  test('returns NaN for duration before the SWF is ready', function() {
    mediaSource.swfObj = undefined;

    ok(isNaN(mediaSource.duration), 'duration is NaN');
  });

  module('createObjectURL');

  test('delegates to the native implementation', function() {
    ok(!(/blob:vjs-media-source\//).test(videojs.URL.createObjectURL(new Blob())),
       'created a native blob URL');
  });

  test('emulates a URL for the shim', function() {
    ok((/blob:vjs-media-source\//).test(videojs.URL.createObjectURL(new videojs.FlashMediaSource())),
       'created an emulated blob URL');
  });

})(window, window.videojs, window.muxjs);
