/**
 * videojs-contrib-media-sources
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Handles communication between the browser-world and the mux.js
 * transmuxer running inside of a webworker by exposing a simple
 * message-based interface to a Transmuxer object.
 */
var muxjs = {};

importScripts('../node_modules/mux.js/lib/exp-golomb.js');
importScripts('../node_modules/mux.js/lib/mp4-generator.js');
importScripts('../node_modules/mux.js/lib/stream.js');
importScripts('../node_modules/mux.js/lib/transmuxer.js');

var transmuxer = new muxjs.mp2t.Transmuxer();

onmessage = function(event) {
  if (event.data.action === 'push') {
    // Cast to type
    var segment = new Uint8Array(event.data.data);

    transmuxer.push(segment);
  } else if (event.data.action === 'flush') {
    transmuxer.flush();
  }
};

transmuxer.on('data', function (segment) {
  postMessage({action: 'data', type: segment.type, data: segment.data.buffer}, [segment.data.buffer]);
});

transmuxer.on('done', function (data) {
  postMessage({action: 'done'});
});
