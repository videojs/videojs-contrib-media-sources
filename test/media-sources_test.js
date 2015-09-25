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
        window.setTimeout = function(callback) {
          timers.push(callback);
        };
        window.setTimeout.fake = true;
      },
      unfakeSTO = function() {
        timers = [];
        window.setTimeout = oldSTO;
      },
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
    window.MediaSource = videojs.extend(videojs.EventTarget, {});
    ok(new videojs.MediaSource({ mode: 'html5' }) instanceof window.MediaSource,
       'forced HTML5');

    // 'auto' should use native MediaSources when they're available
    ok(new videojs.MediaSource() instanceof window.MediaSource,
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
          var sourceBuffers = [];
          this.sourceBuffers = sourceBuffers;
          this.isNative = true;
          this.addSourceBuffer = function(type) {
            var buffer = new (videojs.extend(videojs.EventTarget, {
              type: type,
              appendBuffer: function() {}
            }))();
            sourceBuffers.push(buffer);
            return buffer;
          };
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
    ok(new videojs.MediaSource().isNative, 'constructed a MediaSource');
  });

  test('creates mp4 source buffers for mp2t segments', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    // send fake buffers through to cause the creation of the source buffers
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1).buffer
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });

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
    mediaSource.sourceBuffers[0].appendBuffer = function(segment) {
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
    equal(mediaSource.sourceBuffers[0].type,
          'video/mp4; codecs="avc1.64001f,mp4a.40.5"',
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
    equal(mediaSource.sourceBuffers[0].type,
          'video/mp4; codecs="avc1.64001f,mp4a.40.5"',
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
    equal(mediaSource.sourceBuffers[0].type,
          'video/mp4;codecs=avc1.4d400d, mp4a.40.2',
          'passed the codec along');
  });

  test('virtual buffers are updating if either native buffer is', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    // send fake buffers through to cause the creation of the source buffers
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1).buffer
        }
      }
    });

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

    // send fake buffers through to cause the creation of the source buffers
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1).buffer
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1).buffer
        }
      }
    });

    mediaSource.sourceBuffers[0].buffered = videojs.createTimeRanges([
      [0, 10],
      [20, 30]
    ]);
    mediaSource.sourceBuffers[1].buffered = videojs.createTimeRanges([
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

  test('sets native timestamp offsets on appends', function(){
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    sourceBuffer.timestampOffset = 42;

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1)
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1)
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'done'
      }
    });

    equal(mediaSource.sourceBuffers[0].timestampOffset, 42, 'set the first offset');
    equal(mediaSource.sourceBuffers[1].timestampOffset, 42, 'set the second offset');
  });

  test('aggregates source buffer update events', function() {
    var mediaSource = new videojs.MediaSource(),
        sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        updates = 0,
        updateends = 0,
        updatestarts = 0;

    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'audio',
          data: new Uint8Array(1)
        }
      }
    });
    sourceBuffer.transmuxer_.onmessage({
      data: {
        action: 'data',
        segment: {
          type: 'video',
          data: new Uint8Array(1)
        }
      }
    });

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

    equal(mediaSource.virtualBuffers.length,
          0,
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
      muxjs.SegmentParser = oldFlashTransmuxer;
      unfakeSTO();
    }
  });

  MockSegmentParser = function() {
    this.tags_ = [{
      bytes: new Uint8Array([0, 1])
    }];
    this.getFlvHeader = function() {
      return new Uint8Array([1, 2, 3]);
    };
    this.parseSegmentBinaryData = function(data) {};
    this.flushTags = function() {};
    this.tagsAvailable = function() {
      return this.tags_.length !== 0;
    };
    this.getNextTag = function() {
      return this.tags_.shift();
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
    timers.pop()();

    ok(swfCalls.length, 'the SWF was called');
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls[0].callee, 'vjs_appendBuffer', 'called appendBuffer');
    deepEqual(swfCalls[0].arguments[0],
              [0, 1],
              'passed the base64 encoded data');
  });

  test('splits appends that are bigger than the maximum configured size', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    swfCalls.length = 0;
    sourceBuffer.segmentParser_.tags_.length = 0;
    sourceBuffer.segmentParser_.tags_.push({
      bytes: new Uint8Array([0, 1])
    });
    sourceBuffer.appendBuffer(new Uint8Array([0]));

    timers.pop()();
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [0],
              'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [1],
              'contains the second byte');

    sourceBuffer.segmentParser_.tags_.push({
      bytes: new Uint8Array([2, 3])
    });
    sourceBuffer.appendBuffer(new Uint8Array([0]));

    timers.pop()();
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [2],
              'contains the third byte');

    timers.pop()();
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [3],
              'contains the fourth byte');

    strictEqual(timers.length, 0, 'no more appends are scheduled');
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

  test('drops tags before the target timestamp when seeking', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        i = 10,
        currentTime;
    mediaSource.tech_.currentTime = function() {
      return currentTime;
    };

    // push a tag into the buffer to establish the starting PTS value
    currentTime = 0;
    sourceBuffer.segmentParser_.tags_ = [{ pts: 19 * 1000, bytes: new Uint8Array(1) }];
    sourceBuffer.appendBuffer(new Uint8Array(10));
    timers.pop()();

    // mock out a new segment of FLV tags, starting 10s after the
    // starting PTS value
    while (i--) {
      sourceBuffer.segmentParser_.tags_.unshift({
        pts: (i * 1000) + (29 * 1000),
        bytes: new Uint8Array([i])
      });
    }

    // seek to 7 seconds into the new swegment
    mediaSource.tech_.seeking = function() {
      return true;
    };
    currentTime = 10 + 7;
    mediaSource.tech_.trigger('seeking');
    sourceBuffer.appendBuffer(new Uint8Array(10));
    swfCalls.length = 0;
    timers.pop()();

    deepEqual(swfCalls[0].arguments[0], [7, 8, 9],
              'three tags are appended');
  });

  test('seek targeting accounts for changing timestampOffsets', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'),
        i = 10,
        currentTime;
    mediaSource.tech_.currentTime = function() {
      return currentTime;
    };

    // push a tag into the buffer to establish the starting PTS value
    currentTime = 0;
    sourceBuffer.segmentParser_.tags_ = [{ pts: 19 * 1000, bytes: new Uint8Array(1) }];
    sourceBuffer.appendBuffer(new Uint8Array(10));
    timers.pop()();

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
      sourceBuffer.segmentParser_.tags_.unshift({
         // (101 * 1000) !== the old PTS offset
        pts: (i * 1000) + (101 * 1000),
        bytes: new Uint8Array([i + sourceBuffer.timestampOffset])
      });
    }

    mediaSource.tech_.trigger('seeking');
    sourceBuffer.appendBuffer(new Uint8Array(10));
    swfCalls.length = 0;
    timers.pop()();

    deepEqual(swfCalls[0].arguments[0],
              [26, 27, 28, 29, 30, 31],
              'filtered the appended tags');
  });

  test('calls endOfStream on the swf after the last append', function() {
    var
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    //ready state is ended when the last segment has been appended
    //to the mediaSource
    sourceBuffer.source.readyState = 'ended';

    timers.pop()();
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [0],
              'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 2, 'two calls should have been made');
    deepEqual(swfCalls.shift().arguments[0],
              [1],
              'the first call should contain the second byte');
    ok(swfCalls.shift().indexOf('endOfStream') === 0,
       'the second call should be for the updateend');

    strictEqual(timers.length, 0, 'no more appends are scheduled');
  });

  test('opens the stream on sourceBuffer.appendBuffer after endOfStream', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 60;

    mediaSource.swfObj.vjs_endOfStream = function() {
      swfCalls.push('endOfStream');
    };

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0,1]));

    //ready state is ended when the last segment has been appended
    //to the mediaSource
    sourceBuffer.source.readyState = 'ended';

    timers.pop()();
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [0],
              'contains the first byte');

    timers.pop()();
    strictEqual(swfCalls.length, 2, 'two calls should have been made');
    deepEqual(swfCalls.shift().arguments[0],
              [1],
              'the first call should contain the second byte');
    equal(swfCalls.shift(),
          'endOfStream',
          'the second call should be for the updateend');

    sourceBuffer.segmentParser_.tags_.push({
      bytes: new Uint8Array([2])
    });
    sourceBuffer.appendBuffer(new Uint8Array(1));

    timers.pop()();
    swfCalls = appendCalls(swfCalls);
    strictEqual(swfCalls.length, 1, 'made one append');
    deepEqual(swfCalls.pop().arguments[0],
              [2],
              'contains the third byte');
    strictEqual(sourceBuffer.source.readyState,
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
    deepEqual(swfCalls[2], {
      attr: 'duration', value: 101.3
    }, 'set the duration override');

  });

  test('returns NaN for duration before the SWF is ready', function() {
    mediaSource.swfObj = undefined;

    ok(isNaN(mediaSource.duration), 'duration is NaN');
  });

  test('calculates the base PTS for the media', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

    // seek to 15 seconds
    player.tech_.seeking = function() {
      return true;
    };
    player.tech_.currentTime = function() {
      return 15;
    };
    // FLV tags for this segment start at 10 seconds in the media
    // timeline
    sourceBuffer.segmentParser_.tags_.length = 0;
    sourceBuffer.segmentParser_.tags_.push({
      // zero in the media timeline is PTS 3
      pts: (10 + 3) * 90000,
      bytes: new Uint8Array([10])
    }, {
      pts: (15 + 3) * 90000,
      bytes: new Uint8Array([15])
    });
    // let the source buffer know the segment start time
    sourceBuffer.timestampOffset = 10;

    swfCalls.length = 0;
    sourceBuffer.appendBuffer(new Uint8Array([0, 1]));
    timers.pop()();

    equal(swfCalls.length, 1, 'made a SWF call');
    deepEqual(swfCalls[0].arguments[0], [15], 'dropped the early tag');
  });

  test('flushes the transmuxer after each append', function() {
    var sourceBuffer = mediaSource.addSourceBuffer('video/mp2t'), flushes = 0;
    sourceBuffer.segmentParser_.flushTags = function() {
      flushes++;
    };

    sourceBuffer.appendBuffer(new Uint8Array([0,1]));
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
    mediaSource.endOfStream('network');

    equal(player.tech_.error().code, 2, 'set a network error');
  });

  test('passes endOfStream decode errors to the tech', function() {
    mediaSource.endOfStream('decode');

    equal(player.tech_.error().code, 3, 'set a decode error');
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

  test('stores the associated blob URL on the media source', function() {
    var blob = new Blob(),
        url = videojs.URL.createObjectURL(blob);

    equal(blob.url_, url, 'captured the generated URL');
  });

})(window, window.videojs, window.muxjs);
