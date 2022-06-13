import { join } from 'path';
import { defineConfig } from 'rollup';
import image from '@rollup/plugin-image';
import alias from '@rollup/plugin-alias';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';
import serve from 'rollup-plugin-serve';
import preact from 'rollup-plugin-preact';
import styles from 'rollup-plugin-styles';
import { terser } from 'rollup-plugin-terser';
import livereload from 'rollup-plugin-livereload';

const DEV = process.env.ROLLUP_WATCH;
const DIST = 'dist';

const relative = path => join(__dirname, path);
const getDestFolder = (path) => (DEV ? DIST : relative('../paf-mvp-demo-express/public/assets')) + path

// https://rollupjs.org/guide/en/#configuration-files
export default [
  /*defineConfig({
    input: relative('src/lib/paf-lib.ts'),
    output: {
      file: getDestFolder(`/paf-lib.js`),
      format: 'umd',
      name: 'PAF',
      sourcemap: DEV !== undefined
    },
    treeshake: 'smallest', // remove unused code
    plugins: [
      typescript({
        tsconfig: relative('../tsconfig.json'),
        sourceMap: DEV !== undefined,
      }),
      commonjs(),
      nodeResolve(),
      ...(() => {
        if (DEV) {
          return []
        } else {
          return [
            terser(), // minify js output
          ]
        }
      })(),
    ]
  }),*/
  defineConfig({
    input: relative('src/main.ts'), // entry file
    output: {
      file: getDestFolder(`/app.bundle.js`),
      format: 'umd', // preact-habitat requires "umd" format
      name: 'bundle',
      sourcemap: DEV !== undefined,
    },
    treeshake: 'recommended', // remove unused code
    plugins: [ // a list of plugins we apply to the source code
      alias({ // create aliases to replace import sources
        entries: [
          {find: 'react', replacement: 'preact/compat'},
          {find: 'react-dom/test-utils', replacement: 'preact/test-utils'},
          {find: 'react-dom', replacement: 'preact/compat'},
          {find: 'react/jsx-runtime', replacement: 'preact/jsx-runtime'}
        ]
      }),
      replace({ // replace value in runtime
        preventAssignment: true,
        'process.env.NODE_ENV': JSON.stringify(DEV ? 'development' : 'production'),
        'env__development': DEV ? 'env__development' : 'env__production' // to import correct env file
      }),
      styles({
        modules: true,
        mode: [
          "inject", { singleTag: true, prepend: true, attributes: { id: 'PAF-styles' } },
        ]
      }),
      image(), // allow to import images into ts code (as base64)
      preact({ // compile preact components to javascript
        usePreactX: false,
        noPropTypes: false,
        noReactIs: false,
        noEnv: false,
        browser: true,
        resolvePreactCompat: true,
      }),
      typescript({
          tsconfig: relative('../tsconfig.json'),
          sourceMap: DEV !== undefined,
        }
      ), // compile typescript => js
      ...(() => {
        if (!DEV) { // list of plugins for production
          return [
            terser(), // minify js output
            copy({ // copy files
              targets: [
                {
                  src: './assets/*',
                  dest: '../paf-mvp-demo-express/public/assets',
                },
              ],
            }),
          ]
        } else { // list of plugins for development
          return [
            copy({ // copy files
              targets: [
                {
                  src: './assets/*',
                  dest: 'dist',
                },
              ],
            }),
            serve({ // dev server
              contentBase: '',
              headers: {
                'Access-Control-Allow-Origin': '*'
              },
              open: false, // change to true to open browser automatically
              openPage: '/',
              // Set to true to return index.html (200) instead of error page (404)
              historyApiFallback: true,
              host: 'localhost',
              port: 3000,
            }),
            livereload({ // reload the page if any changes
              watch: DIST,
            })
          ]
        }
      })(),
    ],
  })
];
