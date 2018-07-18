import document from 'global/document';
import window from 'global/window';
import QUnit from 'qunit';
import sinon from 'sinon';
import videojs from 'video.js';
import HtmlMediaSource from '../src/html-media-source';
import {
  WrappedSourceBuffer,
  gopsSafeToAlignWith,
  currentGOPStart,
  updateGopBuffer,
  removeGopBuffer
} from '../src/virtual-source-buffer';

// we disable this because browserify needs to include these files
// but the exports are not important
/* eslint-disable no-unused-vars */
import {MediaSource, URL} from '../src/videojs-contrib-media-sources.js';
/* eslint-disable no-unused-vars */

QUnit.module('videojs-contrib-media-sources - HTML', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.source = document.createElement('source');

    this.player = videojs(this.video);
    // add a fake source so that we can get this.player_ on sourceopen
    this.url = 'fake.ts';
    this.source.src = this.url;
    this.video.appendChild(this.source);

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
    window.MediaSource.isTypeSupported = function(mime) {
      return true;
    };
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
    new videojs.MediaSource().nativeMediaSource_.isNative,
    'constructed a MediaSource'
  );
});

const createDataMessage = function(type, typedArray, extraObject) {
  let message = {
    data: {
      action: 'data',
      segment: {
        type,
        data: typedArray.buffer,
        initSegment: {
          data: typedArray.buffer,
          byteOffset: typedArray.byteOffset,
          byteLength: typedArray.byteLength
        }
      },
      byteOffset: typedArray.byteOffset,
      byteLength: typedArray.byteLength
    }
  };

  return Object.keys(extraObject || {}).reduce(function(obj, key) {
    obj.data.segment[key] = extraObject[key];
    return obj;
  }, message);
};

// Create a WebWorker-style message that signals the transmuxer is done
const doneMessage = {
  data: {
    action: 'done'
  }
};

// send fake data to the transmuxer to trigger the creation of the
// native source buffers
const initializeNativeSourceBuffers = function(sourceBuffer) {
  // initialize an audio source buffer
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', new Uint8Array(1)));

  // initialize a video source buffer
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', new Uint8Array(1)));

  // instruct the transmuxer to flush the "data" it has buffered so
  // far
  sourceBuffer.transmuxer_.onmessage(doneMessage);
};

QUnit.test('creates mp4 source buffers for mp2t segments', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.4d400d"',
    'video buffer has the default codec'
  );

  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.2"',
    'audio buffer has the default codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
  QUnit.ok(sourceBuffer.transmuxer_, 'created a transmuxer');
});

QUnit.test(
'the terminate is called on the transmuxer when the media source is killed',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let terminates = 0;

  sourceBuffer.transmuxer_ = {
    terminate() {
      terminates++;
    }
  };

  mediaSource.trigger('sourceclose');

  QUnit.equal(terminates, 1, 'called terminate on transmux web worker');
});

QUnit.test('duration is faked when playing a live stream', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  mediaSource.duration = Infinity;
  mediaSource.nativeMediaSource_.duration = 100;
  QUnit.equal(mediaSource.nativeMediaSource_.duration, 100,
              'native duration was not set to infinity');
  QUnit.equal(mediaSource.duration, Infinity,
              'the MediaSource wrapper pretends it has an infinite duration');
});

QUnit.test(
'duration uses the underlying MediaSource\'s duration when not live', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  mediaSource.duration = 100;
  mediaSource.nativeMediaSource_.duration = 120;
  QUnit.equal(mediaSource.duration, 120,
              'the MediaSource wrapper returns the native duration');
});

QUnit.test('abort on the fake source buffer calls abort on the real ones', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let messages = [];
  let aborts = 0;

  initializeNativeSourceBuffers(sourceBuffer);

  sourceBuffer.transmuxer_.postMessage = function(message) {
    messages.push(message);
  };
  sourceBuffer.bufferUpdating_ = true;
  sourceBuffer.videoBuffer_.abort = function() {
    aborts++;
  };
  sourceBuffer.audioBuffer_.abort = function() {
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
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let removedCue = [];
  let removes = 0;

  initializeNativeSourceBuffers(sourceBuffer);

  sourceBuffer.inbandTextTracks_ = {
    CC1: {
      removeCue(cue) {
        removedCue.push(cue);
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
      cues: [
        {startTime: 10, endTime: 20, text: 'delete me'},
        {startTime: 0, endTime: 2, text: 'save me'}
      ]
    }
  };
  mediaSource.videoBuffer_.remove = function(start, end) {
    if (start === 10 && end === 20) {
      removes++;
    }
  };
  mediaSource.audioBuffer_.remove = function(start, end) {
    if (start === 10 && end === 20) {
      removes++;
    }
  };

  sourceBuffer.remove(10, 20);

  QUnit.equal(removes, 2, 'called remove on both sourceBuffers');
  QUnit.equal(
    sourceBuffer.inbandTextTracks_.CC1.cues.length,
    1,
    'one cue remains after remove'
  );
  QUnit.equal(
    removedCue[0].text,
    'delete me',
    'the cue contained within the remove region was removed'
  );
});

QUnit.test(
'calling remove property handles absence of cues (null)',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  sourceBuffer.inbandTextTracks_ = {
    CC1: {
      cues: null
    }
  };

  mediaSource.videoBuffer_.remove = function(start, end) {
    // pass
  };
  mediaSource.audioBuffer_.remove = function(start, end) {
    // pass
  };

  // this call should not raise an exception
  sourceBuffer.remove(3, 10);

  QUnit.equal(
    sourceBuffer.inbandTextTracks_.CC1.cues,
    null,
    'cues are still null'
  );
});

