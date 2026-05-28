/**
 * Tests for the in-memory cache utility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../utils/cache.js';

describe('Cache', () => {
  it('stores and retrieves values', () => {
    const cache = new Cache<string>(5);
    cache.set('key1', 'value1');
    assert.equal(cache.get('key1'), 'value1');
  });

  it('returns undefined for missing keys', () => {
    const cache = new Cache<string>(5);
    assert.equal(cache.get('nonexistent'), undefined);
  });

  it('respects TTL expiration', async () => {
    const cache = new Cache<string>(1); // 1 minute default
    cache.set('key1', 'value1', 50); // 50ms TTL
    assert.equal(cache.get('key1'), 'value1');

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(cache.get('key1'), undefined);
  });

  it('reports correct size', () => {
    const cache = new Cache<number>(5);
    assert.equal(cache.size, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.size, 2);
  });

  it('clears all entries', () => {
    const cache = new Cache<string>(5);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), undefined);
  });

  it('has() returns correct boolean', () => {
    const cache = new Cache<string>(5);
    cache.set('exists', 'yes');
    assert.equal(cache.has('exists'), true);
    assert.equal(cache.has('nope'), false);
  });
});
