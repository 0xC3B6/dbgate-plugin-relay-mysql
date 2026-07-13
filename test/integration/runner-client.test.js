'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const { RunnerClient } = require('../../src/backend/runner-client');

const fixture = path.resolve(__dirname, '../fixtures/fake-runner.js');

function run(client, overrides = {}) {
  return client.run({
    runnerPath: process.execPath,
    relayProfile: 'normal',
    database: 'fixture_db',
    timeoutMs: 1000,
    sql: "SELECT 'stdin-only-marker' AS transport",
    ...overrides,
  });
}

function createSyntheticChild(onKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => onKill(signal, child);
  return child;
}

test('runner client passes protocol fields as args and SQL only through stdin', async () => {
  const client = new RunnerClient({ prefixArgs: [fixture], randomUUID: () => 'request-fixture' });
  const result = await run(client);
  assert.equal(result.queryId, 'request-fixture');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.toString('utf8'), /<field name="transport">stdin<\/field>/);
  assert.equal(result.stderr.length, 0);
});

test('runner client maps structured runner failures without exposing stderr JSON', async () => {
  const client = new RunnerClient({ prefixArgs: [fixture], randomUUID: () => 'request-fixture' });
  await assert.rejects(
    run(client, { relayProfile: 'fail-relay', sql: 'SELECT 1' }),
    error => {
      assert.equal(error.category, 'relay_login');
      assert.equal(error.queryId, 'request-fixture');
      assert.equal(error.details.exitCode, 10);
      assert.match(error.message, /^Relay authentication failed(?: \(query ID: request-fixture\))?$/);
      assert.doesNotMatch(error.message, /synthetic/i);
      return true;
    }
  );
});

test('runner client enforces stdout and stderr byte limits', async () => {
  const stdoutClient = new RunnerClient({ prefixArgs: [fixture], maxStdoutBytes: 64 });
  await assert.rejects(
    run(stdoutClient, { relayProfile: 'large-stdout', sql: 'SELECT 1' }),
    error => error.category === 'result_too_large'
  );

  const stderrClient = new RunnerClient({ prefixArgs: [fixture], maxStderrBytes: 64 });
  await assert.rejects(
    run(stderrClient, { relayProfile: 'large-stderr', sql: 'SELECT 1' }),
    error => error.category === 'runner'
  );
});

test('runner client watchdog adds grace to the requested remote timeout', async () => {
  const client = new RunnerClient({ prefixArgs: [fixture] });
  const started = Date.now();
  await assert.rejects(
    run(client, { relayProfile: 'slow', timeoutMs: 40, sql: 'SELECT 1' }),
    error => error.category === 'timeout'
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1400, `watchdog fired too early after ${elapsed}ms`);
  assert.ok(elapsed < 3000, `watchdog fired too late after ${elapsed}ms`);
});

test('runner client rejects mixed stdout/stderr protocol responses', async () => {
  const client = new RunnerClient({ prefixArgs: [fixture], randomUUID: () => 'request-fixture' });
  await assert.rejects(
    run(client, { relayProfile: 'success-stderr', sql: 'SELECT 1' }),
    error => error.category === 'runner' && /invalid success response/.test(error.message)
  );
  await assert.rejects(
    run(client, { relayProfile: 'error-stdout', sql: 'SELECT 1' }),
    error => error.category === 'runner' && /invalid error response/.test(error.message)
  );
});

test('runner client maps spawn failures to the stable runner category', async () => {
  const client = new RunnerClient();
  await assert.rejects(
    run(client, { runnerPath: '/synthetic/missing-runner', sql: 'SELECT 1' }),
    error => error.category === 'runner'
  );
});

test('runner client consumes an asynchronous spawn error when already aborted', async () => {
  const signals = [];
  const child = createSyntheticChild((signal, syntheticChild) => {
    signals.push(signal);
    return true;
  });
  const client = new RunnerClient({
    spawn: () => {
      setImmediate(() => {
        child.emit('error', new Error('synthetic spawn failure'));
        child.exitCode = -2;
        child.emit('close', -2);
      });
      return child;
    },
    randomUUID: () => 'request-fixture',
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    run(client, { signal: controller.signal }),
    error => error.category === 'runner' && /cancelled locally/.test(error.message)
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(signals, ['SIGTERM']);
});

test('runner client gives the runner a SIGTERM cleanup window before SIGKILL fallback', async () => {
  const gracefulSignals = [];
  const gracefulChild = createSyntheticChild((signal, child) => {
    gracefulSignals.push(signal);
    if (signal === 'SIGTERM') {
      setImmediate(() => {
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
      });
    }
    return true;
  });
  const gracefulClient = new RunnerClient({
    spawn: () => gracefulChild,
    randomUUID: () => 'request-fixture',
  });
  const gracefulAbort = new AbortController();
  const gracefulRun = run(gracefulClient, { signal: gracefulAbort.signal });
  gracefulAbort.abort();
  await assert.rejects(gracefulRun, error => error.category === 'runner');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(gracefulSignals, ['SIGTERM']);

  const stubbornSignals = [];
  const stubbornChild = createSyntheticChild((signal, child) => {
    stubbornSignals.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
    }
    return true;
  });
  const stubbornClient = new RunnerClient({
    spawn: () => stubbornChild,
    randomUUID: () => 'request-fixture',
  });
  const stubbornAbort = new AbortController();
  const stubbornRun = run(stubbornClient, { signal: stubbornAbort.signal });
  stubbornAbort.abort();
  await assert.rejects(stubbornRun, error => error.category === 'runner');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(stubbornSignals, ['SIGTERM', 'SIGKILL']);
});