QUnit.test('removing doesn\'t happen with audio disabled', function() {
  let mediaSource = new videojs.MediaSource();
  let muxedBuffer = mediaSource.addSourceBuffer('video/mp2t');
  // creating this audio buffer disables audio in the muxed one
  let audioBuffer = mediaSource.addSourceBuffer('audio/mp2t; codecs="mp4a.40.2"');
  let removedCue = [];
  let removes = 0;

  initializeNativeSourceBuffers(muxedBuffer);

  muxedBuffer.inbandTextTracks_ = {
    CC1: {
      removeCue(cue) {
        removedCue.push(cue);
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
      cues: [
        {startTime: 10, endTime: 20, text: 'delete me'},
        {startTime: 0, endTime: 2, text: 'save me'}
      ]
    }
  };
  mediaSource.videoBuffer_.remove = function(start, end) {
    if (start === 10 && end === 20) {
      removes++;
    }
  };
  mediaSource.audioBuffer_.remove = function(start, end) {
    if (start === 10 && end === 20) {
      removes++;
    }
  };

  muxedBuffer.remove(10, 20);

  QUnit.equal(removes, 1, 'called remove on only one source buffer');
  QUnit.equal(muxedBuffer.inbandTextTracks_.CC1.cues.length,
              1,
              'one cue remains after remove');
  QUnit.equal(removedCue[0].text,
              'delete me',
              'the cue contained within the remove region was removed');
});

QUnit.test('readyState delegates to the native implementation', function() {
  let mediaSource = new HtmlMediaSource();

  QUnit.equal(
    mediaSource.readyState,
    mediaSource.nativeMediaSource_.readyState,
    'readyStates are equal'
  );

  mediaSource.nativeMediaSource_.readyState = 'nonsense stuff';
  QUnit.equal(
    mediaSource.readyState,
    mediaSource.nativeMediaSource_.readyState,
    'readyStates are equal'
  );
});

QUnit.test('addSeekableRange_ throws an error for media with known duration', function() {
  let mediaSource = new videojs.MediaSource();

  mediaSource.duration = 100;
  QUnit.throws(function() {
    mediaSource.addSeekableRange_(0, 100);
  }, 'cannot add seekable range');
});

QUnit.test('addSeekableRange_ adds to the native MediaSource duration', function() {
  let mediaSource = new videojs.MediaSource();

  mediaSource.duration = Infinity;
  mediaSource.addSeekableRange_(120, 240);
  QUnit.equal(mediaSource.nativeMediaSource_.duration, 240, 'set native duration');
  QUnit.equal(mediaSource.duration, Infinity, 'emulated duration');

  mediaSource.addSeekableRange_(120, 220);
  QUnit.equal(mediaSource.nativeMediaSource_.duration, 240, 'ignored the smaller range');
  QUnit.equal(mediaSource.duration, Infinity, 'emulated duration');
});

QUnit.test('appendBuffer error triggers on the player', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let error = false;

  mediaSource.player_ = this.player;

  initializeNativeSourceBuffers(sourceBuffer);

  sourceBuffer.videoBuffer_.appendBuffer = () => {
    QUnit.equal(sourceBuffer.videoBuffer_.updating, true,
      'updating is true before error');
    throw new Error();
  };

  sourceBuffer.on('bufferMaxed', (event) => {
    QUnit.equal(event.target, sourceBuffer.videoBuffer_,
      'target of bufferMaxed event is (wrapped) buffer that exceeded quota');
  });
  // send fake data to the source buffer from the transmuxer to append to native buffer
  // initializeNativeSourceBuffers does the same thing to trigger the creation of
  // native source buffers.
  let fakeTransmuxerMessage = initializeNativeSourceBuffers;

  fakeTransmuxerMessage(sourceBuffer);

  this.clock.tick(1);
});

QUnit.test('transmuxes mp2t segments', function() {
  let mp2tSegments = [];
  let mp4Segments = [];
  let data = new Uint8Array(1);
  let mediaSource;
  let sourceBuffer;

  mediaSource = new videojs.MediaSource();
  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  sourceBuffer.transmuxer_.postMessage = function(segment) {
    if (segment.action === 'push') {
      let buffer = new Uint8Array(segment.data, segment.byteOffset, segment.byteLength);

      mp2tSegments.push(buffer);
    }
  };

  sourceBuffer.concatAndAppendSegments_ = function(segmentObj, destinationBuffer) {
    mp4Segments.push(segmentObj);
  };

  sourceBuffer.appendBuffer(data);
  QUnit.equal(mp2tSegments.length, 1, 'transmuxed one segment');
  QUnit.equal(mp2tSegments[0].length, 1, 'did not alter the segment');
  QUnit.equal(mp2tSegments[0][0], data[0], 'did not alter the segment');

  // an init segment
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', new Uint8Array(1)));

  // a media segment
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', new Uint8Array(1)));

  // Segments are concatenated
  QUnit.equal(
    mp4Segments.length,
    0,
    'segments are not appended until after the `done` message'
  );

  // send `done` message
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  // Segments are concatenated
  QUnit.equal(mp4Segments.length, 2, 'appended the segments');
});

QUnit.test(
'handles typed-arrays that are subsets of their underlying buffer',
function() {
  let mp2tSegments = [];
  let mp4Segments = [];
  let dataBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let data = dataBuffer.subarray(5, 7);
  let mediaSource;
  let sourceBuffer;

  mediaSource = new videojs.MediaSource();
  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  sourceBuffer.transmuxer_.postMessage = function(segment) {
    if (segment.action === 'push') {
      let buffer = new Uint8Array(segment.data, segment.byteOffset, segment.byteLength);

      mp2tSegments.push(buffer);
    }
  };

  sourceBuffer.concatAndAppendSegments_ = function(segmentObj, destinationBuffer) {
    mp4Segments.push(segmentObj.segments[0]);
  };

  sourceBuffer.appendBuffer(data);

  QUnit.equal(mp2tSegments.length, 1, 'emitted the fragment');
  QUnit.equal(
    mp2tSegments[0].length,
    2,
    'correctly handled a typed-array that is a subset'
  );
  QUnit.equal(mp2tSegments[0][0], 5, 'fragment contains the correct first byte');
  QUnit.equal(mp2tSegments[0][1], 6, 'fragment contains the correct second byte');

  // an init segment
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', data));

  // Segments are concatenated
  QUnit.equal(
    mp4Segments.length,
    0,
    'segments are not appended until after the `done` message'
  );

  // send `done` message
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  // Segments are concatenated
  QUnit.equal(mp4Segments.length, 1, 'emitted the fragment');
  QUnit.equal(
    mp4Segments[0].length,
    2,
    'correctly handled a typed-array that is a subset'
  );
  QUnit.equal(mp4Segments[0][0], 5, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[0][1], 6, 'fragment contains the correct second byte');
});

