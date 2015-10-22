// Karma configuration
// Generated on Mon Aug 31 2015 16:01:07 GMT-0400 (EDT)

module.exports = function(config) {
  config.set({

    // base path that will be used to resolve all patterns (eg. files, exclude)
    basePath: '..',


    // frameworks to use
    // available frameworks: https://npmjs.org/browse/keyword/karma-adapter
    frameworks: ['qunit'],


    // list of files / patterns to load in the browser
    files: [
      'node_modules/video.js/dist/video.js',
      'node_modules/video.js/dist/video.js',
      'node_modules/mux.js/lib/utils/stream.js',
      'node_modules/mux.js/lib/utils/exp-golomb.js',
      'node_modules/mux.js/lib/m2ts/m2ts.js',
      'node_modules/mux.js/lib/m2ts/metadata-stream.js',
      'node_modules/mux.js/lib/m2ts/caption-stream.js',
      'node_modules/mux.js/lib/codecs/h264.js',
      'node_modules/mux.js/lib/codecs/aac.js',
      'node_modules/mux.js/lib/flv/flv-tag.js',
      'node_modules/mux.js/lib/flv/transmuxer.js',
      {pattern: 'src/transmuxer_worker.js', included: false},
      'src/videojs-media-sources.js',
      'test/*.js'
    ],

    // list of files to exclude
    exclude: [
    ],


    // preprocess matching files before serving them to the browser
    // available preprocessors: https://npmjs.org/browse/keyword/karma-preprocessor
    preprocessors: {
    },


    // test results reporter to use
    // possible values: 'dots', 'progress'
    // available reporters: https://npmjs.org/browse/keyword/karma-reporter
    reporters: ['progress'],


    // web server port
    port: 9876,


    // enable / disable colors in the output (reporters and logs)
    colors: true,


    // level of logging
    // possible values: config.LOG_DISABLE || config.LOG_ERROR || config.LOG_WARN || config.LOG_INFO || config.LOG_DEBUG
    logLevel: config.LOG_INFO,


    // enable / disable watching file and executing tests whenever any file changes
    autoWatch: true,


    // start these browsers
    // available browser launchers: https://npmjs.org/browse/keyword/karma-launcher
    browsers: process.env.TRAVIS ? ['Firefox'] : ['Chrome', 'Firefox'],


    // Continuous Integration mode
    // if true, Karma captures browsers, runs the tests and exits
    singleRun: true
  });
};
