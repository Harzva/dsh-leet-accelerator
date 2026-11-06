import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsCache } from '../src/metrics-cache.js';

// The cache must never return a stale code-point total. Strings are immutable,
// so recording array length + each block's type + its exact text reference is
// a complete check for anything that could change the measurement.

test('cache returns the stored value only for the same, unchanged array', () => {
  const cache = createMetricsCache();
  const blocks = [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'ignored' }];
  assert.equal(cache.get(blocks), undefined);
  cache.put(blocks, 42);
  assert.equal(cache.get(blocks), 42);
  assert.equal(cache.get([...blocks]), undefined, 'a different array must not hit');
  const other = [{ type: 'text', text: 'hello' }];
  assert.equal(cache.get(other), undefined);
});

test('zero is a valid cached value (not a cache miss)', () => {
  const cache = createMetricsCache();
  const blocks = [];
  cache.put(blocks, 0);
  assert.equal(cache.get(blocks), 0);
});

test('every structural mutation that could change the count invalidates the entry', () => {
  const mutations = [
    ['push a text block', a => { a.push({ type: 'text', text: 'extra' }); }],
    ['push a non-text block', a => { a.push({ type: 'image', attachment: null }); }],
    ['pop the last block', a => { a.pop(); }],
    ['splice out a block', a => { a.splice(1, 1); }],
    ['replace a block object with different text', a => { a[0] = { type: 'text', text: a[0].text + 'X' }; }],
    ['replace text with a different string', a => { a[0].text = 'a'.repeat(a[0].text.length); }],
    ['replace text with a string that changes code points', a => { a[0].text = '\ud800\udc00'; }],
    ['flip text -> reasoning', a => { a[0].type = 'reasoning'; }],
    ['flip reasoning -> text', a => { a[1].type = 'text'; }],
    ['reorder blocks', a => { const t = a[0]; a[0] = a[1]; a[1] = t; }],
    ['clear the array', a => { a.length = 0; }],
  ];
  for (const [label, mutate] of mutations) {
    const cache = createMetricsCache();
    const blocks = [{ type: 'text', text: 'A中😀' }, { type: 'reasoning', text: 'hidden' }];
    cache.put(blocks, 3);
    mutate(blocks);
    assert.equal(cache.get(blocks), undefined, label);
  }
});

test('changes that cannot affect the count are safe cache hits', () => {
  const cache = createMetricsCache();
  const blocks = [{ type: 'text', text: 'A中😀' }, { type: 'reasoning', text: 'hidden' }];
  cache.put(blocks, 3);
  blocks[1].text = 'a completely different note';
  assert.equal(cache.get(blocks), 3, 'non-text blocks contribute zero code points');
  const text = blocks[0].text;
  blocks[0] = { type: 'text', text };
  assert.equal(cache.get(blocks), 3,
    'a new block object with the same immutable text cannot change the count');
  // Primitive strings have no identity. `String(text).slice()` yields the same
  // string value, so a hit here is correct, not a stale read.
  blocks[0].text = String(text).slice();
  assert.equal(blocks[0].text === text, true);
  assert.equal(cache.get(blocks), 3, 'an equal-content string is a safe cache hit');
});

test('an entry can be overwritten and the cache is scoped per instance', () => {
  const a = createMetricsCache();
  const b = createMetricsCache();
  const blocks = [{ type: 'text', text: 'x' }];
  a.put(blocks, 1);
  assert.equal(b.get(blocks), undefined);
  a.put(blocks, 2);
  assert.equal(a.get(blocks), 2);
});
