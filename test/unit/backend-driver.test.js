'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { driverBase } = require('dbgate-tools');

global.DBGATE_PACKAGES = { 'dbgate-tools': { driverBase } };

const { createBackendDriver } = require('../../src/backend/driver');

function createHarness() {
  const calls = { manual: [], table: [], internal: [], metadata: [] };
  let metadataFresh = false;
  const queryExecutor = {
    async executeManual(_dbhan, sql, options = {}) {
      calls.manual.push(sql);
      const columns = [{ columnName: 'value' }];
      const row = { value: '1' };
      options.onColumns?.(columns);
      options.onRow?.(row);
      return { columns, rows: [row], rowCount: 1, truncated: sql.includes('truncate_me') };
    },
    async executeTableData(_dbhan, sql, options = {}) {
      calls.table.push({ sql, range: options.range, snapshot: options.snapshot });
      const columns = [{ columnName: 'id' }];
      options.onColumns?.(columns);
      options.onRow?.({ id: '1' });
      return { columns, rows: [], rowCount: 1, truncated: false };
    },
    async executeInternal(_dbhan, sql) {
      calls.internal.push(sql);
      if (sql.includes('VERSION')) {
        return { columns: [{ columnName: 'version' }], rows: [{ version: '5.7.24-fixture' }] };
      }
      return {
        columns: [{ columnName: 'Database' }],
        rows: [{ Database: 'fixture_db' }, { Database: 'mysql' }, { Database: 'information_schema' }],
      };
    },
  };
  const snapshot = { tables: [{ pureName: 'wide_table' }], views: [] };
  const metadataService = {
    async load(_dbhan, options) {
      calls.metadata.push(options);
      metadataFresh = true;
      return snapshot;
    },
    isFresh() {
      return metadataFresh;
    },
  };
  const inlineProfiles = [];
  const createInlineProfileFile = connection => {
    const profile = {
      connection,
      filePath: `/private/profile-${inlineProfiles.length + 1}.json`,
      profileName: 'inline',
      cleaned: false,
      cleanup() {
        profile.cleaned = true;
      },
    };
    inlineProfiles.push(profile);
    return profile;
  };
  return {
    calls,
    driver: createBackendDriver({ queryExecutor, metadataService, runnerClient: {}, createInlineProfileFile }),
    inlineProfiles,
    expireMetadata() {
      metadataFresh = false;
    },
  };
}

test('backend driver creates and closes a logical one-shot handle', async () => {
  const { driver } = createHarness();
  const handle = await driver.connect({
    conid: 'fixture', relayProfile: 'profile', runnerPath: '/synthetic/runner',
    database: 'fixture_db', timeoutMs: '1234', password: 'not-retained',
  });
  assert.deepEqual(
    {
      conid: handle.conid, relayProfile: handle.relayProfile, runnerPath: handle.runnerPath,
      database: handle.database, timeoutMs: handle.timeoutMs, password: handle.password,
      persistentSession: handle.persistentSession,
    },
    {
      conid: 'fixture', relayProfile: 'profile', runnerPath: '/synthetic/runner',
      database: 'fixture_db', timeoutMs: 1234, password: undefined, persistentSession: false,
    }
  );
  assert.equal(handle.closed, false);
  assert.deepEqual(handle.client, {
    persistentSession: false, relayProfile: 'profile', runnerPath: '/synthetic/runner', timeoutMs: 1234,
  });
  await driver.close(handle);
  assert.equal(handle.closed, true);
});

test('backend driver rejects missing profile and invalid timeout without starting a runner', async () => {
  const { driver } = createHarness();
  await assert.rejects(driver.connect({ timeoutMs: 30000 }), error => error.category === 'relay_login');
  await assert.rejects(
    driver.connect({ relayProfile: 'profile', timeoutMs: 10 }),
    error => error.category === 'runner'
  );
});

test('backend driver materializes and cleans an inline connection profile', async () => {
  const { driver, inlineProfiles } = createHarness();
  const handle = await driver.connect({
    conid: 'inline-fixture',
    useInlineProfile: true,
    relayCommand: '/safe/relay-cli',
    relayArgs: ['login'],
    relayPrompt: 'RELAY> $',
    sshTarget: 'reader@example.invalid',
    sshPrompt: 'REMOTE> $',
    mysqlHost: '127.0.0.1',
    mysqlUserEnv: 'TEST_MYSQL_USER',
    mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
  });

  assert.equal(inlineProfiles.length, 1);
  assert.equal(handle.relayProfile, 'inline');
  assert.equal(handle.profileFile, '/private/profile-1.json');
  assert.equal(handle.client.profileFile, undefined);
  assert.equal(inlineProfiles[0].cleaned, false);
  await driver.close(handle);
  assert.equal(inlineProfiles[0].cleaned, true);
  await driver.close(handle);
  assert.equal(inlineProfiles[0].cleaned, true);
});

