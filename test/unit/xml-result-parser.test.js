'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { RelayMysqlError } = require('../../src/backend/errors');
const {
  DEFAULT_MAX_BYTES,
  parseMysqlXml,
} = require('../../src/backend/xml-result-parser');

const fixturePath = name => path.join(__dirname, '..', 'fixtures', 'xml', name);

test('streaming parser preserves NULL, entities, Unicode, newlines, tabs and empty strings', async () => {
  const xml = fs.readFileSync(fixturePath('basic.xml'));
  const unicodeStart = xml.indexOf(Buffer.from('中'));
  const chunks = [
    xml.subarray(0, unicodeStart + 1),
    xml.subarray(unicodeStart + 1, unicodeStart + 2),
    xml.subarray(unicodeStart + 2),
  ];

  const result = await parseMysqlXml(Readable.from(chunks));
  assert.deepEqual(
    result.columns.map(column => column.columnName),
    ['id', 'nullable', 'text', 'multiline', 'empty', 'dup', 'dup__2']
  );
  assert.equal(result.rows[0].nullable, null);
  assert.equal(result.rows[0].text, '<tag> & "quoted" 中文🙂');
  assert.equal(result.rows[0].multiline, 'line one\nline two\ttail');
  assert.equal(result.rows[0].empty, '');
  assert.equal(result.rows[0].dup, 'first');
  assert.equal(result.rows[0].dup__2, 'second');
  assert.equal(result.rows[1].nullable, 'not null');
  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, false);
});

test('callbacks receive columns before rows and collectRows false does not retain row copies', async () => {
  const events = [];
  const result = await parseMysqlXml(fs.createReadStream(fixturePath('basic.xml')), {
    collectRows: false,
    onColumns: columns => events.push(['columns', columns.length]),
    onRow: (row, index) => events.push(['row', index, row.id]),
  });

  assert.deepEqual(events, [
    ['columns', 7],
    ['row', 0, '1'],
    ['row', 1, '2'],
  ]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 2);
});

test('empty resultsets report an empty column list exactly once', async () => {
  const emitted = [];
  const result = await parseMysqlXml(fs.createReadStream(fixturePath('empty.xml')), {
    onColumns: columns => emitted.push(columns),
  });

  assert.deepEqual(result, { columns: [], rows: [], rowCount: 0, truncated: false });
  assert.deepEqual(emitted, [[]]);
});

test('maxRows truncates visible output while null disables only the row bound', async () => {
  const xml = [
    '<resultset>',
    ...Array.from({ length: 5 }, (_, index) => `<row><field name="id">${index}</field></row>`),
    '</resultset>',
  ].join('');

  const bounded = await parseMysqlXml(xml, { maxRows: 3 });
  assert.equal(bounded.rowCount, 3);
  assert.equal(bounded.rows.length, 3);
  assert.equal(bounded.truncated, true);

  const unlimited = await parseMysqlXml(xml, { maxRows: null });
  assert.equal(unlimited.rowCount, 5);
  assert.equal(unlimited.rows.length, 5);
  assert.equal(unlimited.truncated, false);
});

test('malformed XML, invalid control data and invalid UTF-8 fail without echoing SQL or XML', async () => {
  const malformed = fs.readFileSync(fixturePath('malformed.xml'));
  const inputs = [
    malformed,
    '<resultset><row><field name="secret">private\x01value</field></row></resultset>',
    Buffer.from([0xff, 0xfe, 0xfd]),
  ];

  for (const input of inputs) {
    await assert.rejects(
      parseMysqlXml(input),
      error =>
        error instanceof RelayMysqlError &&
        error.category === 'parse' &&
        !error.message.includes('highly_private') &&
        !error.message.includes('private') &&
        !error.message.includes('<resultset>')
    );
  }
});

test('byte limit is enforced independently of row count', async () => {
  const xml = `<resultset>${' '.repeat(128)}</resultset>`;
  await assert.rejects(
    parseMysqlXml(xml, { maxRows: null, maxBytes: 64 }),
    error => error instanceof RelayMysqlError && error.category === 'result_too_large'
  );
  assert.ok(DEFAULT_MAX_BYTES > 64);
});

test('special JavaScript property names remain own result columns', async () => {
  const xml = [
    '<resultset><row>',
    '<field name="__proto__">prototype value</field>',
    '<field name="constructor">constructor value</field>',
    '<field name="prototype">plain prototype column</field>',
    '<field name="__proto__">duplicate prototype value</field>',
    '</row></resultset>',
  ].join('');

  const result = await parseMysqlXml(xml);
  const row = result.rows[0];

  assert.deepEqual(
    result.columns.map(column => column.columnName),
    ['__proto__', 'constructor', 'prototype', '__proto____2']
  );
  assert.deepEqual(Object.keys(row), ['__proto__', 'constructor', 'prototype', '__proto____2']);
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.hasOwn(row, '__proto__'), true);
  assert.equal(row.__proto__, 'prototype value');
  assert.equal(row.constructor, 'constructor value');
  assert.equal(row.prototype, 'plain prototype column');
  assert.equal(row.__proto____2, 'duplicate prototype value');
});
