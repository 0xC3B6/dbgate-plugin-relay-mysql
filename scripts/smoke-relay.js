#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { RelayMysqlError } = require('../src/backend/errors');
const { QueryExecutor } = require('../src/backend/query-executor');
const { RunnerClient } = require('../src/backend/runner-client');

const root = path.resolve(__dirname, '..');
const PROFILE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function usage() {
  return [
    'Usage: npm run smoke:relay -- --profile NAME [options]',
    '',
    'Options:',
    '  --profile-file PATH   Private profiles.json (otherwise runner default)',
    '  --runner PATH         Runner executable (otherwise bundled runner)',
    '  --timeout-ms NUMBER   Complete operation timeout (default: 30000)',
  ].join('\n');
}

function parseArgs(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--profile', '--profile-file', '--runner', '--timeout-ms'].includes(flag) || value == null) {
      throw new Error('invalid_arguments');
    }
    if (Object.hasOwn(values, flag)) throw new Error('invalid_arguments');
    values[flag] = value;
  }

  const profile = values['--profile'];
  const timeoutMs = Number(values['--timeout-ms'] ?? 30_000);
  if (!PROFILE.test(profile || '')) throw new Error('invalid_profile');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error('invalid_timeout');
  }

  return {
    profile,
    profileFile: values['--profile-file'] ? path.resolve(values['--profile-file']) : null,
    runner: values['--runner'] ? path.resolve(values['--runner']) : null,
    timeoutMs,
  };
}

async function runSmoke(options) {
  if (options.profileFile) {
    const stat = fs.lstatSync(options.profileFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new RelayMysqlError('runner', 'The smoke profile file is not a private regular file.');
    }
    process.env.DBGATE_RELAY_MYSQL_PROFILE_FILE = options.profileFile;
  }

  const runnerClient = new RunnerClient();
  const runnerPath = options.runner || path.join(root, 'bin', 'relay-mysql-runner.js');
  const queryExecutor = new QueryExecutor({ runnerClient });
  const dbhan = {
    relayProfile: options.profile,
    runnerPath,
    timeoutMs: options.timeoutMs,
    database: null,
    closed: false,
  };

  let runnerCalls = 0;
  const originalRun = runnerClient.run.bind(runnerClient);
  runnerClient.run = request => {
    runnerCalls += 1;
    return originalRun(request);
  };

  try {
    await queryExecutor.executeManual(dbhan, 'UPDATE relay_mysql_smoke SET value = 1');
    throw new RelayMysqlError('runner', 'The local read-only smoke check did not reject a write.');
  } catch (error) {
    if (!(error instanceof RelayMysqlError) || error.category !== 'sql_rejected' || runnerCalls !== 0) throw error;
  }

  const started = performance.now();
  const result = await queryExecutor.executeManual(dbhan, 'SELECT 1 AS relay_mysql_smoke', {
    collectRows: true,
  });
  const durationMs = Math.round(performance.now() - started);
  if (result.rowCount !== 1 || result.columns.length !== 1 || result.rows.length !== 1) {
    throw new RelayMysqlError('parse', 'The synthetic relay query returned an unexpected result shape.', {
      queryId: result.queryId,
    });
  }
  return { durationMs, queryId: result.queryId };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  try {
    const result = await runSmoke(options);
    process.stdout.write(`Relay smoke passed in ${result.durationMs} ms (queryId=${result.queryId}).\n`);
    return 0;
  } catch (error) {
    const category = error instanceof RelayMysqlError ? error.category : 'runner';
    const queryId = error instanceof RelayMysqlError && error.queryId ? error.queryId : 'unavailable';
    process.stderr.write(`Relay smoke failed (category=${category}, queryId=${queryId}).\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  });
}

module.exports = { main, parseArgs, runSmoke, usage };
