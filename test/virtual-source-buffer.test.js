import QUnit from 'qunit';

import {mp4} from 'mux.js';
import {mp2t} from 'mux.js';

import VirtualSourceBuffer from '../src/virtual-source-buffer';

import {createDataMessage} from './utils';

QUnit.module('videojs-contrib-media-sources - Virtual Source Buffer', {
  beforeEach() {
    this.vsb = new VirtualSourceBuffer({}, ['avc1.4d400d', 'mp4a.40.2']);
  }
});

QUnit.test('prepends a video init segment', function() {
  let videoData = new Uint8Array([5, 6, 7]);

  this.vsb.data_(createDataMessage({
    type: 'video',
    typedArray: videoData
  }));

  QUnit.equal(this.vsb.pendingBuffers_.length, 1, 'one pending buffer');

  let pendingSegmentData = this.vsb.pendingBuffers_[0].data;
  let initSegment = new Uint8Array(
    pendingSegmentData.subarray(0, pendingSegmentData.byteLength - videoData.byteLength));
  let boxes = mp4.tools.inspect(initSegment);

  QUnit.equal(boxes.length, 2, 'generated two boxes');
  QUnit.equal('ftyp', boxes[0].type, 'generated an ftyp box');
  QUnit.equal('moov', boxes[1].type, 'generated a moov box');
});

QUnit.test('prepends an audio init segment', function() {
  let audioData = new Uint8Array([5, 6, 7]);

  this.vsb.data_(createDataMessage({
    type: 'audio',
    typedArray: audioData
  }));

  QUnit.equal(this.vsb.pendingBuffers_.length, 1, 'one pending buffer');

  let pendingSegmentData = this.vsb.pendingBuffers_[0].data;
  let initSegment = new Uint8Array(
    pendingSegmentData.subarray(0, pendingSegmentData.byteLength - audioData.byteLength));
  let boxes = mp4.tools.inspect(initSegment);

  QUnit.equal(boxes.length, 2, 'generated two boxes');
  QUnit.equal('ftyp', boxes[0].type, 'generated an ftyp box');
  QUnit.equal('moov', boxes[1].type, 'generated a moov box');
});

QUnit.test(
'reuses audio track object when the pipeline reconfigures itself',
function(assert) {
  let transmuxer = new mp4.Transmuxer();
  let segments = [];

  transmuxer.on('data', function(segment) {
    segments.push(segment);
  });

  let pat = mp2t.utils.packetize(mp2t.utils.PAT);
  let pmt = mp2t.utils.packetize(mp2t.utils.packetize(mp2t.utils.generatePMT({
    hasAudio: true
  })));
  let pes = mp2t.utils.packetize(mp2t.utils.audioPes([0x19, 0x47], true, 10000));
  let ts = new Uint8Array(pat.length + pmt.length + pes.length);

  ts.set(pat);
  ts.set(pmt, pat.length);
  ts.set(pes, pat.length + pmt.length);

  transmuxer.push(ts);
  transmuxer.flush();

  let segmentData = segments[0].data;

  this.vsb.data_(createDataMessage({
    type: 'video',
    typedArray: segmentData
  }));

  QUnit.equal(this.vsb.pendingBuffers_.length, 1, 'one pending buffer');

  let pendingSegmentData = this.vsb.pendingBuffers_[0].data;
  let boxes = mp4.tools.inspect(pendingSegmentData);

  QUnit.equal(boxes[2].boxes[1].boxes[1].baseMediaDecodeTime, 0,
              'first segment starts at 0 pts');

  let id3Tag = new Uint8Array(73);
  let streamTimestamp = 'com.apple.streaming.transportStreamTimestamp';
  let priv = 'PRIV';

  id3Tag[0] = 73;
  id3Tag[1] = 68;
  id3Tag[2] = 51;
  id3Tag[3] = 4;
  id3Tag[9] = 63;
  id3Tag[17] = 53;
  id3Tag[70] = 13;
  id3Tag[71] = 187;
  id3Tag[72] = 160;

  for (let i = 0; i < priv.length; i++) {
    id3Tag[i + 10] = priv.charCodeAt(i);
  }

  for (let i = 0; i < streamTimestamp.length; i++) {
    id3Tag[i + 20] = streamTimestamp.charCodeAt(i);
  }

  let adtsPayload = new Uint8Array(mp2t.utils.adtsFrame(2).concat([0x19, 0x47]));
  let payload = new Uint8Array(id3Tag.length + adtsPayload.length);

  payload.set(id3Tag);
  payload.set(adtsPayload, id3Tag.length);

  transmuxer.push(payload);
  transmuxer.flush();

  segmentData = segments[1].data;

  this.vsb.data_(createDataMessage({
    type: 'video',
    typedArray: segmentData
  }));

  QUnit.equal(this.vsb.pendingBuffers_.length, 2, 'two pending buffer');

  pendingSegmentData = this.vsb.pendingBuffers_[1].data;
  boxes = mp4.tools.inspect(pendingSegmentData);

  QUnit.equal(boxes[2].boxes[1].boxes[1].baseMediaDecodeTime,
    // The first segment had a PTS of 10,000 and the second segment 900,000
    // Audio PTS is specified in a clock equal to samplerate (44.1khz)
    // So you have to take the different between the PTSs (890,000)
    // and transform it from 90khz to 44.1khz clock
    Math.floor((900000 - 10000) / (90000 / 44100)),
    'second segment starts at the right time');
});
