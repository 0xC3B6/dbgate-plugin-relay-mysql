#!/usr/bin/env node
'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.env.PORT ||= '3100';
process.env.WORKSPACE_DIR ||= path.join(root, '.local', 'dbgate');
// DbGate logs SQL at info/debug levels. Keep the repository launcher at warn
// unless the user deliberately opts into more verbose (and potentially
// sensitive) DbGate logging.
process.env.CONSOLE_LOG_LEVEL ||= 'warn';
process.env.FILE_LOG_LEVEL ||= 'warn';

const logLevelPreload = path.join(__dirname, 'log-level-preload.js');
require(logLevelPreload);
// child_process.fork() inherits process.execArgv. This applies the safe logger
// defaults to DbGate's session and connection workers without NODE_OPTIONS or
// path quoting hazards.
if (!process.execArgv.includes(logLevelPreload)) {
  process.execArgv.push('--require', logLevelPreload);
}

require('./loopback-preload');

const servePackage = require.resolve('dbgate-serve/package.json');
require(path.join(path.dirname(servePackage), 'bin', 'dbgate-serve.js'));
