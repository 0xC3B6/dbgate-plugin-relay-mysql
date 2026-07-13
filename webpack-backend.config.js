'use strict';

const path = require('node:path');

module.exports = {
  mode: 'production',
  context: __dirname,
  entry: {
    backend: './src/backend/index.js',
    broker: './src/broker/server.js',
    runner: './src/runner/cli.js',
  },
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
  },
};