QUnit.test(
'only appends audio init segment for first segment or on audio/media changes',
function() {
  let mp4Segments = [];
  let initBuffer = new Uint8Array([0, 1]);
  let dataBuffer = new Uint8Array([2, 3]);
  let mediaSource;
  let sourceBuffer;

  mediaSource = new videojs.MediaSource();
  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  sourceBuffer.audioDisabled_ = false;
  mediaSource.player_ = this.player;
  mediaSource.url_ = this.url;
  mediaSource.trigger('sourceopen');

  sourceBuffer.concatAndAppendSegments_ = function(segmentObj, destinationBuffer) {
    let segment = segmentObj.segments.reduce((seg, arr) => seg.concat(Array.from(arr)),
      []);

    mp4Segments.push(segment);
  };

  QUnit.ok(sourceBuffer.appendAudioInitSegment_, 'will append init segment next');

  // an init segment
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));

  // Segments are concatenated
  QUnit.equal(
    mp4Segments.length,
    0,
    'segments are not appended until after the `done` message'
  );

  // send `done` message
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  // Segments are concatenated
  QUnit.equal(mp4Segments.length, 1, 'emitted the fragment');
  // Contains init segment on first segment
  QUnit.equal(mp4Segments[0][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[0][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[0][2], 2, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[0][3], 3, 'fragment contains the correct fourth byte');
  QUnit.ok(!sourceBuffer.appendAudioInitSegment_, 'will not append init segment next');

  dataBuffer = new Uint8Array([4, 5]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 2, 'emitted the fragment');
  // does not contain init segment on next segment
  QUnit.equal(mp4Segments[1][0], 4, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[1][1], 5, 'fragment contains the correct second byte');

  // audio track change
  this.player.audioTracks().trigger('change');
  sourceBuffer.audioDisabled_ = false;
  QUnit.ok(sourceBuffer.appendAudioInitSegment_, 'audio change sets appendAudioInitSegment_');
  dataBuffer = new Uint8Array([6, 7]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 3, 'emitted the fragment');
  // contains init segment after audio track change
  QUnit.equal(mp4Segments[2][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[2][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[2][2], 6, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[2][3], 7, 'fragment contains the correct fourth byte');
  QUnit.ok(!sourceBuffer.appendAudioInitSegment_, 'will not append init segment next');

  dataBuffer = new Uint8Array([8, 9]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 4, 'emitted the fragment');
  // does not contain init segment in next segment
  QUnit.equal(mp4Segments[3][0], 8, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[3][1], 9, 'fragment contains the correct second byte');
  QUnit.ok(!sourceBuffer.appendAudioInitSegment_, 'will not append init segment next');

  // rendition switch
  this.player.trigger('mediachange');
  QUnit.ok(sourceBuffer.appendAudioInitSegment_, 'media change sets appendAudioInitSegment_');
  dataBuffer = new Uint8Array([10, 11]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 5, 'emitted the fragment');
  // contains init segment after audio track change
  QUnit.equal(mp4Segments[4][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[4][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[4][2], 10, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[4][3], 11, 'fragment contains the correct fourth byte');
  QUnit.ok(!sourceBuffer.appendAudioInitSegment_, 'will not append init segment next');
});

QUnit.test(
'appends video init segment for every segment',
function() {
  let mp4Segments = [];
  let initBuffer = new Uint8Array([0, 1]);
  let dataBuffer = new Uint8Array([2, 3]);
  let mediaSource;
  let sourceBuffer;

  mediaSource = new videojs.MediaSource();
  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  mediaSource.player_ = this.player;
  mediaSource.url_ = this.url;
  mediaSource.trigger('sourceopen');

  sourceBuffer.concatAndAppendSegments_ = function(segmentObj, destinationBuffer) {
    let segment = segmentObj.segments.reduce((seg, arr) => seg.concat(Array.from(arr)),
      []);

    mp4Segments.push(segment);
  };

  // an init segment
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));

  // Segments are concatenated
  QUnit.equal(
    mp4Segments.length,
    0,
    'segments are not appended until after the `done` message'
  );

  // send `done` message
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  // Segments are concatenated
  QUnit.equal(mp4Segments.length, 1, 'emitted the fragment');
  // Contains init segment on first segment
  QUnit.equal(mp4Segments[0][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[0][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[0][2], 2, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[0][3], 3, 'fragment contains the correct fourth byte');

  dataBuffer = new Uint8Array([4, 5]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 2, 'emitted the fragment');
  QUnit.equal(mp4Segments[1][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[1][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[1][2], 4, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[1][3], 5, 'fragment contains the correct fourth byte');

  dataBuffer = new Uint8Array([6, 7]);
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', dataBuffer, {
    initSegment: {
      data: initBuffer.buffer,
      byteOffset: initBuffer.byteOffset,
      byteLength: initBuffer.byteLength
    }
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  QUnit.equal(mp4Segments.length, 3, 'emitted the fragment');
  // contains init segment after audio track change
  QUnit.equal(mp4Segments[2][0], 0, 'fragment contains the correct first byte');
  QUnit.equal(mp4Segments[2][1], 1, 'fragment contains the correct second byte');
  QUnit.equal(mp4Segments[2][2], 6, 'fragment contains the correct third byte');
  QUnit.equal(mp4Segments[2][3], 7, 'fragment contains the correct fourth byte');
});

QUnit.test('handles empty codec string value', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs=""');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.4d400d"',
    'video buffer has the default codec'
  );

  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.2"',
    'audio buffer has the default codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
});

QUnit.test('can create an audio buffer by itself', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.2"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(!mediaSource.videoBuffer_, 'did not create a video buffer');
  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.2"',
    'audio buffer has the default codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
});

QUnit.test('can create an video buffer by itself', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.4d400d"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(!mediaSource.audioBuffer_, 'did not create an audio buffer');
  QUnit.ok(mediaSource.videoBuffer_, 'created an video buffer');
  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.4d400d"',
    'video buffer has the codec that was passed'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
});

QUnit.test('handles invalid codec string', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="nope"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.4d400d"',
    'video buffer has the default codec'
  );

  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.2"',
    'audio buffer has the default codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
});

