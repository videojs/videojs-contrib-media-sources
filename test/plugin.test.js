import document from 'global/document';

import QUnit from 'qunit';
import sinon from 'sinon';
import videojs from 'video.js';
import FlashMediaSource from '../src/flash-media-source';
import HtmlMediaSource from '../src/html-media-source';

import MediaSource from '../src/plugin.js';

const Player = videojs.getComponent('Player');

QUnit.test('the environment is sane', function(assert) {
  assert.strictEqual(typeof Array.isArray, 'function', 'es5 exists');
  assert.strictEqual(typeof sinon, 'object', 'sinon exists');
  assert.strictEqual(typeof videojs, 'function', 'videojs exists');
  assert.strictEqual(typeof MediaSource, 'function', 'plugin is a function');
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

QUnit.test('Plugin is registered', function(assert) {
  assert.strictEqual(
    typeof Player.prototype.MediaSource,
    'function',
    'MediaSource plugin is attached to videojs'
  );
  assert.strictEqual(
    typeof this.player.MediaSource,
    'function',
    'MediaSource plugin is attached to player'
  );
  assert.strictEqual(
    typeof Player.prototype.URL,
    'object',
    'URL plugin is attached to videojs'
  );
  assert.strictEqual(
    typeof this.player.URL,
    'object',
    'URL plugin is attached to player'
  );
});

QUnit.test('implementation selection is overridable', function() {
  QUnit.ok(
    new this.player.MediaSource({ mode: 'flash' }) instanceof FlashMediaSource,
    'forced flash'
  );
  QUnit.ok(
    new this.player.MediaSource({ mode: 'html5' }) instanceof HtmlMediaSource,
    'forced html5'
  );

  // 'auto' should use native mediasources when they're available
  QUnit.ok(
    new this.player.MediaSource() instanceof HtmlMediaSource,
    'used html5'
  );
  // 'auto' should use flash when native mediasources are not available
  QUnit.ok(
    new this.player.MediaSource({ mode: 'flash' }) instanceof FlashMediaSource,
      'used flash'
  );
});
