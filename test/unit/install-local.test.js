'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REQUIRED_INSTALLED_FILES,
  cleanInstallTarget,
  validateInstalledPlugin,
} = require('../../scripts/install-local');

test('clean reinstall preserves the DbGate workspace unless explicitly requested', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin-workspace-'));
  const pluginDirectory = path.join(workspace, 'plugins', 'dbgate-plugin-relay-mysql');
  const connectionState = path.join(workspace, 'connections.jsonl');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'old-plugin-file'), 'old');
  fs.writeFileSync(connectionState, 'private workspace state');

  cleanInstallTarget(workspace, pluginDirectory, ['--clean']);
  assert.equal(fs.existsSync(pluginDirectory), false);
  assert.equal(fs.readFileSync(connectionState, 'utf8'), 'private workspace state');

  cleanInstallTarget(workspace, pluginDirectory, ['--clean-workspace']);
  assert.equal(fs.existsSync(workspace), false);
});

test('local installation requires both relay runtime adapters', t => {
  const pluginDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-plugin-install-'));
  t.after(() => fs.rmSync(pluginDirectory, { recursive: true, force: true }));

  assert.ok(REQUIRED_INSTALLED_FILES.includes('bin/relay-mysql-runner.js'));
  assert.ok(REQUIRED_INSTALLED_FILES.includes('dist/broker.js'));
  assert.ok(REQUIRED_INSTALLED_FILES.includes('runner/relay-mysql.exp'));
  assert.ok(REQUIRED_INSTALLED_FILES.includes('runner/relay-mysql-session.exp'));

  for (const relative of REQUIRED_INSTALLED_FILES) {
    fs.mkdirSync(path.dirname(path.join(pluginDirectory, relative)), { recursive: true });
    fs.writeFileSync(path.join(pluginDirectory, relative), 'fixture');
  }
  assert.doesNotThrow(() => validateInstalledPlugin(pluginDirectory));

  fs.rmSync(path.join(pluginDirectory, 'bin/relay-mysql-runner.js'));
  assert.throws(
    () => validateInstalledPlugin(pluginDirectory),
    /Installed plugin is missing bin\/relay-mysql-runner\.js/
  );

  fs.writeFileSync(path.join(pluginDirectory, 'bin/relay-mysql-runner.js'), 'fixture');
  fs.rmSync(path.join(pluginDirectory, 'runner/relay-mysql.exp'));
  assert.throws(
    () => validateInstalledPlugin(pluginDirectory),
    /Installed plugin is missing runner\/relay-mysql\.exp/
  );
});