QUnit.test('handles codec strings in reverse order', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.5,avc1.64001f"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');

  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.64001f"',
    'video buffer has the passed codec'
  );

  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.5"',
    'audio buffer has the passed codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 1, 'created one virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer'
  );
  QUnit.ok(sourceBuffer.transmuxer_, 'created a transmuxer');
});

QUnit.test('forwards codec strings to native buffers when specified', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.64001f,mp4a.40.5"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.videoBuffer_.type,
              'video/mp4;codecs="avc1.64001f"',
              'passed the video codec along');

  QUnit.ok(mediaSource.audioBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.audioBuffer_.type,
              'audio/mp4;codecs="mp4a.40.5"',
              'passed the audio codec along');
});

QUnit.test('parses old-school apple codec strings to the modern standard', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.100.31,mp4a.40.5"');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.videoBuffer_.type,
              'video/mp4;codecs="avc1.64001f"',
              'passed the video codec along');

  QUnit.ok(mediaSource.audioBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.audioBuffer_.type,
              'audio/mp4;codecs="mp4a.40.5"',
              'passed the audio codec along');

});

QUnit.test('specifies reasonable codecs if none are specified', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.videoBuffer_.type,
              'video/mp4;codecs="avc1.4d400d"',
              'passed the video codec along');

  QUnit.ok(mediaSource.audioBuffer_, 'created a video buffer');
  QUnit.equal(mediaSource.audioBuffer_.type,
              'audio/mp4;codecs="mp4a.40.2"',
              'passed the audio codec along');
});

QUnit.test('virtual buffers are updating if either native buffer is', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  mediaSource.videoBuffer_.updating = true;
  mediaSource.audioBuffer_.updating = false;
  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');

  mediaSource.audioBuffer_.updating = true;
  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');

  mediaSource.videoBuffer_.updating = false;
  QUnit.equal(sourceBuffer.updating, true, 'virtual buffer is updating');

  mediaSource.audioBuffer_.updating = false;
  QUnit.equal(sourceBuffer.updating, false, 'virtual buffer is not updating');
});

QUnit.test(
'virtual buffers have a position buffered if both native buffers do',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  initializeNativeSourceBuffers(sourceBuffer);

  mediaSource.videoBuffer_.buffered = videojs.createTimeRanges([
    [0, 10],
    [20, 30]
  ]);
  mediaSource.audioBuffer_.buffered = videojs.createTimeRanges([
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

QUnit.test('disabled audio does not affect buffered property', function() {
  let mediaSource = new videojs.MediaSource();
  let muxedBuffer = mediaSource.addSourceBuffer('video/mp2t');
  // creating a separate audio buffer disables audio on the muxed one
  let audioBuffer = mediaSource.addSourceBuffer('audio/mp2t; codecs="mp4a.40.2"');

  initializeNativeSourceBuffers(muxedBuffer);

  mediaSource.videoBuffer_.buffered = videojs.createTimeRanges([[1, 10]]);
  mediaSource.audioBuffer_.buffered = videojs.createTimeRanges([[2, 11]]);

  QUnit.equal(audioBuffer.buffered.length, 1, 'one buffered range');
  QUnit.equal(audioBuffer.buffered.start(0), 2, 'starts at two');
  QUnit.equal(audioBuffer.buffered.end(0), 11, 'ends at eleven');
  QUnit.equal(muxedBuffer.buffered.length, 1, 'one buffered range');
  QUnit.equal(muxedBuffer.buffered.start(0), 1, 'starts at one');
  QUnit.equal(muxedBuffer.buffered.end(0), 10, 'ends at ten');
});

QUnit.test('sets transmuxer baseMediaDecodeTime on appends', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let resets = [];

  sourceBuffer.transmuxer_.postMessage = function(message) {
    if (message.action === 'setTimestampOffset') {
      resets.push(message.timestampOffset);
    }
  };

  sourceBuffer.timestampOffset = 42;

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
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let updates = 0;
  let updateends = 0;
  let updatestarts = 0;

  initializeNativeSourceBuffers(sourceBuffer);

  mediaSource.player_ = this.player;

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
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let types = [];
  let hls608 = 0;

  mediaSource.player_ = {
    addRemoteTextTrack(options) {
      types.push(options.kind);
      return {
        track: {
          kind: options.kind,
          label: options.label,
          cues: [],
          addCue(cue) {
            this.cues.push(cue);
          }
        }
      };
    },
    textTracks() {
      return {
        getTrackById() {}
      };
    },
    remoteTextTracks() {
    },
    tech_: new videojs.EventTarget()
  };
  mediaSource.player_.tech_.on('usage', (event) => {
    if (event.name === 'hls-608') {
      hls608++;
    }
  });
  sourceBuffer.timestampOffset = 10;
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', new Uint8Array(1), {
    captions: [{
      startTime: 1,
      endTime: 3,
      text: 'This is an in-band caption in CC1',
      stream: 'CC1'
    }],
    captionStreams: {CC1: true}
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);
  let cues = sourceBuffer.inbandTextTracks_.CC1.cues;

  QUnit.equal(hls608, 1, 'one hls-608 event was triggered');
  QUnit.equal(types.length, 1, 'created one text track');
  QUnit.equal(types[0], 'captions', 'the type was captions');
  QUnit.equal(cues.length, 1, 'created one cue');
  QUnit.equal(cues[0].text, 'This is an in-band caption in CC1', 'included the text');
  QUnit.equal(cues[0].startTime, 11, 'started at eleven');
  QUnit.equal(cues[0].endTime, 13, 'ended at thirteen');
});

QUnit.test('captions use existing tracks with id equal to CC#', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let addTrackCalled = 0;
  let tracks = {
    CC1: {
      kind: 'captions',
      label: 'CC1',
      id: 'CC1',
      cues: [],
      addCue(cue) {
        this.cues.push(cue);
      }
    },
    CC2: {
      kind: 'captions',
      label: 'CC2',
      id: 'CC2',
      cues: [],
      addCue(cue) {
        this.cues.push(cue);
      }
    }
  };

  mediaSource.player_ = {
    addRemoteTextTrack(options) {
      addTrackCalled++;
    },
    textTracks() {
      return {
        getTrackById(id) {
          return tracks[id];
        }
      };
    },
    remoteTextTracks() {
    },
    tech_: new videojs.EventTarget()
  };
  sourceBuffer.timestampOffset = 10;
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', new Uint8Array(1), {
    captions: [{
      stream: 'CC1',
      startTime: 1,
      endTime: 3,
      text: 'This is an in-band caption in CC1'
    }, {
      stream: 'CC2',
      startTime: 1,
      endTime: 3,
      text: 'This is an in-band caption in CC2'
    }],
    captionStreams: {CC1: true, CC2: true}
  }));

  sourceBuffer.transmuxer_.onmessage(doneMessage);
  let cues = sourceBuffer.inbandTextTracks_.CC1.cues;

  QUnit.equal(addTrackCalled, 0, 'no tracks were created');
  QUnit.equal(tracks.CC1.cues.length, 1, 'CC1 contains 1 cue');
  QUnit.equal(tracks.CC2.cues.length, 1, 'CC2 contains 1 cue');

  QUnit.equal(tracks.CC1.cues[0].text, 'This is an in-band caption in CC1', 'CC1 contains the right cue');
  QUnit.equal(tracks.CC2.cues[0].text, 'This is an in-band caption in CC2', 'CC2 contains the right cue');
});

