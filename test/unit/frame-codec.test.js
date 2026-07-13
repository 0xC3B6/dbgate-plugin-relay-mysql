'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FRAME_FIELDS, decodeFrame, encodeFrame, encodeFrames, encodeSqlChunks } = require('../../src/runner/frame-codec');
const {
  MAX_SQL_BYTES,
  MAX_SQL_CHUNK_COUNT,
  SQL_CHUNK_BYTES,
} = require('../../src/runner/constants');
const { FrameExtractor } = require('../../src/runner/frame-extractor');

test('fixed frame codec round-trips UTF-8, SQL punctuation, and newlines', () => {
  const input = "select '你好\\n$HOME';\n";
  assert.equal(decodeFrame(encodeFrame(input)), input);
  const framed = encodeFrames(Object.fromEntries(FRAME_FIELDS.map((field) => [field, input])));
  assert.equal(framed.trimEnd().split('\n').length, FRAME_FIELDS.length);
  assert.ok(!framed.includes(input));
});

test('frame extractor handles markers split across chunks', () => {
  const extractor = new FrameExtractor({ startMarker: 'BEGIN\n', endMarker: 'END', maxBytes: 10 });
  extractor.push(Buffer.from('noiseBE'));
  extractor.push(Buffer.from('GIN\nabcE'));
  extractor.push(Buffer.from('NDignored'));
  assert.equal(extractor.result().toString(), 'abc');
});

test('frame extractor applies the byte limit only to extracted XML', () => {
  const extractor = new FrameExtractor({ startMarker: 'BEGIN\n', endMarker: 'END', maxBytes: 3 });
  assert.throws(() => extractor.push(Buffer.from('BEGIN\nabcdEND')), /exceeded/);
});

test('SQL is transported as bounded Base64 lines without changing UTF-8 bytes', () => {
  const sql = `SELECT '${`你好-$HOME-`.repeat(900)}'`;
  const chunks = encodeSqlChunks(sql);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3 * 1024));
  assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64'))).toString('utf8'), sql);
});

test('SQL byte and frame boundaries describe the same 32 MiB protocol limit', () => {
  assert.equal(MAX_SQL_BYTES, 32 * 1024 * 1024);
  assert.equal(SQL_CHUNK_BYTES, 2 * 1024);
  assert.equal(MAX_SQL_CHUNK_COUNT, 16_384);
  assert.equal(MAX_SQL_CHUNK_COUNT * SQL_CHUNK_BYTES, MAX_SQL_BYTES);

  assert.throws(
    () => encodeFrames({ sqlChunks: new Array(MAX_SQL_CHUNK_COUNT + 1) }),
    /frame count exceeds/
  );
  assert.throws(() => encodeSqlChunks('SELECT 1', SQL_CHUNK_BYTES + 1), /Invalid SQL chunk size/);
});
