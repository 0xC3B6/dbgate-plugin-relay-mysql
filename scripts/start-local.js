#!/usr/bin/env node
'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.env.PORT ||= '3100';
process.env.WORKSPACE_DIR ||= path.join(root, '.local', 'dbgate');

require('./loopback-preload');

const servePackage = require.resolve('dbgate-serve/package.json');
require(path.join(path.dirname(servePackage), 'bin', 'dbgate-serve.js'));

