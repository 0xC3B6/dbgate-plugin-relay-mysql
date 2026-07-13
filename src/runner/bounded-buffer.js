'use strict';

class BufferLimitError extends Error {
  constructor(maxBytes) {
    super(`Buffer exceeded ${maxBytes} bytes`);
    this.name = 'BufferLimitError';
    this.code = 'BUFFER_LIMIT';
    this.maxBytes = maxBytes;
  }
}

class BoundedBuffer {
  constructor(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('maxBytes must be a non-negative safe integer');
    }
    this.maxBytes = maxBytes;
    this.length = 0;
    this.chunks = [];
  }

  push(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (this.length + chunk.length > this.maxBytes) {
      throw new BufferLimitError(this.maxBytes);
    }
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

module.exports = { BoundedBuffer, BufferLimitError };
