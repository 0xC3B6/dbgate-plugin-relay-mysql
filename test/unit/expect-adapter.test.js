'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MAX_SQL_CHUNK_COUNT, SQL_CHUNK_BYTES } = require('../../src/runner/constants');

const expectScript = fs.readFileSync(
  path.resolve(__dirname, '../../runner/relay-mysql.exp'),
  'utf8'
);

test('Expect adapter enforces the Node SQL frame limits without a large Tcl integer', () => {
  const countLimit = expectScript.match(/set maxSqlChunkCount ([0-9]+)/);
  const byteLimit = expectScript.match(/::base64::decode \$frame\]\] > ([0-9]+)/);

  assert.ok(countLimit, 'Expect chunk-count limit must be explicit');
  assert.ok(byteLimit, 'Expect per-chunk byte limit must be explicit');
  assert.equal(Number(countLimit[1]), MAX_SQL_CHUNK_COUNT);
  assert.equal(Number(byteLimit[1]), SQL_CHUNK_BYTES);
  assert.ok(expectScript.includes('regexp {^(?:0|[1-9][0-9]{0,4})$} $sqlChunkCount'));
});

test('Expect adapter streams SQL frames instead of retaining them in a Tcl list', () => {
  assert.match(
    expectScript,
    /for \{set index 0\} \{\$index < \$sqlChunkCount\} \{incr index\} \{\s+set frame \[read_sql_frame\]\s+send -s/s
  );
  assert.doesNotMatch(expectScript, /sqlChunkFrames|lappend/);
});
