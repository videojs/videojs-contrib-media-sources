module.exports = function(config) {
  var detectBrowsers = {
    enabled: false,
    usePhantomJS: false,
    postDetection: function(availableBrowsers) {
      var safariIndex = availableBrowsers.indexOf('Safari');

      if(safariIndex !== -1) {
        availableBrowsers.splice(safariIndex, 1);
        console.log("Disabled Safari as it was/is not supported");
      }
      return availableBrowsers;
    }
  };

  // TODO: This should include firefox. It is currently turned off because
  //       of https://github.com/travis-ci/travis-ci/issues/8242 When this issue is
  //       resolved, this should be updated to include firefox
  if (process.env.TRAVIS) {
    config.browsers = ['ChromeHeadless'];
  }

  // If no browsers are specified, we enable `karma-detect-browsers`
  // this will detect all browsers that are available for testing
  if (!config.browsers.length) {
    detectBrowsers.enabled = true;
  }

  config.set({
    basePath: '..',
    frameworks: ['browserify', 'qunit', 'detectBrowsers'],

    files: [
      'node_modules/sinon/pkg/sinon.js',
      'node_modules/sinon/pkg/sinon-ie.js',
      'node_modules/video.js/dist/video.js',
      'node_modules/video.js/dist/video-js.css',
      'node_modules/videojs-flash/dist/videojs-flash.js',
      'test/**/*.js',
      'dist-test/browserify-test.js',
      'dist-test/webpack-test.js'
    ],
    exclude: [
      'test/bundle.js'
    ],
    preprocessors: {
      'test/**/*.js': ['browserify']
    },
    detectBrowsers: detectBrowsers,
    reporters: ['dots'],
    port: 9876,
    colors: true,
    autoWatch: false,
    singleRun: true,
    concurrency: Infinity,
    browserify: {
      debug: true,
      transform: [
        'babelify',
        'browserify-shim'
      ]
    }

  });
};
