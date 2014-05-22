(function(window, document, videojs) {
  'use strict';
  var player, video, mediaSource, oldRAF, oldCanPlay, oldFlashSupport, oldMaxAppend,
      swfCalls,
      timers,
      fakeRAF = function() {
        oldRAF = window.requestAnimationFrame;
        timers = [];
        window.requestAnimationFrame = function(callback) {
          timers.push(callback);
        };
      },
      unfakeRAF = function() {
        window.requestAnimationFrame = oldRAF;
      };

  module('SourceBuffer', {
    setup: function() {
      oldFlashSupport = videojs.Flash.isSupported;
      oldCanPlay= videojs.Flash.canPlaySource;
      videojs.Flash.canPlaySource = videojs.Flash.isSupported = function() {
        return true;
      };

      oldMaxAppend = videojs.MediaSource.MAX_APPEND_SIZE;

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

      fakeRAF();
    },
    teardown: function() {
      videojs.Flash.isSupported = oldFlashSupport;
      videojs.Flash.canPlaySource = oldCanPlay;
      videojs.MediaSource.MAX_APPEND_SIZE = oldMaxAppend;
      unfakeRAF();
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
    videojs.MediaSource.MAX_APPEND_SIZE = 1;

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
})(window, window.document, window.videojs);
