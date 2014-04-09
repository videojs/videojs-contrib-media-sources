(function(window, document, videojs) {
  'use strict';
  var player, video, mediaSource, oldRAF, oldCanPlay, oldFlashSupport,
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

      video = document.createElement('video');
      document.getElementById('qunit-fixture').appendChild(video);
      player = videojs(video);

      swfCalls = [];
      mediaSource = new videojs.MediaSource();
      mediaSource.swfObj = {
        CallFunction: function(xml) {
          swfCalls.push(xml);
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
        expected = window.btoa(String.fromCharCode(0) + String.fromCharCode(1));

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    timers.pop()();

    strictEqual(swfCalls.length, 1, 'the SWF was called');
    ok(swfCalls[0].indexOf(expected) > 0, 'contains the base64 encoded data');
  });
})(window, window.document, window.videojs);
