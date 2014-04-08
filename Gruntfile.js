module.exports = function(grunt) {

  grunt.initConfig({
    jshint: {
      files: ['Gruntfile.js', 'src/**/*.js', 'test/**/*.js']
    },
    qunit: {
      files: ['test/index.html']
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
  grunt.loadNpmTasks('grunt-contrib-qunit');

  grunt.registerTask('default', ['jshint', 'qunit']);
};
