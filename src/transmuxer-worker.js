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
let muxjs = require('mux.js');
let gTransmuxer;
let initOptions = {};

/**
 * wireTransmuxerEvents
 * Re-emits tranmsuxer events by converting them into messages to the
 * world outside the worker
 */
const wireTransmuxerEvents = function(transmuxer) {
  transmuxer.on('data', function(segment) {
    // transfer ownership of the underlying ArrayBuffer
    // instead of doing a copy to save memory
    // ArrayBuffers are transferable but generic TypedArrays are not
    /* eslint-disable max-len */
    // see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#Passing_data_by_transferring_ownership_(transferable_objects)
    /* eslint-enable max-len */
    segment.data = segment.data.buffer;
    postMessage({
      action: 'data',
      segment
    }, [segment.data]);
  });

  if (transmuxer.captionStream) {
    transmuxer.captionStream.on('data', function(caption) {
      postMessage({
        action: 'caption',
        data: caption
      });
    });
  }

  transmuxer.on('done', function(data) {
    postMessage({ action: 'done' });
  });
};

/**
 * All incoming messages route through this hash. If no function exists
 * to handle an incoming message, then we ignore the message.
 */
let messageHandlers = {
  /**
   * init
   * Allows you to initialize the transmuxer and pass along options from
   * outside the worker
   */
  init(data) {
    initOptions = (data && data.options) || {};
    this.defaultInit();
  },
  /**
   * defaultInit
   * Is called before every function and initializes the transmuxer with
   * default options if `init` was never explicitly called
   */
  defaultInit() {
    if (gTransmuxer) {
      gTransmuxer.dispose();
    }

    gTransmuxer = new muxjs.mp4.Transmuxer(initOptions);
    wireTransmuxerEvents(gTransmuxer);
  },
  /**
   * push
   * Adds data (a ts segment) to the start of the transmuxer pipeline for
   * processing
   */
  push(data) {
    // Cast array buffer to correct type for transmuxer
    let segment = new Uint8Array(data.data);

    gTransmuxer.push(segment);
  },
  /**
   * reset
   * Recreate the transmuxer so that the next segment added via `push`
   * start with a fresh transmuxer
   */
  reset() {
    this.defaultInit();
  },
  /**
   * setTimestampOffset
   * Set the value that will be used as the `baseMediaDecodeTime` time for the
   * next segment pushed in. Subsequent segments will have their `baseMediaDecodeTime`
   * set relative to the first based on the PTS values.
   */
  setTimestampOffset(data) {
    let timestampOffset = data.timestampOffset || 0;

    gTransmuxer.setBaseMediaDecodeTime(Math.round(timestampOffset * 90000));
  },
  /**
   * flush
   * Forces the pipeline to finish processing the last segment and emit it's
   * results
   */
  flush(data) {
    gTransmuxer.flush();
  }
};

module.exports = function(self) {
  self.onmessage = function(event) {
    // Setup the default transmuxer if one doesn't exist yet and we are invoked with
    // an action other than `init`
    if (!gTransmuxer && event.data.action !== 'init') {
      messageHandlers.defaultInit();
    }

    if (event.data && event.data.action) {
      if (messageHandlers[event.data.action]) {
        messageHandlers[event.data.action](event.data);
      }
    }
  };
};
