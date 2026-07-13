'use strict';

const { BoundedBuffer } = require('./bounded-buffer');

class FrameExtractor {
  constructor({ startMarker, endMarker, maxBytes }) {
    this.startMarker = Buffer.from(startMarker);
    this.endMarker = Buffer.from(endMarker);
    this.buffer = new BoundedBuffer(maxBytes);
    this.pending = Buffer.alloc(0);
    this.started = false;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished || chunk.length === 0) return;
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);

    if (!this.started) {
      const index = this.pending.indexOf(this.startMarker);
      if (index < 0) {
        const keep = Math.max(0, this.startMarker.length - 1);
        if (this.pending.length > keep) this.pending = this.pending.subarray(this.pending.length - keep);
        return;
      }
      this.started = true;
      this.pending = this.pending.subarray(index + this.startMarker.length);
    }

    const endIndex = this.pending.indexOf(this.endMarker);
    if (endIndex >= 0) {
      this.buffer.push(this.pending.subarray(0, endIndex));
      this.pending = Buffer.alloc(0);
      this.finished = true;
      return;
    }

    const keep = Math.max(0, this.endMarker.length - 1);
    if (this.pending.length > keep) {
      const flushLength = this.pending.length - keep;
      this.buffer.push(this.pending.subarray(0, flushLength));
      this.pending = this.pending.subarray(flushLength);
    }
  }

  result() {
    if (!this.started || !this.finished) throw new Error('Incomplete runner result frame');
    return this.buffer.toBuffer();
  }
}

module.exports = { FrameExtractor };
