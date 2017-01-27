/**
 * @file flash-worker.js
 */

/**
 * videojs-contrib-media-sources
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Handles communication between the browser-world and the mux.js
 * transmuxer running inside of a WebWorker by exposing a simple
 * message-based interface to a Transmuxer object.
 */
import window from 'global/window';
import flv from 'mux.js/lib/flv';

const orderTags = function(tags) {
  let videoTags = tags.videoTags;
  let audioTags = tags.audioTags;
  let ordered = [];
  let tag;

  while (videoTags.length || audioTags.length) {
    if (!videoTags.length) {
      // only audio tags remain
      tag = audioTags.shift();
    } else if (!audioTags.length) {
      // only video tags remain
      tag = videoTags.shift();
    } else if (audioTags[0].dts < videoTags[0].dts) {
      // audio should be decoded next
      tag = audioTags.shift();
    } else {
      // video should be decoded next
      tag = videoTags.shift();
    }

    ordered.push(tag);
  }

  return ordered;
}

/**
 * Re-emits tranmsuxer events by converting them into messages to the
 * world outside the worker.
 *
 * @param {Object} transmuxer the transmuxer to wire events on
 * @private
 */
const wireTransmuxerEvents = function(transmuxer) {
  transmuxer.on('data', function(segment) {

    // segment.tags = orderTags(segment.tags);

    window.postMessage({
      action: 'data',
      segment
    });
  });

  transmuxer.on('done', function(data) {
    window.postMessage({ action: 'done' });
  });
};

/**
 * All incoming messages route through this hash. If no function exists
 * to handle an incoming message, then we ignore the message.
 *
 * @class MessageHandlers
 * @param {Object} options the options to initialize with
 */
class MessageHandlers {
  constructor(options) {
    this.options = options || {};
    this.init();
  }

  /**
   * initialize our web worker and wire all the events.
   */
  init() {
    if (this.transmuxer) {
      this.transmuxer.dispose();
    }
    this.transmuxer = new flv.Transmuxer(this.options);
    wireTransmuxerEvents(this.transmuxer);
  }

  /**
   * Adds data (a ts segment) to the start of the transmuxer pipeline for
   * processing.
   *
   * @param {ArrayBuffer} data data to push into the muxer
   */
  push(data) {
    // Cast array buffer to correct type for transmuxer
    let segment = new Uint8Array(data.data, data.byteOffset, data.byteLength);

    this.transmuxer.push(segment);
  }

  /**
   * Recreate the transmuxer so that the next segment added via `push`
   * start with a fresh transmuxer.
   */
  reset() {
    this.init();
  }

  /**
   * Forces the pipeline to finish processing the last segment and emit it's
   * results.
   *
   * @param {Object} data event data, not really used
   */
  flush(data) {
    this.transmuxer.flush();
  }
}

/**
 * Our web wroker interface so that things can talk to mux.js
 * that will be running in a web worker. the scope is passed to this by
 * webworkify.
 *
 * @param {Object} self the scope for the web worker
 */
const Worker = function(self) {
  self.onmessage = function(event) {
    if (event.data.action === 'init' && event.data.options) {
      this.messageHandlers = new MessageHandlers(event.data.options);
      return;
    }

    if (!this.messageHandlers) {
      this.messageHandlers = new MessageHandlers();
    }

    if (event.data && event.data.action && event.data.action !== 'init') {
      if (this.messageHandlers[event.data.action]) {
        this.messageHandlers[event.data.action](event.data);
      }
    }
  };
};

export default (self) => {
  return new Worker(self);
};
