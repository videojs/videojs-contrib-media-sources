module.exports = function(grunt) {

  grunt.initConfig({
    jshint: {
      files: ['Gruntfile.js', 'src/**/*.js', 'test/**/*.js']
    },
    karma: {
      test: {
        configFile: 'test/karma.conf.js'
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

  grunt.loadNpmTasks('grunt-contrib-connect');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-karma');

  grunt.registerTask('default', ['jshint', 'karma']);
};
