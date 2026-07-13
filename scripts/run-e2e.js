#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.local', 'dbgate-e2e');
const env = { ...process.env, WORKSPACE_DIR: workspace };

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run(path.join(__dirname, 'install-local.js'), ['--clean-workspace']);
run(require.resolve('@playwright/test/cli'), ['test']);
