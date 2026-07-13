'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BoundedBuffer, BufferLimitError } = require('../../src/runner/bounded-buffer');
const { MAX_RESULT_BYTES } = require('../../src/runner/constants');

test('BoundedBuffer accepts exactly the configured number of bytes', () => {
  const buffer = new BoundedBuffer(4);
  buffer.push(Buffer.from('ab'));
  buffer.push(Buffer.from('cd'));
  assert.equal(buffer.toBuffer().toString(), 'abcd');
});

test('BoundedBuffer rejects one byte over the limit without retaining that chunk', () => {
  const buffer = new BoundedBuffer(4);
  buffer.push(Buffer.from('abc'));
  assert.throws(() => buffer.push(Buffer.from('de')), BufferLimitError);
  assert.equal(buffer.toBuffer().toString(), 'abc');
});

test('the production 32 MiB result boundary is inclusive and atomic', () => {
  const buffer = new BoundedBuffer(MAX_RESULT_BYTES);
  buffer.push(Buffer.alloc(MAX_RESULT_BYTES));
  assert.throws(() => buffer.push(Buffer.alloc(1)), BufferLimitError);
  assert.equal(buffer.length, MAX_RESULT_BYTES);
});
