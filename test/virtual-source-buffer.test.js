import QUnit from 'qunit';

import {mp4} from 'mux.js';

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
