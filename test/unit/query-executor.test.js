'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RelayMysqlError } = require('../../src/backend/errors');
const { QueryExecutor, preparedMaxRows } = require('../../src/backend/query-executor');

function createHarness(overrides = {}) {
  const calls = { runner: [], parser: [] };
  const runnerClient = {
    async run(options) {
      calls.runner.push(options);
      return { queryId: 'query-abc123', stdout: Buffer.from('<fixture/>') };
    },
  };
  const parser = async (readable, options) => {
    let payload = '';
    for await (const chunk of readable) payload += chunk.toString('utf8');
    calls.parser.push({ payload, options });
    const columns = [{ columnName: 'value', dataType: 'string' }];
    const row = { value: '1' };
    options.onColumns?.(columns);
    options.onRow?.(row, 0);
    return { columns, rows: options.collectRows === false ? [] : [row], rowCount: 1, truncated: false };
  };
  const executor = new QueryExecutor({
    runnerClient,
    parseMysqlXml: overrides.parseMysqlXml || parser,
    prepareManualSql: sql => ({
      sql: `${sql} LIMIT 5001`, statementType: 'select', maxVisibleRows: 5000,
      truncationProbe: true, explicitLimit: false,
    }),
    prepareTableDataSql: sql => ({
      sql, statementType: 'select', maxVisibleRows: null, truncationProbe: false, explicitLimit: true,
    }),
  });
  return { calls, executor };
}

const dbhan = {
  relayProfile: 'fixture-profile', profileFile: '/private/inline-profile.json',
  runnerPath: '/synthetic/runner', database: 'fixture_db', timeoutMs: 30000,
};

test('manual execution sends prepared SQL only over runner stdin input', async () => {
  const { calls, executor } = createHarness();
  const result = await executor.executeManual(dbhan, 'SELECT 1', { collectRows: true });
  assert.equal(calls.runner[0].sql, 'SELECT 1 LIMIT 5001');
  assert.equal(calls.runner[0].runnerPath, '/synthetic/runner');
  assert.equal(calls.runner[0].profileFile, '/private/inline-profile.json');
  assert.equal(calls.parser[0].options.maxRows, 5000);
  assert.equal(result.queryId, 'query-abc123');
  assert.deepEqual(result.rows, [{ value: '1' }]);
});

test('table and internal execution have no manual 5000-row cap', async () => {
  const { calls, executor } = createHarness();
  await executor.executeTableData(dbhan, 'SELECT * FROM `wide_table` LIMIT 100 OFFSET 0');
  await executor.executeInternal(dbhan, 'SHOW DATABASES', { maxRows: null });
  assert.equal(calls.parser[0].options.maxRows, null);
  assert.equal(calls.parser[1].options.maxRows, null);
  assert.equal(calls.runner[1].sql, 'SHOW DATABASES');
});

test('parser callbacks are forwarded without collecting rows for stream mode', async () => {
  const { executor } = createHarness();
  const events = [];
  const result = await executor.executeManual(dbhan, 'SELECT 1', {
    collectRows: false,
    onColumns: columns => events.push(['columns', columns]),
    onRow: row => events.push(['row', row]),
  });
  assert.deepEqual(events.map(event => event[0]), ['columns', 'row']);
  assert.deepEqual(result.rows, []);
});

test('parse errors gain the runner query id without SQL or XML in the message', async () => {
  const { executor } = createHarness({
    parseMysqlXml: async () => {
      throw new RelayMysqlError('parse', 'MySQL XML result is malformed');
    },
  });
  await assert.rejects(
    executor.executeManual(dbhan, 'SELECT confidential_marker'),
    error => {
      assert.equal(error.category, 'parse');
      assert.equal(error.queryId, 'query-abc123');
      assert.doesNotMatch(error.message, /confidential_marker|fixture/i);
      return true;
    }
  );
});

test('preparedMaxRows supports the preferred and compatibility property names', () => {
  assert.equal(preparedMaxRows({ maxVisibleRows: 123 }), 123);
  assert.equal(preparedMaxRows({ visibleRowLimit: 456 }), 456);
  assert.equal(preparedMaxRows({}), 5000);
});