test('query routes DbGate ranges while database discovery still lists all permitted databases', async () => {
  const { calls, driver } = createHarness();
  const handle = await driver.connect({
    relayProfile: 'profile', runnerPath: '/synthetic/runner', defaultDatabase: 'fixture_db',
  });
  const dumper = driver.createDumper();
  dumper.put('^select * ^from %i', 'wide_table');
  assert.match(dumper.s, /select \* from `wide_table`/i);
  handle.metadataSnapshot = { tables: [{ pureName: 'wide_table' }] };
  assert.deepEqual(await driver.query(handle, 'SELECT 1'), {
    columns: [{ columnName: 'value' }], rows: [{ value: '1' }],
  });
  const range = { offset: 0, limit: 100 };
  await driver.query(handle, 'SELECT * FROM `wide_table` basetbl LIMIT 100 OFFSET 0', { range });
  assert.equal(calls.manual.length, 1);
  assert.deepEqual(calls.table[0], {
    sql: 'SELECT * FROM `wide_table` basetbl LIMIT 100 OFFSET 0',
    range,
    snapshot: handle.metadataSnapshot,
  });
  assert.equal((await driver.getVersion(handle)).version, 'relay-session');
  assert.deepEqual(await driver.listDatabases(handle), [{ name: 'fixture_db' }]);
  assert.deepEqual(calls.internal, ['SHOW DATABASES']);
});

test('full analysis forces refresh while incremental analysis observes TTL cache', async () => {
  const { calls, driver, expireMetadata } = createHarness();
  const handle = await driver.connect({ relayProfile: 'profile', runnerPath: '/synthetic/runner', database: 'fixture_db' });
  const full = await driver.analyseFull(handle);
  assert.strictEqual(handle.metadataSnapshot, full);
  assert.equal(await driver.analyseIncremental(handle, {}), null);
  expireMetadata();
  const refreshed = await driver.analyseIncremental(handle, {});
  assert.strictEqual(handle.metadataSnapshot, refreshed);
  assert.deepEqual(calls.metadata, [{ force: true }, { force: false }]);
});

test('failed incremental refresh leaves the last successful handle snapshot in place', async () => {
  const previous = { tables: [{ pureName: 'previous' }] };
  const metadataService = {
    isFresh: () => false,
    async load() {
      throw new Error('synthetic refresh failure');
    },
  };
  const driver = createBackendDriver({ queryExecutor: {}, metadataService, runnerClient: {} });
  const handle = { metadataSnapshot: previous };
  await assert.rejects(driver.analyseIncremental(handle, previous), /synthetic refresh failure/);
  assert.strictEqual(handle.metadataSnapshot, previous);
});

test('stream emits recordset, rows, truncation info and done exactly once', async () => {
  const { driver } = createHarness();
  const events = [];
  await driver.stream({}, 'SELECT truncate_me', {
    recordset: columns => events.push(['recordset', columns]),
    row: row => events.push(['row', row]),
    info: info => events.push(['info', info]),
    done: () => events.push(['done']),
  });
  assert.deepEqual(events.map(event => event[0]), ['recordset', 'row', 'info', 'done']);
  assert.equal(events.filter(event => event[0] === 'done').length, 1);
  assert.equal(events[2][1].line, 0);
  assert.ok(events[2][1].time instanceof Date);
});

test('readQuery returns an object stream with one header followed by rows', async () => {
  const { calls, driver } = createHarness();
  const structure = { columns: [{ columnName: 'id', dataType: 'bigint' }] };
  const stream = await driver.readQuery({}, 'SELECT * FROM `wide_table` LIMIT 100 OFFSET 0', structure);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks[0].__isStreamHeader, true);
  assert.deepEqual(chunks[0].columns, structure.columns);
  assert.deepEqual(chunks[1], { id: '1' });
  assert.strictEqual(calls.table[0].snapshot, structure);
});
