(function(window, document, videojs) {
  'use strict';
  var player, video, mediaSource, oldSTO, oldCanPlay, Flash, oldFlashSupport, oldBPS,
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
      Flash = videojs.getComponent('Flash');
      oldFlashSupport = Flash.isSupported;
      oldCanPlay = Flash.canPlaySource;
      Flash.canPlaySource = Flash.isSupported = function() {
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
        },
        vjs_getProperty: function(attr) {
          swfCalls.push({ attr: attr });
        },
        vjs_setProperty: function(attr, value) {
          swfCalls.push({ attr: attr, value: value });
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
      Flash.isSupported = oldFlashSupport;
      Flash.canPlaySource = oldCanPlay;
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
      sourceBuffer = mediaSource.addSourceBuffer('video/flv');

    videojs.MediaSource.BYTES_PER_SECOND_GOAL = 60;

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
      sourceBuffer = mediaSource.addSourceBuffer('video/flv');

    videojs.MediaSource.BYTES_PER_SECOND_GOAL = 60;

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

  test('updating is true while an append is in progress', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv'), ended = false;

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
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv');
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    throws(function() {
      sourceBuffer.appendBuffer(new Uint8Array([0,1]));
    }, function(e) {
      return e.name === 'InvalidStateError' &&
        e.code === window.DOMException.INVALID_STATE_ERR;
    },'threw an InvalidStateError');
  });

  test('stops updating if abort is called', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/flv'), updateEnds = 0;
    sourceBuffer.addEventListener('updateend', function() {
      updateEnds++;
    });
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    sourceBuffer.abort();
    equal(sourceBuffer.updating, false, 'no longer updating');
    equal(updateEnds, 1, 'triggered updateend');
  });

  test('forwards duration overrides to the SWF', function() {
    mediaSource.duration();
    deepEqual(swfCalls[0], {
      attr: 'duration'
    }, 'requests duration from the SWF');

    mediaSource.duration(101.3);
    deepEqual(swfCalls[1], {
      attr: 'duration', value: 101.3
    }, 'set the duration override');

  });

  test('returns NaN for duration before the SWF is ready', function() {
    mediaSource.swfObj = undefined;

    ok(isNaN(mediaSource.duration()), 'duration is NaN');
  });

})(window, window.document, window.videojs);
