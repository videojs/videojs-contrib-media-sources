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
var
  muxjs = {},
  transmuxer,
  currentContext,
  initOptions = {};

importScripts('../node_modules/mux.js/lib/exp-golomb.js');
importScripts('../node_modules/mux.js/lib/mp4-generator.js');
importScripts('../node_modules/mux.js/lib/stream.js');
importScripts('../node_modules/mux.js/lib/metadata-stream.js');
importScripts('../node_modules/mux.js/lib/transmuxer.js');
importScripts('../node_modules/mux.js/lib/caption-stream.js');


/**
 * wireTransmuxerEvents
 * Re-emits tranmsuxer events by converting them into messages to the
 * world outside the worker
 */
var wireTransmuxerEvents = function (transmuxer) {
  // context contains all the functions and information necessary to unwire
  // events so that we can cleanly dispose of the transmuxer
  var context = {
    dataFn: function (segment) {
      // transfer ownership of the underlying ArrayBuffer instead of doing a copy to save memory
      // ArrayBuffers are transferable but generic TypedArrays are not
      // see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#Passing_data_by_transferring_ownership_(transferable_objects)
      segment.data = segment.data.buffer;
      postMessage({
        action: 'data',
        segment: segment
      }, [segment.data]);
    },
    captionDataFn: function (caption) {
      postMessage({
        action: 'caption',
        data: caption
      });
    },
    doneFn: function (data) {
      postMessage({ action: 'done' });
    },
    dispose: function () {
      transmuxer.off('data', this.dataFn);

      if (transmuxer.captionStream) {
        transmuxer.captionStream.off('data', this.captionDataFn);
      }

      transmuxer.off('done', this.doneFn);
    }
  };

  transmuxer.on('data', context.dataFn);

  if (transmuxer.captionStream) {
    transmuxer.captionStream.on('data', context.captionDataFn);
  }

  transmuxer.on('done', context.doneFn);

  return context;
};

/**
 * All incoming messages route through this hash. If no function exists
 * to handle an incoming message, then we ignore the message.
 */
var messageHandlers = {
  /**
   * init
   * Allows you to initialize the transmuxer and pass along options from
   * outside the worker
   */
  init: function (data) {
    initOptions = (data && data.options) || {};
    this.defaultInit();
  },
  /**
   * defaultInit
   * Is called before every function and initializes the transmuxer with
   * default options if `init` was never explicitly called
   */
  defaultInit: function () {
    if (currentContext) {
      currentContext.dispose();
    }
    transmuxer = new muxjs.mp2t.Transmuxer(initOptions);
    currentContext = wireTransmuxerEvents(transmuxer);
  },
  /**
   * push
   * Adds data (a ts segment) to the start of the transmuxer pipeline for
   * processing
   */
  push: function (data) {
    // Cast array buffer to correct type for transmuxer
    var segment = new Uint8Array(data.data);
    transmuxer.push(segment);
  },
  /**
   * resetTransmuxer
   * Recreate the transmuxer so that the next segment added via `push`
   * begins at a baseMediaDecodeTime of 0
   */
  resetTransmuxer: function (data) {
    // delete the transmuxer
    this.defaultInit();
  },
  /**
   * flush
   * Forces the pipeline to finish processing the last segment and emit it's
   * results
   */
  flush: function (data) {
    transmuxer.flush();
  }
};

onmessage = function(event) {
  // Setup the default transmuxer if one doesn't exist yet and we are invoked with
  // an action other than `init`
  if (!transmuxer && event.data.action !== 'init') {
    messageHandlers.defaultInit();
  }

  if (event.data && event.data.action) {
    if (messageHandlers[event.data.action]) {
      messageHandlers[event.data.action](event.data);
    }
  }
};
