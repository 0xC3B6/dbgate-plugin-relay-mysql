'use strict';

const {
  MAX_SQL_BYTES,
  MAX_SQL_CHUNK_COUNT,
  SQL_CHUNK_BYTES,
} = require('./constants');

const FRAME_FIELDS = Object.freeze([
  'protocolVersion',
  'nonce',
  'relayCommand',
  'relayArgs',
  'relayPrompt',
  'relayPasswordPrompt',
  'relayPassword',
  'sshTarget',
  'sshPrompt',
  'sshPasswordPrompt',
  'sshPassword',
  'mysqlCommand',
  'mysqlHost',
  'mysqlPort',
  'mysqlUser',
  'mysqlPassword',
  'database',
  'sqlChunkCount',
  'remoteScript',
]);

function encodeFrame(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeFrame(frame) {
  if (typeof frame !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame)) {
    throw new Error('Invalid Base64 frame');
  }
  return Buffer.from(frame, 'base64').toString('utf8');
}

function encodeFrames(values) {
  const sqlChunks = values.sqlChunks || [];
  if (!Array.isArray(sqlChunks) || sqlChunks.length > MAX_SQL_CHUNK_COUNT) {
    throw new RangeError('SQL frame count exceeds the protocol limit');
  }
  const header = { ...values, sqlChunkCount: sqlChunks.length };
  return `${FRAME_FIELDS.map((field) => encodeFrame(header[field])).concat(sqlChunks).join('\n')}\n`;
}

function encodeSqlChunks(value, chunkBytes = SQL_CHUNK_BYTES) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > SQL_CHUNK_BYTES) {
    throw new RangeError('Invalid SQL chunk size');
  }
  const input = Buffer.from(String(value ?? ''), 'utf8');
  if (input.length > MAX_SQL_BYTES) throw new RangeError('SQL exceeds the 32 MiB limit');
  const chunkCount = Math.ceil(input.length / chunkBytes);
  if (chunkCount > MAX_SQL_CHUNK_COUNT) {
    throw new RangeError('SQL frame count exceeds the protocol limit');
  }
  const result = [];
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    result.push(input.subarray(offset, offset + chunkBytes).toString('base64'));
  }
  return result;
}

module.exports = { FRAME_FIELDS, SQL_CHUNK_BYTES, decodeFrame, encodeFrame, encodeFrames, encodeSqlChunks };
