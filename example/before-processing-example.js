import videojs from 'video.js';
import contribMediaSources from '../src/plugin';
videojs.plugin('contribMediaSources', contribMediaSources);

let req = new XMLHttpRequest();
// initialize video.js
let video = videojs('video');

// the flash-based media sources implementation only supports FLV video data
// use XMLHttpRequest2 to get the raw byte array of an example FLV
req.open('GET', '/example/barsandtone.flv', true);
req.responseType = 'arraybuffer';

req.onload = function(event) {
  // create a new media source to hold the data buffers
  /* eslint-disable new-cap */
  let mediaSource = new videojs.contribMediaSources();
  /* eslint-enable new-cap */

  // wrap the arraybuffer in a view so we can easily work with the
  // individual bytes
  let bytes = new Uint8Array(req.response);
  let url;

  // when a media source is assigned to a video element the `sourceopen`
  // event fires
  mediaSource.addEventListener('sourceopen', function(e) {
    // construct the video data buffer and set the appropriate MIME type
    let sourceBuffer = mediaSource.addSourceBuffer('video/flv; codecs="vp6,aac"');

    // start feeding bytes to the buffer
    // the video element that is reading from the associated media buffer is
    // ready to start playing now
    sourceBuffer.appendBuffer(bytes, video);

  }, false);

  // to assign a media source to a video element, you have to create a URL for it
  url = videojs.URL.createObjectURL(mediaSource);

  // assign the media source URL to video.js
  video.src({
    src: url,
    type: 'video/flv'
  });
};
req.send(null);
