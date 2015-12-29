import document from 'global/document';

import QUnit from 'qunit';
import sinon from 'sinon';
import videojs from 'video.js';
import muxjs from 'mux.js';
import FlashMediaSource from '../src/flash-media-source';
import HtmlMediaSource from '../src/html-media-source';
import FlashSourceBuffer from '../src/flash-source-buffer';
import contribMediaSources from '../src/plugin.js';

const Player = videojs.getComponent('Player');

QUnit.module('videojs-contrib-media-sources - HTML', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.player = videojs(this.video);

    // Mock the environment's timers because certain things - particularly
    // player readiness - are asynchronous in video.js 5.
    this.clock = sinon.useFakeTimers();
    this.oldMediaSource = window.MediaSource || window.WebKitMediaSource;
    window.MediaSource = videojs.extend(videojs.EventTarget, {
      constructor(){
        this.isNative = true;
        this.sourceBuffers = [];
        this.duration = NaN;
      },
      addSourceBuffer(type) {
        var buffer = new (videojs.extend(videojs.EventTarget, {
          type: type,
          appendBuffer() {}
        }))();
        this.sourceBuffers.push(buffer);
        return buffer;
      }
    });
    window.WebKitMediaSource = window.MediaSource;
  },
  afterEach() {
    this.clock.restore();
    this.player.dispose();
    window.MediaSource = this.oldMediaSource;
    window.WebKitMediaSource = window.MediaSource;
  }
});


QUnit.test('constructs a native MediaSource', function(){
  ok(new this.player.contribMediaSources().mediaSource_.isNative, 'constructed a MediaSource');
});


// send fake data to the transmuxer to trigger the creation of the
// native source buffers
const initializeNativeSourceBuffers = function(sourceBuffer) {
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

QUnit.test('creates mp4 source buffers for mp2t segments', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('abort on the fake source buffer calls abort on the real ones', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('calling remove deletes cues and invokes remove on any extant source buffers', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('readyState delegates to the native implementation', function() {
  var mediaSource = new HtmlMediaSource();

  equal(mediaSource.readyState,
        mediaSource.mediaSource_.readyState,
        'readyStates are equal');

  mediaSource.mediaSource_.readyState = 'nonsense stuff';
  equal(mediaSource.readyState,
        mediaSource.mediaSource_.readyState,
        'readyStates are equal');
});

QUnit.test('addSeekableRange_ throws an error for media with known duration', function() {
  var mediaSource = new this.player.contribMediaSources();
  mediaSource.duration = 100;

  throws(function() {
    mediaSource.addSeekableRange_(0, 100);
  }, 'cannot add seekable range');
});

QUnit.test('addSeekableRange_ adds to the native MediaSource duration', function() {
  var mediaSource = new this.player.contribMediaSources();
  mediaSource.duration = Infinity;

  mediaSource.addSeekableRange_(120, 240);
  equal(mediaSource.mediaSource_.duration, 240, 'set native duration');
  equal(mediaSource.duration, Infinity, 'emulated duration');

  mediaSource.addSeekableRange_(120, 220);
  equal(mediaSource.mediaSource_.duration, 240, 'ignored the smaller range');
  equal(mediaSource.duration, Infinity, 'emulated duration');
});

QUnit.test('transmuxes mp2t segments', function(){
  var mp2tSegments = [], mp4Segments = [], data = new Uint8Array(1),
      mediaSource, sourceBuffer;
  mediaSource = new this.player.contribMediaSources();
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

QUnit.test('handles codec strings in reverse order', function() {
  var mediaSource = new this.player.contribMediaSources(),
      sourceBuffer = mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.5,avc1.64001f"');

  initializeNativeSourceBuffers(sourceBuffer);
  equal(mediaSource.mediaSource_.sourceBuffers[0].type,
        'audio/mp4;codecs="mp4a.40.5"',
        'passed the audio codec along');
  equal(mediaSource.mediaSource_.sourceBuffers[1].type,
        'video/mp4;codecs="avc1.64001f"',
        'passed the video codec along');
});

QUnit.test('forwards codec strings to native buffers when specified', function() {
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('parses old-school apple codec strings to the modern standard', function() {
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('specifies reasonable codecs if none are specified', function() {
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('virtual buffers are updating if either native buffer is', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('virtual buffers have a position buffered if both native buffers do', function() {
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('sets transmuxer baseMediaDecodeTime on appends', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('aggregates source buffer update events', function() {
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('translates caption events into WebVTT cues', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('translates metadata events into WebVTT cues', function(){
  var mediaSource = new this.player.contribMediaSources(),
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

QUnit.test('does not wrap mp4 source buffers', function(){
  var mediaSource = new this.player.contribMediaSources(),
      video = mediaSource.addSourceBuffer('video/mp4;codecs=avc1.4d400d'),
      audio = mediaSource.addSourceBuffer('audio/mp4;codecs=mp4a.40.2');

  equal(mediaSource.sourceBuffers.length,
        mediaSource.mediaSource_.sourceBuffers.length,
        'did not need virtual buffers');
  equal(mediaSource.sourceBuffers.length, 2, 'created native buffers');
});