QUnit.test('translates metadata events into WebVTT cues', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');

  mediaSource.duration = Infinity;
  mediaSource.nativeMediaSource_.duration = 60;

  let types = [];
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
    addRemoteTextTrack(options) {
      types.push(options.kind);
      return {
        track: {
          kind: options.kind,
          label: options.label,
          cues: [],
          addCue(cue) {
            this.cues.push(cue);
          }
        }
      };
    },
    remoteTextTracks() {
    }
  };
  sourceBuffer.timestampOffset = 10;

  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', new Uint8Array(1), {
    metadata
  }));
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  QUnit.equal(
    sourceBuffer.metadataTrack_.inBandMetadataTrackDispatchType,
    16,
  'in-band metadata track dispatch type correctly set'
  );
  let cues = sourceBuffer.metadataTrack_.cues;

  QUnit.equal(types.length, 1, 'created one text track');
  QUnit.equal(types[0], 'metadata', 'the type was metadata');
  QUnit.equal(cues.length, 3, 'created three cues');
  QUnit.equal(cues[0].text, 'This is a url tag', 'included the text');
  QUnit.equal(cues[0].startTime, 12, 'started at twelve');
  QUnit.equal(cues[0].endTime, 22, 'ended at StartTime of next cue(22)');
  QUnit.equal(cues[1].text, 'This is a text tag', 'included the text');
  QUnit.equal(cues[1].startTime, 12, 'started at twelve');
  QUnit.equal(cues[1].endTime, 22, 'ended at the startTime of next cue(22)');
  QUnit.equal(cues[2].text, 'This is a priv tag', 'included the text');
  QUnit.equal(cues[2].startTime, 22, 'started at twenty two');
  QUnit.equal(cues[2].endTime, Number.MAX_VALUE, 'ended at the maximum value');
  mediaSource.duration = 100;
  mediaSource.trigger('sourceended');
  QUnit.equal(cues[2].endTime, mediaSource.duration, 'sourceended is fired');
});

QUnit.test('does not wrap mp4 source buffers', function() {
  let mediaSource = new videojs.MediaSource();

  mediaSource.addSourceBuffer('video/mp4;codecs=avc1.4d400d');
  mediaSource.addSourceBuffer('audio/mp4;codecs=mp4a.40.2');
  QUnit.equal(
    mediaSource.sourceBuffers.length,
    mediaSource.nativeMediaSource_.sourceBuffers.length,
    'did not need virtual buffers'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 2, 'created native buffers');
});

QUnit.test('can get activeSourceBuffers', function() {
  let mediaSource = new videojs.MediaSource();

  // although activeSourceBuffers should technically be a SourceBufferList, we are
  // returning it as an array, and users may expect it to behave as such
  QUnit.ok(Array.isArray(mediaSource.activeSourceBuffers));
});

QUnit.test('active source buffers are updated on each buffer\'s updateend',
function() {
  let mediaSource = new videojs.MediaSource();
  let updateCallCount = 0;
  let sourceBuffer;

  mediaSource.updateActiveSourceBuffers_ = () => {
    updateCallCount++;
  };

  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  mediaSource.player_ = this.player;
  mediaSource.url_ = this.url;
  mediaSource.trigger('sourceopen');
  QUnit.equal(updateCallCount, 0,
              'active source buffers not updated on adding source buffer');

  mediaSource.player_.audioTracks().trigger('addtrack');
  QUnit.equal(updateCallCount, 1,
              'active source buffers updated after addtrack');

  sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  QUnit.equal(updateCallCount, 1,
              'active source buffers not updated on adding second source buffer');

  mediaSource.player_.audioTracks().trigger('removetrack');
  QUnit.equal(updateCallCount, 2,
              'active source buffers updated after removetrack');

  mediaSource.player_.audioTracks().trigger('change');
  QUnit.equal(updateCallCount, 3,
              'active source buffers updated after change');

});

