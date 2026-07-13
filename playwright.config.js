'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const root = __dirname;

module.exports = defineConfig({
  testDir: path.join(root, 'test', 'e2e'),
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/start-local.js',
    url: 'http://127.0.0.1:3100/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: '3100',
      WORKSPACE_DIR: path.join(root, '.local', 'dbgate'),
      LANGUAGE: 'en',
      CONSOLE_LOG_LEVEL: 'warn',
      FILE_LOG_LEVEL: 'warn',
      CONNECTIONS: 'relay',
      ENGINE_relay: 'relay-mysql@dbgate-plugin-relay-mysql',
      LABEL_relay: 'Relay fixture',
      READONLY_relay: '1',
      CONNECTION_relay_relayProfile: 'fixture',
      CONNECTION_relay_runnerPath: path.join(root, 'test', 'fixtures', 'fake-runner.js'),
      CONNECTION_relay_timeoutMs: '5000',
    },
  },
});

