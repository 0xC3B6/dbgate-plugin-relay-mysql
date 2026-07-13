#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.resolve(process.env.WORKSPACE_DIR || path.join(root, '.local', 'dbgate'));
const pluginDirectory = path.join(workspace, 'plugins', 'dbgate-plugin-relay-mysql');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return options.capture ? result.stdout.trim() : '';
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run('npm', args, options);
}

if (process.argv.includes('--clean')) {
  fs.rmSync(workspace, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(pluginDirectory), { recursive: true });

for (const name of fs.readdirSync(root)) {
  if (/^dbgate-plugin-relay-mysql-.*\.tgz$/.test(name)) {
    fs.rmSync(path.join(root, name), { force: true });
  }
}

runNpm(['run', 'build']);
const archive = runNpm(['pack', '--ignore-scripts', '--silent'], { capture: true }).split('\n').at(-1);

if (!archive || !archive.endsWith('.tgz')) {
  throw new Error('npm pack did not return a plugin archive');
}

run(process.execPath, [
  path.join(root, 'node_modules', 'dbgate-plugin-tools', 'bin', 'dbgate-copydist.js'),
  pluginDirectory,
]);

for (const relative of ['package.json', 'dist/frontend.js', 'dist/backend.js', 'dist/runner.js']) {
  if (!fs.existsSync(path.join(pluginDirectory, relative))) {
    throw new Error(`Installed plugin is missing ${relative}`);
  }
}

if (fs.existsSync(path.join(root, archive))) fs.rmSync(path.join(root, archive), { force: true });
process.stdout.write(`Installed plugin into ${pluginDirectory}\n`);
