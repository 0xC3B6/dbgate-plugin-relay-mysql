'use strict';

const path = require('node:path');

const DEFAULT_METADATA_TTL_MS = 5 * 60 * 1000;

function createMetadataCacheKey(parts) {
  return JSON.stringify([
    parts.connectionId || '',
    parts.relayProfile || '',
    path.resolve(parts.runnerPath || '.'),
    parts.database ?? null,
  ]);
}

class MetadataCache {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_METADATA_TTL_MS;
    this.now = options.now || Date.now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  async getOrLoad(key, loader, options = {}) {
    const entry = this.entries.get(key);
    if (!options.force && entry && this.now() < entry.expiresAt) return entry.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const loading = Promise.resolve()
      .then(loader)
      .then(value => {
        this.entries.set(key, {
          value,
          expiresAt: this.now() + this.ttlMs,
        });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === loading) this.inflight.delete(key);
      });
    this.inflight.set(key, loading);
    return loading;
  }

  invalidate(key) {
    const entry = this.entries.get(key);
    if (entry) entry.expiresAt = Number.NEGATIVE_INFINITY;
  }

  isFresh(key) {
    const entry = this.entries.get(key);
    return Boolean(entry && this.now() < entry.expiresAt);
  }

  peekLastSuccessful(key) {
    return this.entries.get(key)?.value;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }
}

module.exports = {
  DEFAULT_METADATA_TTL_MS,
  MetadataCache,
  createMetadataCacheKey,
};
