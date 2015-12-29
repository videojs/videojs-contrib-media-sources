import document from 'global/document';

import QUnit from 'qunit';
import sinon from 'sinon';
import videojs from 'video.js';
import HtmlMediaSource from '../src/html-media-source';

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
      constructor() {
        this.isNative = true;
        this.sourceBuffers = [];
        this.duration = NaN;
      },
      addSourceBuffer(type) {
        let buffer = new (videojs.extend(videojs.EventTarget, {
          type,
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

QUnit.test('constructs a native MediaSource', function() {
  QUnit.ok(
    new this.player.MediaSource().mediaSource_.isNative,
    'constructed a MediaSource'
  );
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

QUnit.test('creates mp4 source buffers for mp2t segments', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.equal(
    mediaSource.mediaSource_.sourceBuffers.length,
    2,
    'created two native buffers'
  );
  QUnit.equal(
    mediaSource.mediaSource_.sourceBuffers[0].type,
    'audio/mp4;codecs="mp4a.40.2"',
    'created an mp4a buffer'
  );
  QUnit.equal(
    mediaSource.mediaSource_.sourceBuffers[1].type,
    'video/mp4;codecs="avc1.4d400d"',
    'created an avc1 buffer'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
  QUnit.ok(sourceBuffer.transmuxer_, 'created a transmuxer');
});

QUnit.test('abort on the fake source buffer calls abort on the real ones', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let messages = [];
  let aborts = 0;

  initializeNativeSourceBuffers(sourceBuffer);
  sourceBuffer.transmuxer_.postMessage = function(message) {
    messages.push(message);
  };
  sourceBuffer.bufferUpdating_ = true;
  mediaSource.mediaSource_.sourceBuffers[0].abort = function() {
    aborts++;
  };
  mediaSource.mediaSource_.sourceBuffers[1].abort = function() {
    aborts++;
  };

  sourceBuffer.abort();

  QUnit.equal(aborts, 2, 'called abort on both');
  QUnit.equal(
    sourceBuffer.bufferUpdating_,
    false,
    'set updating to false'
  );
  QUnit.equal(messages.length, 1, 'has one message');
  QUnit.equal(messages[0].action, 'reset', 'reset called on transmuxer');
});

QUnit.test(
'calling remove deletes cues and invokes remove on any extant source buffers',
function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let removedCue = [];
  let removes = 0;

  initializeNativeSourceBuffers(sourceBuffer);
  sourceBuffer.inbandTextTrack_ = {
    removeCue(cue) {
      removedCue.push(cue);
      this.cues.splice(this.cues.indexOf(cue), 1);
    },
    cues: [
      {startTime: 10, endTime: 20, text: 'delete me'},
      {startTime: 0, endTime: 2, text: 'save me'}
    ]
  };
  mediaSource.mediaSource_.sourceBuffers[0].remove = function(start, end) {
    if (start === 3 && end === 10) {
      removes++;
    }
  };
  mediaSource.mediaSource_.sourceBuffers[1].remove = function(start, end) {
    if (start === 3 && end === 10) {
      removes++;
    }
  };

  sourceBuffer.remove(3, 10);

  QUnit.equal(removes, 2, 'called remove on both sourceBuffers');
  QUnit.equal(
    sourceBuffer.inbandTextTrack_.cues.length,
    1,
    'one cue remains after remove'
  );
  QUnit.equal(
    removedCue[0].text,
    'delete me',
    'the cue that overlapped the remove region was removed'
  );
});

QUnit.test('readyState delegates to the native implementation', function() {
  let mediaSource = new HtmlMediaSource();

  QUnit.equal(
    mediaSource.readyState,
    mediaSource.mediaSource_.readyState,
    'readyStates are equal'
  );

  mediaSource.mediaSource_.readyState = 'nonsense stuff';
  QUnit.equal(
    mediaSource.readyState,
    mediaSource.mediaSource_.readyState,
    'readyStates are equal'
  );
});

QUnit.test('addSeekableRange_ throws an error for media with known duration', function() {
  let mediaSource = new this.player.MediaSource();

  mediaSource.duration = 100;
  QUnit.throws(function() {
    mediaSource.addSeekableRange_(0, 100);
  }, 'cannot add seekable range');
});

QUnit.test('addSeekableRange_ adds to the native MediaSource duration', function() {
  let mediaSource = new this.player.MediaSource();

  mediaSource.duration = Infinity;
  mediaSource.addSeekableRange_(120, 240);
  QUnit.equal(mediaSource.mediaSource_.duration, 240, 'set native duration');
  QUnit.equal(mediaSource.duration, Infinity, 'emulated duration');

  mediaSource.addSeekableRange_(120, 220);
  QUnit.equal(mediaSource.mediaSource_.duration, 240, 'ignored the smaller range');
  QUnit.equal(mediaSource.duration, Infinity, 'emulated duration');
});

QUnit.test('transmuxes mp2t segments', function() {
  let mp2tSegments = [];
  let mp4Segments = [];
  let data = new Uint8Array(1);
  let mediaSource;
  let sourceBuffer;

  mediaSource = new this.player.MediaSource();
  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  sourceBuffer.transmuxer_.postMessage = function(segment) {
    if (segment.action === 'push') {
      let buffer = new Uint8Array(segment.data);

      mp2tSegments.push(buffer);
    }
  };

  sourceBuffer.appendBuffer(data);
  QUnit.equal(mp2tSegments.length, 1, 'transmuxed one segment');
  QUnit.equal(mp2tSegments[0].length, 1, 'did not alter the segment');
  QUnit.equal(mp2tSegments[0][0], data[0], 'did not alter the segment');

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
  QUnit.equal(
    mp4Segments.length,
    0,
    'segments are not appended until after the `done` message'
  );

  // send `done` message
  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'done'
    }
  });

  // Segments are concatenated
  QUnit.equal(mp4Segments.length, 1, 'appended the segments');
});

QUnit.test('handles codec strings in reverse order', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.5,avc1.64001f"');

  initializeNativeSourceBuffers(sourceBuffer);
  QUnit.equal(
    mediaSource.mediaSource_.sourceBuffers[0].type,
    'audio/mp4;codecs="mp4a.40.5"',
    'passed the audio codec along'
  );
  QUnit.equal(
    mediaSource.mediaSource_.sourceBuffers[1].type,
    'video/mp4;codecs="avc1.64001f"',
    'passed the video codec along'
  );
});

