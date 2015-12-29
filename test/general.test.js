import document from 'global/document';

import QUnit from 'qunit';
import sinon from 'sinon';
import videojs from 'video.js';
import muxjs from 'mux.js';
import FlashMediaSource from '../src/flash-media-source';
import HtmlMediaSource from '../src/html-media-source';

import contribMediaSources from '../src/plugin.js';

const Player = videojs.getComponent('Player');

QUnit.test('the environment is sane', function(assert) {
  assert.strictEqual(typeof Array.isArray, 'function', 'es5 exists');
  assert.strictEqual(typeof sinon, 'object', 'sinon exists');
  assert.strictEqual(typeof videojs, 'function', 'videojs exists');
  assert.strictEqual(typeof contribMediaSources, 'function', 'plugin is a function');
});

QUnit.module('videojs-contrib-media-sources - General', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.player = videojs(this.video);

    // Mock the environment's timers because certain things - particularly
    // player readiness - are asynchronous in video.js 5.
    this.clock = sinon.useFakeTimers();
    this.oldMediaSource = window.MediaSource || window.WebKitMediaSource;
  },

  afterEach() {

    // The clock _must_ be restored before disposing the player; otherwise,
    // certain timeout listeners that happen inside video.js may throw errors.
    this.clock.restore();
    this.player.dispose();
    window.MediaSource = window.WebKitMediaSource = this.oldMediaSource;
  }
});


QUnit.test('implementation selection is overridable', function() {
  ok(
    new this.player.contribMediaSources({ mode: 'flash' }) instanceof FlashMediaSource,
    'forced flash'
  );
  ok(
    new this.player.contribMediaSources({ mode: 'html5' }) instanceof HtmlMediaSource,
    'forced html5'
  );

  // 'auto' should use native mediasources when they're available
  ok(
    new this.player.contribMediaSources() instanceof HtmlMediaSource,
    'used html5'
  );
  // 'auto' should use flash when native mediasources are not available
  ok(
    new this.player.contribMediaSources({ mode: 'flash' }) instanceof FlashMediaSource,
      'used flash'
  );
});
