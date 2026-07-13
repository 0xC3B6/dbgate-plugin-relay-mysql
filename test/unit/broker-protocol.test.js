'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { encodePacket, readPacket } = require('../../src/broker/protocol');

test('broker packets preserve fragmented headers and binary bodies', async () => {
  const stream = new PassThrough();
  const packet = encodePacket({ version: 1, requestId: 'request-one' }, Buffer.from('你好'));
  const reading = readPacket(stream, { maxBodyBytes: 32 });
  stream.write(packet.subarray(0, 3));
  stream.write(packet.subarray(3, 11));
  stream.write(packet.subarray(11));
  const result = await reading;
  assert.equal(result.header.requestId, 'request-one');
  assert.equal(result.body.toString(), '你好');
});

test('broker packets reject oversized bodies before allocation', async () => {
  const stream = new PassThrough();
  const packet = encodePacket({ version: 1 }, Buffer.alloc(4));
  const reading = readPacket(stream, { maxBodyBytes: 3 });
  stream.end(packet);
  await assert.rejects(reading, /body is invalid/);
});
