module.exports = function(grunt) {
  var pkg = grunt.file.readJSON('package.json');

  grunt.initConfig({
    // Metadata.
    pkg: pkg,
    banner: '/*! <%= pkg.name %> - v<%= pkg.version %> - ' +
      '<%= grunt.template.today("yyyy-mm-dd") %>\n' +
      '* Copyright (c) <%= grunt.template.today("yyyy") %> Brightcove;' +
      ' Licensed <%= _.pluck(pkg.licenses, "type").join(", ") %> */\n',
    // Task configuration.
    clean: {
      files: ['build', 'dist']
    },
    jshint: {
      files: ['Gruntfile.js', 'src/**/*.js', 'test/**/*.js']
    },
    karma: {
      test: {
        configFile: 'test/karma.conf.js'
      }
    },
    importscripts: {
      build: {
        src: 'src/transmuxer_worker.js',
        dest: 'build/transmuxer_worker.js'
      }
    },
    uglify: {
      webworker: {
        src: '<%= importscripts.build.dest %>',
        dest: 'build/transmuxer_worker.min.js'
      },
      mediasource: {
        options: {
          banner: '<%= banner %>'
        },
        src: [
          'node_modules/mux.js/lib/stream.js',
          'node_modules/mux.js/lib/exp-golomb.js',
          'node_modules/mux.js/legacy/flv-tag.js',
          'node_modules/mux.js/legacy/aac-stream.js',
          'node_modules/mux.js/legacy/h264-stream.js',
          'node_modules/mux.js/legacy/metadata-stream.js',
          'node_modules/mux.js/legacy/h264-extradata.js',
          'node_modules/mux.js/legacy/segment-parser.js',
          '<%= blobify.build.dest %>'
        ],
        dest: 'dist/videojs-media-sources.min.js'
      }
    },
    concat: {
      dist: {
        options: {
          banner: '<%= banner %>'
        },
        src: [
          'node_modules/mux.js/lib/stream.js',
          'node_modules/mux.js/lib/exp-golomb.js',
          'node_modules/mux.js/legacy/flv-tag.js',
          'node_modules/mux.js/legacy/aac-stream.js',
          'node_modules/mux.js/legacy/h264-stream.js',
          'node_modules/mux.js/legacy/metadata-stream.js',
          'node_modules/mux.js/legacy/h264-extradata.js',
          'node_modules/mux.js/legacy/segment-parser.js',
          '<%= blobify.build.dest %>'
        ],
        dest: 'dist/videojs-media-sources.js'
      }
    },
    blobify: {
      build: {
        src: 'src/videojs-media-sources.js',
        dest: 'build/videojs-media-sources.js'
      }
    },
    importscripts: {
      build: {
        src: 'src/transmuxer_worker.js',
        dest: 'build/transmuxer_worker.js'
      }
    },
    uglify: {
      webworker: {
        src: '<%= importscripts.build.dest %>',
        dest: 'build/transmuxer_worker.min.js'
      },
      mediasource: {
        options: {
          banner: '<%= banner %>'
        },
        src: [
          'node_modules/mux.js/lib/stream.js',
          'node_modules/mux.js/lib/exp-golomb.js',
          'node_modules/mux.js/legacy/flv-tag.js',
          'node_modules/mux.js/legacy/aac-stream.js',
          'node_modules/mux.js/legacy/h264-stream.js',
          'node_modules/mux.js/legacy/metadata-stream.js',
          'node_modules/mux.js/legacy/h264-extradata.js',
          'node_modules/mux.js/legacy/segment-parser.js',
          '<%= blobify.build.dest %>'
        ],
        dest: 'dist/videojs-media-sources.min.js'
      }
    },
    blobify: {
      build: {
        src: 'src/videojs-media-sources.js',
        dest: 'build/videojs-media-sources.js'
      }
    },
    connect: {
      server: {
        options: {
          keepalive: true
        }
      }
    }
  });

  grunt.task.registerMultiTask('importscripts', 'Inline files references via importScripts in a WebWorker', function(arg1, arg2) {
    var fs = require('fs');
    var path = require('path');
    var falafel = require('falafel');

    this.files.forEach(function(f) {
      var src = f.src[0];
      // Warn on and remove invalid source files (if nonull was set).
      if (!grunt.file.exists(src)) {
        grunt.log.warn('Source file "' + filepath + '" not found.');
        return;
      }

      // Don't process directories
      if (grunt.file.isDir(src)) {
        return;
      }

      // Read file source.
      var srcContents = grunt.file.read(src);
      var currentPath = path.dirname(src);

      // Process the file looking for `importScripts` calls
      grunt.file.write(f.dest, falafel(srcContents, function (node) {
        // Check every function call for one that calls importScripts
        if (node.type === 'CallExpression' && node.callee.name === 'importScripts') {
          var fileName = node.arguments[0].value;
          var inlineSrc = grunt.file.read(path.resolve(currentPath, fileName));

          grunt.log.debug('Inlining importScripts file "' + path.resolve(currentPath, fileName) + '"...');

          // Replace the entire importScripts expression with the source of the file
          node.update(inlineSrc);
        }
      }).toString());
    });
  });

  grunt.task.registerMultiTask('blobify', 'Create a blob-based  WebWorker to inline a source file', function(arg1, arg2) {
    var fs = require('fs');
    var path = require('path');
    var falafel = require('falafel');

    this.files.forEach(function(f) {
      var src = f.src[0];
      // Warn on and remove invalid source files (if nonull was set).
      if (!grunt.file.exists(src)) {
        grunt.log.warn('Source file "' + filepath + '" not found.');
        return;
      }

      // Don't process directories
      if (grunt.file.isDir(src)) {
        return;
      }

      // Read file source.
      var srcContents = grunt.file.read(src);
      var currentPath = path.dirname(src);

      // Process the file looking for `importScripts` calls
      grunt.file.write(f.dest, falafel(srcContents, function (node) {
        // Check every function call for one that calls importScripts
        // and only imports the file we are looking for
        if (node.type === 'NewExpression' &&
          node.callee.name === 'Worker' &&
          node.arguments[0].value.indexOf('transmuxer_worker') > -1) {
          var inlineSrc = grunt.file.read(path.resolve(currentPath, '../build/transmuxer_worker.min.js'));

          // Replace the entire importScripts expression with the source of the file
          node.update('new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(inlineSrc) + '], {type: "application/javascript"})))');
        }
      }).toString());
    });
  });

  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-connect');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-karma');
  grunt.loadNpmTasks('grunt-contrib-uglify');

  grunt.registerTask('default', ['jshint', 'karma']);
  grunt.registerTask('build', ['clean', 'importscripts', 'uglify:webworker', 'blobify', 'uglify:mediasource']);
};