QUnit.test('forwards codec strings to native buffers when specified', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.64001f,mp4a.40.5"');

  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'data',
      segment: {
        type: 'combined',
        data: new Uint8Array(1).buffer
      }
    }
  });
  QUnit.equal(mediaSource.mediaSource_.sourceBuffers[0].type,
              'video/mp4;codecs="avc1.64001f,mp4a.40.5"',
              'passed the codec along');
});

QUnit.test('parses old-school apple codec strings to the modern standard', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.100.31,mp4a.40.5"');

  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'data',
      segment: {
        type: 'combined',
        data: new Uint8Array(1).buffer
      }
    }
  });
  QUnit.equal(mediaSource.mediaSource_.sourceBuffers[0].type,
              'video/mp4;codecs="avc1.64001f,mp4a.40.5"',
              'passed the codec along');
});

QUnit.test('specifies reasonable codecs if none are specified', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'data',
      segment: {
        type: 'combined',
        data: new Uint8Array(1).buffer
      }
    }
  });
  QUnit.equal(mediaSource.mediaSource_.sourceBuffers[0].type,
              'video/mp4;codecs="avc1.4d400d,mp4a.40.2"',
              'passed the codec along');
});

QUnit.test('virtual buffers are updating if either native buffer is', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  mediaSource.mediaSource_.sourceBuffers[0].updating = true;
  mediaSource.mediaSource_.sourceBuffers[1].updating = false;

  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');
  mediaSource.mediaSource_.sourceBuffers[1].updating = true;
  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');
  mediaSource.mediaSource_.sourceBuffers[0].updating = false;
  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');
  mediaSource.mediaSource_.sourceBuffers[1].updating = false;
  QUnit.equal(sourceBuffer.updating, false, 'virtual buffer is not updating');
});

QUnit.test(
'virtual buffers have a position buffered if both native buffers do',
function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

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

  QUnit.equal(sourceBuffer.buffered.length, 2, 'two buffered ranges');
  QUnit.equal(sourceBuffer.buffered.start(0), 0, 'first starts at zero');
  QUnit.equal(sourceBuffer.buffered.end(0), 7, 'first ends at seven');
  QUnit.equal(sourceBuffer.buffered.start(1), 20, 'second starts at twenty');
  QUnit.equal(sourceBuffer.buffered.end(1), 30, 'second ends at 30');
});

QUnit.test('sets transmuxer baseMediaDecodeTime on appends', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let resets = [];

  sourceBuffer.transmuxer_.postMessage = function(message) {
    if (message.action === 'setTimestampOffset') {
      resets.push(message.timestampOffset);
    }
  };

  sourceBuffer.timestampOffset = 42;

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.equal(
    resets.length,
    1,
    'reset called'
  );
  QUnit.equal(
    resets[0],
    42,
    'set the baseMediaDecodeTime based on timestampOffset'
  );
});

