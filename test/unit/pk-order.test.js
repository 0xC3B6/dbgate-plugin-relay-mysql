'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { addPrimaryKeyOrder } = require('../../src/backend/pk-order');

const snapshot = {
  tables: [
    {
      schemaName: 'app',
      pureName: 'events',
      primaryKey: {
        columns: [{ columnName: 'tenant_id' }, { columnName: 'event`id' }],
      },
    },
    { schemaName: 'app', pureName: 'without_pk', columns: [] },
  ],
};

test('DbGate basetbl page queries gain deterministic composite primary-key ordering', () => {
  const sql = [
    'SELECT `basetbl`.`tenant_id`, `basetbl`.`event_id`',
    'FROM `app`.`events` AS `basetbl`',
    'LIMIT 100 OFFSET 200',
  ].join('\n');

  const rewritten = addPrimaryKeyOrder(sql, { range: { limit: 100, offset: 200 }, snapshot });
  assert.equal(
    rewritten,
    [
      'SELECT `basetbl`.`tenant_id`, `basetbl`.`event_id`',
      'FROM `app`.`events` AS `basetbl`',
      'ORDER BY `basetbl`.`tenant_id`, `basetbl`.`event``id`',
      'LIMIT 100 OFFSET 200',
    ].join('\n')
  );
});

test('existing top-level sorting is never replaced', () => {
  const sql = [
    'SELECT `basetbl`.`tenant_id` FROM `app`.`events` AS `basetbl`',
    'ORDER BY `basetbl`.`created_at` DESC',
    'LIMIT 100 OFFSET 0',
  ].join('\n');
  assert.equal(addPrimaryKeyOrder(sql, { range: { limit: 100, offset: 0 }, snapshot }), sql);
});

test('ORDER BY inside a subquery does not hide missing top-level ordering', () => {
  const sql = [
    'SELECT `basetbl`.`tenant_id`, (SELECT value FROM audit ORDER BY created_at LIMIT 1) AS latest',
    'FROM `app`.`events` AS `basetbl`',
    'LIMIT 100 OFFSET 0',
  ].join('\n');
  assert.match(
    addPrimaryKeyOrder(sql, { range: { limit: 100, offset: 0 }, snapshot }),
    /ORDER BY `basetbl`\.`tenant_id`, `basetbl`\.`event``id`\nLIMIT/
  );
});

test('rewrite is limited to recognized ranged basetbl queries with a known primary key', () => {
  const cases = [
    ['SELECT * FROM `app`.`events` AS `basetbl` LIMIT 100', { snapshot }],
    ['SELECT * FROM `app`.`events` LIMIT 100', { range: { limit: 100 }, snapshot }],
    ['SELECT * FROM `app`.`without_pk` AS `basetbl` LIMIT 100', { range: { limit: 100 }, snapshot }],
    ['SELECT DISTINCT `basetbl`.`tenant_id` FROM `app`.`events` AS `basetbl` LIMIT 100', { range: { limit: 100 }, snapshot }],
    ['SELECT `basetbl`.`tenant_id` FROM `app`.`events` AS `basetbl`', { range: { limit: 100 }, snapshot }],
  ];

  for (const [sql, options] of cases) assert.equal(addPrimaryKeyOrder(sql, options), sql);
});
