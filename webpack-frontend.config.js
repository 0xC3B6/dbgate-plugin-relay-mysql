'use strict';

const path = require('node:path');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  context: path.resolve(__dirname, 'src/frontend'),
  entry: './index.js',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'frontend.js',
    library: 'plugin',
    libraryTarget: 'var',
  },
  plugins: [
    new webpack.DefinePlugin({
      'global.DBGATE_PACKAGES': 'window.DBGATE_PACKAGES',
    }),
  ],
};

