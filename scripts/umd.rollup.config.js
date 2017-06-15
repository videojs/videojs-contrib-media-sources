/**
 * Rollup configuration for packaging the plugin in a module that is consumable
 * as the `src` of a `script` tag or via AMD or similar client-side loading.
 *
 * This module DOES include its dependencies.
 */
import babel from 'rollup-plugin-babel';
import commonjs from 'rollup-plugin-commonjs';
import json from 'rollup-plugin-json';
import resolve from 'rollup-plugin-node-resolve';
import worker from '@gkatsev/rollup-plugin-bundle-worker';

export default {
  moduleName: 'videojsContribMediaSources',
  entry: 'src/videojs-contrib-media-sources.js',
  dest: 'dist/videojs-contrib-media-sources.js',
  format: 'umd',
  external: ['video.js', 'global/window', 'global/document'],
  globals: {
    'video.js': 'videojs',
    'global/window': 'window',
    'global/document': 'document'
  },
  legacy: true,
  plugins: [
    worker(),
    resolve({
      browser: true,
      main: true,
      jsnext: true
    }),
    json(),
    babel({
      babelrc: false,
      exclude: ['node_modules/**', '**/flash-transmux-worker-bundle.js', '**/transmux-worker-bundle.js'],
      presets: [
        ['es2015', {
          loose: true,
          modules: false
        }]
      ],
      plugins: [
        'external-helpers',
        'transform-object-assign'
      ]
    })
  ]
};