QUnit.test('combined buffer is the only active buffer when main track enabled',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBufferAudio;
  let sourceBufferCombined;
  let audioTracks = [{
    enabled: true,
    kind: 'main',
    label: 'main'
  }, {
    enabled: false,
    kind: 'alternative',
    label: 'English (UK)'
  }];

  this.player.audioTracks = () => audioTracks;

  mediaSource.player_ = this.player;

  sourceBufferCombined = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferCombined.videoCodec_ = true;
  sourceBufferCombined.audioCodec_ = true;
  sourceBufferAudio = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferAudio.videoCodec_ = false;
  sourceBufferAudio.audioCodec_ = true;

  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 1,
    'active source buffers starts with one source buffer');
  QUnit.equal(mediaSource.activeSourceBuffers[0], sourceBufferCombined,
    'active source buffers starts with combined source buffer');
});

QUnit.test('combined & audio buffers are active when alternative track enabled',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBufferAudio;
  let sourceBufferCombined;
  let audioTracks = [{
    enabled: false,
    kind: 'main',
    label: 'main'
  }, {
    enabled: true,
    kind: 'alternative',
    label: 'English (UK)'
  }];

  this.player.audioTracks = () => audioTracks;

  mediaSource.player_ = this.player;

  sourceBufferCombined = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferCombined.videoCodec_ = true;
  sourceBufferCombined.audioCodec_ = true;
  sourceBufferAudio = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferAudio.videoCodec_ = false;
  sourceBufferAudio.audioCodec_ = true;

  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 2,
    'active source buffers includes both source buffers');
  // maintains same order as source buffers were created
  QUnit.equal(mediaSource.activeSourceBuffers[0], sourceBufferCombined,
    'active source buffers starts with combined source buffer');
  QUnit.equal(mediaSource.activeSourceBuffers[1], sourceBufferAudio,
    'active source buffers ends with audio source buffer');
});

QUnit.test('video only & audio only buffers are always active',
function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBufferAudio;
  let sourceBufferCombined;
  let audioTracks = [{
    enabled: false,
    kind: 'main',
    label: 'main'
  }, {
    enabled: true,
    kind: 'alternative',
    label: 'English (UK)'
  }];

  this.player.audioTracks = () => audioTracks;

  mediaSource.player_ = this.player;

  sourceBufferCombined = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferCombined.videoCodec_ = true;
  sourceBufferCombined.audioCodec_ = false;
  sourceBufferAudio = mediaSource.addSourceBuffer('video/m2pt');
  sourceBufferAudio.videoCodec_ = false;
  sourceBufferAudio.audioCodec_ = true;

  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 2,
    'active source buffers includes both source buffers');
  // maintains same order as source buffers were created
  QUnit.equal(mediaSource.activeSourceBuffers[0], sourceBufferCombined,
    'active source buffers starts with combined source buffer');
  QUnit.equal(mediaSource.activeSourceBuffers[1], sourceBufferAudio,
    'active source buffers ends with audio source buffer');

  audioTracks[0].enabled = true;
  audioTracks[1].enabled = false;
  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 2,
    'active source buffers includes both source buffers');
  // maintains same order as source buffers were created
  QUnit.equal(mediaSource.activeSourceBuffers[0], sourceBufferCombined,
    'active source buffers starts with combined source buffer');
  QUnit.equal(mediaSource.activeSourceBuffers[1], sourceBufferAudio,
    'active source buffers ends with audio source buffer');
});

QUnit.test('Single buffer always active. Audio disabled depends on audio codec',
function() {
  let mediaSource = new videojs.MediaSource();
  let audioTracks = [{
    enabled: true,
    kind: 'main',
    label: 'main'
  }];

  this.player.audioTracks = () => audioTracks;

  mediaSource.player_ = this.player;

  let sourceBuffer = mediaSource.addSourceBuffer('video/m2pt');

  // video only
  sourceBuffer.videoCodec_ = true;
  sourceBuffer.audioCodec_ = false;

  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 1, 'sourceBuffer is active');
  QUnit.ok(mediaSource.activeSourceBuffers[0].audioDisabled_,
    'audio is disabled on video only active sourceBuffer');

  // audio only
  sourceBuffer.videoCodec_ = false;
  sourceBuffer.audioCodec_ = true;

  mediaSource.updateActiveSourceBuffers_();

  QUnit.equal(mediaSource.activeSourceBuffers.length, 1, 'sourceBuffer is active');
  QUnit.notOk(mediaSource.activeSourceBuffers[0].audioDisabled_,
    'audio not disabled on audio only active sourceBuffer');
});

QUnit.test('video segments with info trigger videooinfo event', function() {
  let data = new Uint8Array(1);
  let infoEvents = [];
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let info = {width: 100};
  let newinfo = {width: 225};

  mediaSource.on('videoinfo', (e) => infoEvents.push(e));

  // send an audio segment with info, then send done
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', data, {info}));
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  QUnit.equal(infoEvents.length, 1, 'video info should trigger');
  QUnit.deepEqual(infoEvents[0].info, info, 'video info = muxed info');

  // send an audio segment with info, then send done
  sourceBuffer.transmuxer_.onmessage(createDataMessage('video', data, {info: newinfo}));
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  QUnit.equal(infoEvents.length, 2, 'video info should trigger');
  QUnit.deepEqual(infoEvents[1].info, newinfo, 'video info = muxed info');
});

