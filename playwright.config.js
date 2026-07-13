'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const root = __dirname;
const e2eWorkspace = path.join(root, '.local', 'dbgate-e2e');
const serverEnvironment = { ...process.env };
delete serverEnvironment.CONNECTIONS;
delete serverEnvironment.SINGLE_CONNECTION;
delete serverEnvironment.SINGLE_DATABASE;

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
      ...serverEnvironment,
      PORT: '3100',
      WORKSPACE_DIR: e2eWorkspace,
      LANGUAGE: 'en',
      CONSOLE_LOG_LEVEL: 'warn',
      FILE_LOG_LEVEL: 'warn',
    },
  },
});
