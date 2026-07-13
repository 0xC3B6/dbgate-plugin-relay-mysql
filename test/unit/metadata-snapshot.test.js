'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MetadataSnapshotService,
  createSqlUtf8Literal,
  createMetadataSnapshotSql,
  mapMetadataRows,
} = require('../../src/backend/metadata-snapshot');
const { MetadataCache } = require('../../src/backend/metadata-cache');

const rows = [
  {
    object_name: 'wide_table', object_kind: 'BASE TABLE', column_name: 'first_id',
    ordinal_position: '1', data_type: 'bigint', column_type: 'bigint unsigned',
    is_nullable: 'NO', extra: 'auto_increment', primary_key_ordinal: '2',
  },
  {
    object_name: 'wide_table', object_kind: 'BASE TABLE', column_name: 'second_id',
    ordinal_position: '2', data_type: 'bigint', column_type: 'bigint',
    is_nullable: 'NO', extra: '', primary_key_ordinal: '1',
  },
  {
    object_name: 'visible_view', object_kind: 'VIEW', column_name: 'name',
    ordinal_position: '1', data_type: 'varchar', column_type: 'varchar(255)',
    is_nullable: 'YES', extra: '', primary_key_ordinal: null,
  },
];

test('metadata mapper builds DbGate tables, views, columns and PK order', () => {
  const snapshot = mapMetadataRows(rows, 'fixture_db');
  assert.equal(snapshot.tables.length, 1);
  assert.equal(snapshot.views.length, 1);
  assert.equal(snapshot.engine, 'relay-mysql@dbgate-plugin-relay-mysql');
  assert.equal(snapshot.tables[0].engine, snapshot.engine);
  assert.equal(snapshot.views[0].engine, snapshot.engine);
  assert.deepEqual(snapshot.tables[0].columns.map(column => column.columnName), ['first_id', 'second_id']);
  assert.equal(snapshot.tables[0].columns[0].dataType, 'bigint unsigned');
  assert.equal(snapshot.tables[0].columns[0].autoIncrement, true);
  assert.deepEqual(
    snapshot.tables[0].primaryKey.columns.map(column => column.columnName),
    ['second_id', 'first_id']
  );
  assert.equal(snapshot.views[0].columns[0].dataType, 'varchar(255)');
});

test('metadata query scopes one database with a backslash-mode-safe UTF-8 hex literal', () => {
  const database = "a\\'数据库";
  const literal = createSqlUtf8Literal(database);
  assert.equal(literal, `CONVERT(0x${Buffer.from(database).toString('hex')} USING utf8mb4)`);
  const sql = createMetadataSnapshotSql(database);
  assert.match(sql, /FROM information_schema\.TABLES/);
  assert.equal(sql.includes(`t.TABLE_SCHEMA = ${literal}`), true);
  assert.equal(sql.includes(database), false);
  assert.doesNotMatch(sql, /数据库/);
  assert.match(sql, /KEY_COLUMN_USAGE/);
  assert.doesNotMatch(sql, /LIMIT 5001/);
});

test('metadata service caches incremental loads and force-refreshes full loads', async () => {
  let calls = 0;
  const queryExecutor = {
    async executeInternal(_dbhan, _sql, options) {
      calls += 1;
      assert.equal(options.maxRows, null);
      return { rows };
    },
  };
  const service = new MetadataSnapshotService({ queryExecutor, cache: new MetadataCache() });
  const dbhan = {
    conid: 'fixture', relayProfile: 'profile', runnerPath: '/synthetic/runner', database: 'fixture_db',
  };
  await service.load(dbhan, { force: false });
  assert.equal(service.isFresh(dbhan), true);
  await service.load(dbhan, { force: false });
  assert.equal(calls, 1);
  await service.load(dbhan, { force: true });
  assert.equal(calls, 2);
});
