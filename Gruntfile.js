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
      files: ['tmp', 'dist']
    },
    jshint: {
      gruntfile: {
        src: 'Gruntfile.js',
        options: {
          node: true
        }
      },
      src: {
        src: 'src/**/*.js',
        options: {
          browserify: true,
          browser: true
        }
      },
      test: {
        src: 'test/*.js',
        options: {
          node: true,
          browserify: true,
          browser: true,
          qunit: true,
        }

      }
    },
    karma: {
      test: {
        configFile: 'test/karma.conf.js'
      }
    },
    browserify: {
      options: {
        browserifyOptions: {
          debug: true,
          standalone: 'videojs-media-sources.js'
        },
        plugin: [],
        transform: []
      },
      build: {
        files: {
          'dist/videojs-media-sources.js': ['src/videojs-media-sources.js']
        }
      },
      watch: {
        options: {
          watch: true,
          keepAlive: true
        },
        files: {
          'dist/mux.js': ['lib/index.js']
        }
      }
    },
    uglify: {
      mediasource: {
        options: {
          banner: '<%= banner %>'
        },
        src: 'src/videojs-media-sources.js',
        dest: 'dist/videojs-media-sources.min.js'
      }
    },
    connect: {
      server: {
        options: {
          keepalive: true
        }
      }
    },
    watch: {
      scripts: {
        files: [
          'src/**/*.js',
          'node_modules/mux.js/lib/**/*.js',
          'node_modules/mux.js/legacy/**/*.js'
        ],
        tasks: ['build'],
        options: {
          spawn: false,
        }
      }
    }
  });
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-connect');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-karma');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-watch');
  grunt.loadNpmTasks('grunt-browserify');

  grunt.registerTask('default', ['test', 'build']);
  grunt.registerTask('test', ['jshint', 'karma']);
  grunt.registerTask('build', ['clean', 'browserify:build', 'uglify:mediasource']);
  grunt.registerTask('dev', ['jshint', 'build', 'watch']);
};
