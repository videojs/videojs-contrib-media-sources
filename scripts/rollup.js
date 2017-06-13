const sh = require('shelljs');
const rollup = require('rollup');
const babel = require('rollup-plugin-babel');
const resolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');
const json = require('rollup-plugin-json');
const filesize = require('rollup-plugin-filesize');
const progress = require('rollup-plugin-progress');
const ignore = require('rollup-plugin-ignore');

const args = { progress: false };

sh.rm('-rf', 'tmp/');
sh.cp('-R', 'src/', 'tmp/');
sh.rm('-rf', 'tmp/worker.js');

const worker = (name) => {
  sh.exec([
    `browserify src/${name}.js`,
    '-t babelify',
    '-p [ browserify-derequire ]',
    '-p [ bundle-collapser/plugin.js ]',
    `> tmp/${name}.js`
  ].join(' '));
}

worker('workers');

const primedResolve = resolve({
  jsnext: true,
  main: true,
  browser: true
});
const primedCjs = commonjs({
  sourceMap: false,
});
const primedBabel = babel({
  babelrc: false,
  exclude: 'node_modules/**',
  presets: [
    'es3',
    ['es2015', {
      loose: true,
      modules: false
    }]
  ],
  plugins: ['external-helpers']
});

const es = {
  options: {
    entry: 'tmp/videojs-contrib-media-sources.js',
    plugins: [
      json(),
      primedBabel,
      args.progress ? progress() : {},
      filesize()
    ],
    onwarn(warning) {
      if (warning.code === 'UNUSED_EXTERNAL_IMPORT' ||
          warning.code === 'UNRESOLVED_IMPORT') {
        return;
      }

      // eslint-disable-next-line no-console
      console.warn(warning.message);
    },
    legacy: true
  },
  format: 'es',
  dest: 'dist/videojs-contrib-media-sources.es.js'
};

const cjs = Object.assign({}, es, {
  format: 'cjs',
  dest: 'dist/videojs-contrib-media-sources.cjs.js'
});

const umd = {
  options: {
    entry: 'tmp/videojs-contrib-media-sources.js',
    plugins: [
      // ignore(['video.js', 'global/window', 'global/document']),
      primedResolve,
      json(),
      primedCjs,
      primedBabel,
      // args.progress ? progress() : {},
    ],
    legacy: true,
    external: ['video.js', 'global/window', 'global/document'],
  },
  globals: {
    'video.js': 'videojs',
      'global/window': 'window',
      'global/document': 'document'
  },
  format: 'umd',
  dest: 'dist/videojs-contrib-media-sources.umd.js'
};

function runRollup({options, format, external, globals, dest, banner}) {
  rollup.rollup(options)
  .then(function(bundle) {
    bundle.write({
      format,
      dest,
      banner,
      external,
      globals,
      moduleName: 'videojs-contrib-hls',
      sourceMap: false
    });
  }, function(err) {
    // eslint-disable-next-line no-console
    console.error(err);
  });
}

runRollup(es);
// runRollup(cjs);
runRollup(umd);
