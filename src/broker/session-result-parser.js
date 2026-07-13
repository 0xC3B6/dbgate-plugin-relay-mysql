'use strict';

const { BoundedBuffer } = require('../runner/bounded-buffer');

class SessionResultParser {
  constructor({ nonce, maxBytes }) {
    this.startMarker = Buffer.from(`__DBGATE_RUNNER_${nonce}_BEGIN__\n`);
    this.endMarker = Buffer.from(`__DBGATE_RELAY_MYSQL_${nonce}_XML_END__`);
    this.resultPrefix = Buffer.from(`__DBGATE_SESSION_${nonce}_RESULT__`);
    this.buffer = new BoundedBuffer(maxBytes);
    this.pending = Buffer.alloc(0);
    this.state = 'start';
  }

  push(chunk) {
    if (this.state === 'done' || chunk.length === 0) return null;
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);

    if (this.state === 'start') {
      const index = this.pending.indexOf(this.startMarker);
      if (index < 0) {
        const keep = Math.max(0, this.startMarker.length - 1);
        if (this.pending.length > keep) this.pending = this.pending.subarray(this.pending.length - keep);
        return null;
      }
      this.pending = this.pending.subarray(index + this.startMarker.length);
      this.state = 'xml';
    }

    if (this.state === 'xml') {
      const index = this.pending.indexOf(this.endMarker);
      if (index >= 0) {
        this.buffer.push(this.pending.subarray(0, index));
        this.pending = this.pending.subarray(index + this.endMarker.length);
        this.state = 'result';
      } else {
        const keep = Math.max(0, this.endMarker.length - 1);
        if (this.pending.length > keep) {
          const flushLength = this.pending.length - keep;
          this.buffer.push(this.pending.subarray(0, flushLength));
          this.pending = this.pending.subarray(flushLength);
        }
        return null;
      }
    }

    const prefixIndex = this.pending.indexOf(this.resultPrefix);
    if (prefixIndex < 0) {
      const keep = Math.max(0, this.resultPrefix.length - 1);
      if (this.pending.length > keep) this.pending = this.pending.subarray(this.pending.length - keep);
      return null;
    }
    const categoryStart = prefixIndex + this.resultPrefix.length;
    const newline = this.pending.indexOf(0x0a, categoryStart);
    if (newline < 0) return null;
    const category = this.pending.subarray(categoryStart, newline).toString('ascii').replace(/\r$/, '');
    if (!['OK', 'mysql_connection', 'sql_error'].includes(category)) {
      throw new Error('Persistent session returned an invalid result category');
    }
    this.state = 'done';
    return { category, stdout: this.buffer.toBuffer() };
  }
}

module.exports = { SessionResultParser };