QUnit.test('audio segments with info trigger audioinfo event', function() {
  let data = new Uint8Array(1);
  let infoEvents = [];
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer = mediaSource.addSourceBuffer('video/mp2t');
  let info = {width: 100};
  let newinfo = {width: 225};

  mediaSource.on('audioinfo', (e) => infoEvents.push(e));

  // send an audio segment with info, then send done
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', data, {info}));
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  QUnit.equal(infoEvents.length, 1, 'audio info should trigger');
  QUnit.deepEqual(infoEvents[0].info, info, 'audio info = muxed info');

  // send an audio segment with info, then send done
  sourceBuffer.transmuxer_.onmessage(createDataMessage('audio', data, {info: newinfo}));
  sourceBuffer.transmuxer_.onmessage(doneMessage);

  QUnit.equal(infoEvents.length, 2, 'audio info should trigger');
  QUnit.deepEqual(infoEvents[1].info, newinfo, 'audio info = muxed info');
});

QUnit.test('creates native SourceBuffers immediately if a second ' +
           'VirtualSourceBuffer is created', function() {
  let mediaSource = new videojs.MediaSource();
  let sourceBuffer =
    mediaSource.addSourceBuffer('video/mp2t; codecs="avc1.64001f,mp4a.40.5"');
  let sourceBuffer2 =
    mediaSource.addSourceBuffer('video/mp2t; codecs="mp4a.40.5"');

  QUnit.ok(mediaSource.videoBuffer_, 'created a video buffer');
  QUnit.equal(
    mediaSource.videoBuffer_.type,
    'video/mp4;codecs="avc1.64001f"',
    'video buffer has the specified codec'
  );

  QUnit.ok(mediaSource.audioBuffer_, 'created an audio buffer');
  QUnit.equal(
    mediaSource.audioBuffer_.type,
    'audio/mp4;codecs="mp4a.40.5"',
    'audio buffer has the specified codec'
  );
  QUnit.equal(mediaSource.sourceBuffers.length, 2, 'created two virtual buffers');
  QUnit.equal(
    mediaSource.sourceBuffers[0],
    sourceBuffer,
    'returned the virtual buffer');
  QUnit.equal(
    mediaSource.sourceBuffers[1],
    sourceBuffer2,
    'returned the virtual buffer');
  QUnit.equal(
    sourceBuffer.audioDisabled_,
    true,
    'first source buffer\'s audio is automatically disabled');
  QUnit.ok(
    sourceBuffer2.audioBuffer_,
    'second source buffer has an audio source buffer');
});

QUnit.module('VirtualSourceBuffer - Isolated Functions');

QUnit.test('gopsSafeToAlignWith returns correct list', function() {
  // gopsSafeToAlignWith uses a 3 second safetyNet so that gops very close to the playhead
  // are not considered safe to append to
  const safetyNet = 3;
  const pts = (time) => Math.ceil(time * 90000);
  let mapping = 0;
  let currentTime = 0;
  let buffer = [];
  let player;
  let actual;
  let expected;

  expected = [];
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected, 'empty array when player is undefined');

  player = { currentTime: () => currentTime };
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected, 'empty array when buffer is empty');

  buffer = expected = [
    { pts: pts(currentTime + safetyNet + 1) },
    { pts: pts(currentTime + safetyNet + 2) },
    { pts: pts(currentTime + safetyNet + 3) }
  ];
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected,
    'entire buffer considered safe when all gops come after currentTime + safetyNet');

  buffer = [
    { pts: pts(currentTime + safetyNet) },
    { pts: pts(currentTime + safetyNet + 1) },
    { pts: pts(currentTime + safetyNet + 2) }
  ];
  expected = [
    { pts: pts(currentTime + safetyNet + 1) },
    { pts: pts(currentTime + safetyNet + 2) }
  ];
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected, 'safetyNet comparison is not inclusive');

  currentTime = 10;
  mapping = -5;
  buffer = [
    { pts: pts(currentTime - mapping + safetyNet - 2) },
    { pts: pts(currentTime - mapping + safetyNet - 1) },
    { pts: pts(currentTime - mapping + safetyNet) },
    { pts: pts(currentTime - mapping + safetyNet + 1) },
    { pts: pts(currentTime - mapping + safetyNet + 2) }
  ];
  expected = [
    { pts: pts(currentTime - mapping + safetyNet + 1) },
    { pts: pts(currentTime - mapping + safetyNet + 2) }
  ];
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected, 'uses mapping to shift currentTime');

  currentTime = 20;
  expected = [];
  actual = gopsSafeToAlignWith(buffer, player, mapping);
  QUnit.deepEqual(actual, expected,
    'empty array when no gops in buffer come after currentTime');
});

QUnit.test('currentGOPStart returns time of most recent GOP', function(assert) {
  const pts = (time) => time * 90000;
  let mapping = 0;
  let buffer = [];
  let actual;
  let expected = null;

  actual = currentGOPStart(buffer, undefined, mapping);
  QUnit.deepEqual(actual, expected, 'null when currentTime is undefined');

  actual = currentGOPStart(buffer, null, mapping);
  QUnit.deepEqual(actual, expected, 'null when currentTime is null');

  actual = currentGOPStart(buffer, 0, mapping);
  QUnit.deepEqual(actual, expected, 'null when buffer is empty');

  buffer = [
    { pts: pts(1) },
    { pts: pts(2.2) },
    { pts: pts(3) }
  ];
  actual = currentGOPStart(buffer, 0, mapping);
  QUnit.deepEqual(actual, expected, 'null when entire buffer is ahead of currentTime');

  actual = currentGOPStart(buffer, 1.5, mapping);
  QUnit.deepEqual(actual, 1, 'uses previous GOP when between GOP starts');

  actual = currentGOPStart(buffer, 2.2, mapping);
  QUnit.deepEqual(actual, 2.2, 'uses currentTime when currentTime === GOP start');

  actual = currentGOPStart(buffer, 3, mapping);
  QUnit.deepEqual(actual, 3, 'uses currentTime when currentTime === GOP start');

  actual = currentGOPStart(buffer, 4.5, mapping);
  QUnit.deepEqual(actual, 3, 'uses previous GOP when currentTime is after entire buffer');
});

