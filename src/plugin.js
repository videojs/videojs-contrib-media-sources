import FlashMediaSource from './flash-media-source';
import HtmlMediaSource from './html-media-source';
import videojs from 'video.js';

let urlCount = 0;

// ------------
// Media Source
// ------------

const defaults = {
  // how to determine the MediaSource implementation to use. There
  // are three available modes:
  // - auto: use native MediaSources where available and Flash
  //   everywhere else
  // - html5: always use native MediaSources
  // - flash: always use the Flash MediaSource polyfill
  mode: 'auto'
};

// store references to the media sources so they can be connected
// to a video element (a swf object)
let mediaSources = {};

const contribMediaSources = function(options) {
  let settings = videojs.mergeOptions(defaults, options);

  this.contribMediaSources = {
    // provide a method for a swf object to notify JS that a media source is now open
    open(msObjectURL, swfId) {
      let mediaSource = videojs.mediaSources[msObjectURL];

      if (mediaSource) {
        mediaSource.trigger({type: 'sourceopen', swfId});
      } else {
        throw new Error('Media Source not found (Video.js)');
      }
    },
    supportsNativeMediaSources() {
      return !!window.MediaSource;
    }
  };

  // determine whether HTML MediaSources should be used
  if (settings.mode === 'html5' ||
      (settings.mode === 'auto' &&
        this.contribMediaSources.supportsNativeMediaSources())) {
    return new HtmlMediaSource();
  }

  // otherwise, emulate them through the SWF
  return new FlashMediaSource();
};

const urlPlugin = {
  createObjectURL(object) {
    let objectUrlPrefix = 'blob:vjs-media-source/';
    let url;

    // use the native MediaSource to generate an object URL
    if (object instanceof HtmlMediaSource) {
      url = window.URL.createObjectURL(object.mediaSource_);
      object.url_ = url;
      return url;
    }
    // if the object isn't an emulated MediaSource, delegate to the
    // native implementation
    if (!(object instanceof FlashMediaSource)) {
      url = window.URL.createObjectURL(object);
      object.url_ = url;
      return url;
    }

    // build a URL that can be used to map back to the emulated
    // MediaSource
    url = objectUrlPrefix + urlCount;

    urlCount++;

    // setup the mapping back to object
    mediaSources[url] = object;

    return url;
  }
};

videojs.plugin('contribMediaSources', contribMediaSources);
videojs.plugin('URL', urlPlugin);


export default contribMediaSources;
