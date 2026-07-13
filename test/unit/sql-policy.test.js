'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RelayMysqlError } = require('../../src/backend/errors');
const {
  prepareManualSql,
  prepareTableDataSql,
  validateReadOnlySql,
} = require('../../src/backend/sql-policy');

test('read-only policy accepts the supported statement roots', () => {
  for (const sql of [
    'SELECT 1',
    'SHOW TABLES',
    'DESC `users`',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM users',
    'EXPLAIN FORMAT=JSON SELECT * FROM users',
  ]) {
    assert.doesNotThrow(() => validateReadOnlySql(sql));
  }
});

test('read-only policy rejects other roots and multiple statements', () => {
  for (const sql of [
    'UPDATE users SET active = 1',
    'DELETE FROM users',
    'WITH values_cte AS (SELECT 1) SELECT * FROM values_cte',
    'SELECT 1; SELECT 2',
    'EXPLAIN UPDATE users SET active = 1',
  ]) {
    assert.throws(
      () => validateReadOnlySql(sql),
      error => error instanceof RelayMysqlError && error.category === 'sql_rejected'
    );
  }
  assert.doesNotThrow(() => validateReadOnlySql("SELECT ';' AS semicolon; -- trailing comment"));
});

test('read-only policy rejects MySQL escape hatches and locking reads', () => {
  const forbidden = [
    'SELECT * INTO OUTFILE \'/tmp/private\' FROM users',
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM users FOR SHARE',
    'SELECT * FROM users LOCK IN SHARE MODE',
    'SELECT @value := secret FROM users',
    'SELECT SLEEP(10)',
    'SELECT sys.BENCHMARK(10, 1)',
    'SELECT `SLEEP`(10)',
    'SELECT LOAD_FILE(\'/tmp/private\')',
    'SELECT 1 /*!50000 UNION SELECT secret FROM users */',
    'SELECT 1\nDELIMITER //',
    'SELECT 1\nCHARSET utf8mb4',
    'SELECT 1\\C utf8mb4',
  ];

  for (const sql of forbidden) {
    assert.throws(
      () => validateReadOnlySql(sql),
      error => error instanceof RelayMysqlError && !error.message.includes('private')
    );
  }
});

test('read-only policy rejects MySQL delimiter and charset client commands', () => {
  const clientCommands = [
    'SELECT 1\nDELIMITER //',
    'SELECT 1\nCHARSET utf8mb4',
    'SELECT 1\\C utf8mb4',
    'SELECT 1\\d//\nSELECT 2//',
    'SELECT 1\\D$$\nSELECT 2$$',
  ];

  for (const sql of clientCommands) {
    assert.throws(
      () => validateReadOnlySql(sql),
      error =>
        error instanceof RelayMysqlError &&
        error.category === 'sql_rejected' &&
        error.details?.rule === 'mysql_client_command'
    );
  }

  assert.doesNotThrow(() => validateReadOnlySql(String.raw`SELECT '\d' AS literal_value`));
});

test('manual SELECT appends a 5001-row probe before trailing comments', () => {
  const plain = prepareManualSql('SELECT * FROM users;');
  assert.equal(plain.sql, 'SELECT * FROM users LIMIT 5001');
  assert.equal(plain.maxVisibleRows, 5000);
  assert.equal(plain.truncationProbe, true);

  const commented = prepareManualSql('SELECT * FROM users -- keep this\n');
  assert.equal(commented.sql, 'SELECT * FROM users LIMIT 5001 -- keep this\n');
});

test('manual SELECT preserves supported explicit LIMIT forms up to 5000', () => {
  for (const sql of [
    'SELECT * FROM users LIMIT 5000',
    'SELECT * FROM users LIMIT 10, 5000',
    'SELECT * FROM users LIMIT 5000 OFFSET 10',
  ]) {
    const prepared = prepareManualSql(sql);
    assert.equal(prepared.sql, sql);
    assert.equal(prepared.truncationProbe, false);
    assert.equal(prepared.explicitLimit.count, 5000);
  }

  assert.throws(() => prepareManualSql('SELECT * FROM users LIMIT 5001'), RelayMysqlError);
  assert.throws(() => prepareManualSql('SELECT * FROM users LIMIT ?'), RelayMysqlError);
});

test('a nested LIMIT does not satisfy the manual top-level bound', () => {
  const prepared = prepareManualSql('SELECT * FROM (SELECT * FROM users LIMIT 1) AS nested');
  assert.match(prepared.sql, /AS nested LIMIT 5001$/);
});

test('a leading byte-order mark does not shift the inserted LIMIT position', () => {
  assert.equal(prepareManualSql('\uFEFFSELECT 1;').sql, '\uFEFFSELECT 1 LIMIT 5001');
});

test('SHOW, DESC and EXPLAIN are validated but do not receive a SELECT row probe', () => {
  for (const sql of ['SHOW TABLES', 'DESC users', 'EXPLAIN SELECT * FROM users']) {
    const prepared = prepareManualSql(sql);
    assert.equal(prepared.sql, sql);
    assert.equal(prepared.maxVisibleRows, 5000);
  }
});

test('table-data SQL skips the manual 5000-row cap', () => {
  const sql = 'SELECT `basetbl`.`id` FROM `app`.`users` AS `basetbl` LIMIT 10000 OFFSET 0';
  const prepared = prepareTableDataSql(sql, { range: { limit: 10000, offset: 0 } });
  assert.equal(prepared.sql, sql);
  assert.equal(prepared.maxVisibleRows, null);
});