QUnit.test('updateGopBuffer correctly processes new gop information', function() {
  let buffer = [];
  let gops = [];
  let replace = true;
  let actual;
  let expected;

  buffer = expected = [{ pts: 100 }, { pts: 200 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected, 'returns buffer when no new gops');

  gops = expected = [{ pts: 300 }, { pts: 400 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected, 'returns only new gops when replace is true');

  replace = false;
  buffer = [];
  gops = [{ pts: 100 }];
  expected = [{ pts: 100 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected, 'appends new gops to empty buffer');

  buffer = [{ pts: 100 }, { pts: 200 }];
  gops = [{ pts: 300 }, { pts: 400 }];
  expected = [{ pts: 100 }, { pts: 200 }, { pts: 300 }, { pts: 400 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected, 'appends new gops at end of buffer when no overlap');

  buffer = [{ pts: 100 }, { pts: 200 }, { pts: 300 }, { pts: 400 }];
  gops = [{ pts: 250 }, { pts: 300 }, { pts: 350 }];
  expected = [{ pts: 100 }, { pts: 200 }, { pts: 250 }, { pts: 300 }, { pts: 350 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected,
    'slices buffer at point of overlap and appends new gops');

  buffer = [{ pts: 100 }, { pts: 200 }, { pts: 300 }, { pts: 400 }];
  gops = [{ pts: 200 }, { pts: 300 }, { pts: 350 }];
  expected = [{ pts: 100 }, { pts: 200 }, { pts: 300 }, { pts: 350 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected, 'overlap slice is inclusive');

  buffer = [{ pts: 300 }, { pts: 400 }, { pts: 500 }, { pts: 600 }];
  gops = [{ pts: 100 }, { pts: 200 }, { pts: 250 }];
  expected = [{ pts: 100 }, { pts: 200 }, { pts: 250 }];
  actual = updateGopBuffer(buffer, gops, replace);
  QUnit.deepEqual(actual, expected,
    'completely replaces buffer with new gops when all gops come before buffer');
});

QUnit.test('removeGopBuffer correctly removes range from buffer', function() {
  const pts = (time) => Math.ceil(time * 90000);
  let buffer = [];
  let start = 0;
  let end = 0;
  let mapping = -5;
  let actual;
  let expected;

  expected = [];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'returns empty array when buffer empty');

  start = 0;
  end = 8;
  buffer = expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected,
    'no removal when remove range comes before start of buffer');

  start = 22;
  end = 30;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected,
    'removes last gop when remove range is after end of buffer');

  start = 0;
  end = 10;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps start range to begining of buffer');

  start = 0;
  end = 12;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps start range to begining of buffer');

  start = 0;
  end = 14;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps start range to begining of buffer');

  start = 15;
  end = 30;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps end range to end of buffer');

  start = 17;
  end = 30;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps end range to end of buffer');

  start = 20;
  end = 30;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'clamps end range to end of buffer');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 12;
  end = 15;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 12;
  end = 14;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 13;
  end = 14;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 13;
  end = 15;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 12;
  end = 17;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  start = 13;
  end = 16;
  expected = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected, 'removes gops that remove range intersects with');

  start = 10;
  end = 20;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected,
    'removes entire buffer when buffer inside remove range');

  start = 0;
  end = 30;
  buffer = [
    { pts: pts(10 - mapping) },
    { pts: pts(11 - mapping) },
    { pts: pts(12 - mapping) },
    { pts: pts(15 - mapping) },
    { pts: pts(18 - mapping) },
    { pts: pts(20 - mapping) }
  ];
  expected = [];
  actual = removeGopBuffer(buffer, start, end, mapping);
  QUnit.deepEqual(actual, expected,
    'removes entire buffer when buffer inside remove range');
});

QUnit.test('WrappedSourceBuffer', function() {
  let wrappedSourceBuffer;
  let someFnCalled = false;
  const tryFn = fn => data => {
    QUnit.equal(wrappedSourceBuffer.updating, true,
      'wrapped source buffer is updating during ' + fn);
    throw Error('error during ' + fn);
  };
  let fakeSourceBuffer = {
    appendBuffer: tryFn('appendBuffer'),
    appendStream: tryFn('appendStream'),
    remove: tryFn('remove'),
    abort: () => {},
    someFn: () => {
      someFnCalled = true;
    },
    someProp: 'getter test'
  };
  const mediaSource = {
    addSourceBuffer: (mimeType) => fakeSourceBuffer
  };

  wrappedSourceBuffer = new WrappedSourceBuffer(mediaSource, 'dummy');

  try {
    wrappedSourceBuffer.appendBuffer();
  } catch (e) {
    QUnit.ok(e, 'error rethrown when appendBuffer fails');
    QUnit.equal(wrappedSourceBuffer.updating, false,
      'wrapped source buffer is no longer updating after appendBuffer fails');
  }

  try {
    wrappedSourceBuffer.appendStream();
  } catch (e) {
    QUnit.ok(e, 'error rethrown when appendStream fails');
    QUnit.equal(wrappedSourceBuffer.updating, false,
      'wrapped source buffer is no longer updating after appendStream fails');
  }

  try {
    wrappedSourceBuffer.remove();
  } catch (e) {
    QUnit.ok(e, 'error rethrown when remove fails');
    QUnit.equal(wrappedSourceBuffer.updating, false,
      'wrapped source buffer is no longer updating after remove fails');
  }

  wrappedSourceBuffer.updating = true;
  wrappedSourceBuffer.abort();
  QUnit.equal(wrappedSourceBuffer.updating, false,
    'wrapped source buffer is no longer updating after abort() is called');

  wrappedSourceBuffer.someFn();
  QUnit.equal(someFnCalled, true, 'someFn called');

  QUnit.equal(wrappedSourceBuffer.someProp, 'getter test', 'property getter works');
  wrappedSourceBuffer.someProp = 'setter test';
  QUnit.equal(fakeSourceBuffer.someProp, 'setter test', 'property setter works');

});
