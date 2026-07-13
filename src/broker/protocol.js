'use strict';

const MAX_HEADER_BYTES = 16 * 1024;

function encodePacket(header, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headerBuffer = Buffer.from(JSON.stringify({ ...header, bodyBytes: payload.length }), 'utf8');
  if (headerBuffer.length < 2 || headerBuffer.length > MAX_HEADER_BYTES) {
    throw new Error('Broker packet header is invalid');
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(headerBuffer.length, 0);
  return Buffer.concat([prefix, headerBuffer, payload]);
}

function readPacket(stream, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let expectedTotal = null;
    let header = null;
    let settled = false;

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = () => fail(new Error('Broker socket failed'));
    const onClose = () => fail(new Error('Broker socket closed before a complete packet'));
    const onData = chunk => {
      if (settled) return;
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (header == null && pending.length >= 4) {
        const headerBytes = pending.readUInt32BE(0);
        if (headerBytes < 2 || headerBytes > MAX_HEADER_BYTES) {
          fail(new Error('Broker packet header is invalid'));
          return;
        }
        if (pending.length < 4 + headerBytes) return;
        try {
          header = JSON.parse(pending.subarray(4, 4 + headerBytes).toString('utf8'));
        } catch (_error) {
          fail(new Error('Broker packet header is invalid'));
          return;
        }
        const bodyBytes = header?.bodyBytes;
        if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > maxBodyBytes) {
          fail(new Error('Broker packet body is invalid'));
          return;
        }
        expectedTotal = 4 + headerBytes + bodyBytes;
      }
      if (expectedTotal == null || pending.length < expectedTotal) return;
      if (pending.length !== expectedTotal) {
        fail(new Error('Broker packet has trailing data'));
        return;
      }
      settled = true;
      cleanup();
      resolve({ header, body: pending.subarray(expectedTotal - header.bodyBytes) });
    };

    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

module.exports = { MAX_HEADER_BYTES, encodePacket, readPacket };
