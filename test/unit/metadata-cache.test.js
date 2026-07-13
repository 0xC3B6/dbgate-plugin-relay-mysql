'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MetadataCache,
  createMetadataCacheKey,
} = require('../../src/backend/metadata-cache');

test('metadata cache reuses fresh values and TTL begins after successful load', async () => {
  let now = 0;
  let calls = 0;
  const cache = new MetadataCache({ ttlMs: 300000, now: () => now });
  const key = 'fixture';
  const loader = async () => {
    calls += 1;
    now = 100;
    return { generation: calls };
  };

  const first = await cache.getOrLoad(key, loader);
  now = 300099;
  assert.equal(cache.isFresh(key), true);
  assert.strictEqual(await cache.getOrLoad(key, loader), first);
  now = 300100;
  assert.equal(cache.isFresh(key), false);
  assert.notStrictEqual(await cache.getOrLoad(key, loader), first);
  assert.equal(calls, 2);
});

test('metadata cache coalesces concurrent loads', async () => {
  const cache = new MetadataCache();
  let resolveLoader;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise(resolve => {
      resolveLoader = resolve;
    });
  };
  const left = cache.getOrLoad('fixture', loader);
  const right = cache.getOrLoad('fixture', loader);
  await new Promise(resolve => setImmediate(resolve));
  resolveLoader({ ok: true });
  assert.strictEqual(await left, await right);
  assert.equal(calls, 1);
});

test('failed forced refresh rejects but retains the last successful snapshot', async () => {
  const cache = new MetadataCache();
  const snapshot = { tables: [] };
  await cache.getOrLoad('fixture', async () => snapshot);
  await assert.rejects(
    cache.getOrLoad('fixture', async () => {
      throw new Error('synthetic failure');
    }, { force: true }),
    /synthetic failure/
  );
  assert.strictEqual(cache.peekLastSuccessful('fixture'), snapshot);
});

test('invalidate affects only one collision-safe cache key', async () => {
  let calls = 0;
  const cache = new MetadataCache();
  const keyA = createMetadataCacheKey({
    connectionId: 'a/b', relayProfile: 'c', runnerPath: '/tmp/runner', database: 'd',
  });
  const keyB = createMetadataCacheKey({
    connectionId: 'a', relayProfile: 'b/c', runnerPath: '/tmp/runner', database: 'd',
  });
  assert.notEqual(keyA, keyB);
  await cache.getOrLoad(keyA, async () => ++calls);
  await cache.getOrLoad(keyB, async () => ++calls);
  cache.invalidate(keyA);
  await cache.getOrLoad(keyA, async () => ++calls);
  await cache.getOrLoad(keyB, async () => ++calls);
  assert.equal(calls, 3);
});