QUnit.test('aggregates source buffer update events', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let updates = 0;
  let updateends = 0;
  let updatestarts = 0;

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

  QUnit.equal(updatestarts, 0, 'no updatestarts before a `done` message is received');
  QUnit.equal(updates, 0, 'no updates before a `done` message is received');
  QUnit.equal(updateends, 0, 'no updateends before a `done` message is received');

  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'done'
    }
  });

  // the video buffer begins updating first:
  sourceBuffer.videoBuffer_.updating = true;
  sourceBuffer.audioBuffer_.updating = false;
  sourceBuffer.videoBuffer_.trigger('updatestart');
  QUnit.equal(updatestarts, 1, 'aggregated updatestart');
  sourceBuffer.audioBuffer_.updating = true;
  sourceBuffer.audioBuffer_.trigger('updatestart');
  QUnit.equal(updatestarts, 1, 'aggregated updatestart');

  // the audio buffer finishes first:
  sourceBuffer.audioBuffer_.updating = false;
  sourceBuffer.videoBuffer_.updating = true;
  sourceBuffer.audioBuffer_.trigger('update');
  QUnit.equal(updates, 0, 'waited for the second update');
  sourceBuffer.videoBuffer_.updating = false;
  sourceBuffer.videoBuffer_.trigger('update');
  QUnit.equal(updates, 1, 'aggregated update');

  // audio finishes first:
  sourceBuffer.videoBuffer_.updating = true;
  sourceBuffer.audioBuffer_.updating = false;
  sourceBuffer.audioBuffer_.trigger('updateend');
  QUnit.equal(updateends, 0, 'waited for the second updateend');
  sourceBuffer.videoBuffer_.updating = false;
  sourceBuffer.videoBuffer_.trigger('updateend');
  QUnit.equal(updateends, 1, 'aggregated updateend');
});

QUnit.test('translates caption events into WebVTT cues', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let types = [];
  let cues = [];

  mediaSource.player_ = {
    addTextTrack(type) {
      types.push(type);
      return {
        addCue(cue) {
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

  QUnit.equal(types.length, 1, 'created one text track');
  QUnit.equal(types[0], 'captions', 'the type was captions');
  QUnit.equal(cues.length, 1, 'created one cue');
  QUnit.equal(cues[0].text, 'This is an in-band caption', 'included the text');
  QUnit.equal(cues[0].startTime, 11, 'started at eleven');
  QUnit.equal(cues[0].endTime, 13, 'ended at thirteen');
});

QUnit.test('translates metadata events into WebVTT cues', function() {
  let mediaSource = new this.player.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let types = [];
  let cues = [];
  let metadata = [{
    cueTime: 2,
    frames: [{
      url: 'This is a url tag'
    }, {
      value: 'This is a text tag'
    }]
  }, {
    cueTime: 12,
    frames: [{
      data: 'This is a priv tag'
    }]
  }];

  metadata.dispatchType = 0x10;
  mediaSource.player_ = {
    addTextTrack(type) {
      types.push(type);
      return {
        addCue(cue) {
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
        metadata
      }
    }
  });
  sourceBuffer.transmuxer_.onmessage({
    data: {
      action: 'done'
    }
  });

  QUnit.equal(
    sourceBuffer.metadataTrack_.inBandMetadataTrackDispatchType,
    16,
  'in-band metadata track dispatch type correctly set'
  );
  QUnit.equal(types.length, 1, 'created one text track');
  QUnit.equal(types[0], 'metadata', 'the type was metadata');
  QUnit.equal(cues.length, 3, 'created three cues');
  QUnit.equal(cues[0].text, 'This is a url tag', 'included the text');
  QUnit.equal(cues[0].startTime, 12, 'started at twelve');
  QUnit.equal(cues[0].endTime, 12, 'ended at twelve');
  QUnit.equal(cues[1].text, 'This is a text tag', 'included the text');
  QUnit.equal(cues[1].startTime, 12, 'started at twelve');
  QUnit.equal(cues[1].endTime, 12, 'ended at twelve');
  QUnit.equal(cues[2].text, 'This is a priv tag', 'included the text');
  QUnit.equal(cues[2].startTime, 22, 'started at twenty two');
  QUnit.equal(cues[2].endTime, 22, 'ended at twenty two');
});

QUnit.test('does not wrap mp4 source buffers', function() {
  let mediaSource = new this.player.MediaSource();

  mediaSource.addSourceBuffer('video/mp4;codecs=avc1.4d400d');
  mediaSource.addSourceBuffer('audio/mp4;codecs=mp4a.40.2');
  QUnit.equal(
    mediaSource.sourceBuffers.length,
    mediaSource.mediaSource_.sourceBuffers.length,
    'did not need virtual buffers'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 2, 'created native buffers');
});
