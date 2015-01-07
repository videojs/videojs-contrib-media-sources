(function(window, document, videojs) {
  'use strict';
  var player, video, mediaSource, oldSTO, oldCanPlay, oldFlashSupport, oldBPS,
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
      };

  module('SourceBuffer', {
    setup: function() {
      oldFlashSupport = videojs.Flash.isSupported;
      oldCanPlay= videojs.Flash.canPlaySource;
      videojs.Flash.canPlaySource = videojs.Flash.isSupported = function() {
        return true;
      };

      oldBPS = videojs.MediaSource.BYTES_PER_SECOND_GOAL;

      video = document.createElement('video');
      document.getElementById('qunit-fixture').appendChild(video);
      player = videojs(video);

      swfCalls = [];
      mediaSource = new videojs.MediaSource();
      mediaSource.swfObj = {
        CallFunction: function(xml) {
          swfCalls.push(xml);
        },
        vjs_abort: function() {
          swfCalls.push('abort');
        }
      };
      player.src({
        src: videojs.URL.createObjectURL(mediaSource),
        type: "video/flv"
      });
      mediaSource.trigger('sourceopen');

      fakeSTO();
    },
    teardown: function() {
      videojs.Flash.isSupported = oldFlashSupport;
      videojs.Flash.canPlaySource = oldCanPlay;
      videojs.MediaSource.BYTES_PER_SECOND_GOAL = oldBPS;
      unfakeSTO();
    }
  });

  test('raises an exception for unrecognized MIME types', function() {
    try {
      mediaSource.addSourceBuffer('video/garbage');
    } catch(e) {
      ok(e, 'an error was thrown');
      return;
    }
    ok(false, 'no error was thrown');
  });

  test('creates SourceBuffers for video/flv', function() {
    ok(mediaSource.addSourceBuffer('video/flv'), 'create source buffer');
  });

  test('waits for the next frame to append', function() {
    mediaSource.addSourceBuffer('video/flv').appendBuffer(new Uint8Array([0,1]));
    strictEqual(swfCalls.length, 0, 'no SWF calls were made');
  });

  test('passes bytes to Flash', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv'),
        expected = '<invoke name="vjs_appendBuffer"' +
                   'returntype="javascript"><arguments><string>' +
                   window.btoa(String.fromCharCode(0) + String.fromCharCode(1)) +
                   '</string></arguments></invoke>';

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    timers.pop()();

    strictEqual(swfCalls.length, 1, 'the SWF was called');
    strictEqual(swfCalls[0], expected, 'contains the base64 encoded data');
  });

  test('splits appends that are bigger than the maximum configured size', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv');
    videojs.MediaSource.BYTES_PER_SECOND_GOAL = 60;

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    sourceBuffer.appendBuffer(new Uint8Array([2,3]));

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(0))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(1))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(2))) > 0,
       'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    ok(swfCalls.pop().indexOf(window.btoa(String.fromCharCode(3))) > 0,
       'contains the first byte');

    strictEqual(timers.length, 0, 'no more appends are scheduled');

  });

  test('abort() clears any buffered input', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv');
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

    sourceBuffer = mediaSource.addSourceBuffer('video/flv');
    sourceBuffer.appendBuffer(new Uint8Array([0, 1, 2, 3]));
    while (timers.length) {
      timers.pop()();
    }
    equal(requests, 0, 'no calls to requestAnimationFrame were made');
    window.requestAnimationFrame = oldRFA;
  });
})(window, window.document, window.videojs);
