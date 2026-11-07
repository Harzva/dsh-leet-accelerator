// Review S1: derived charsAfter adds MARKER_POINTS for the inserted marker.
// That derivation is only exact when the marker cannot change the code-point
// count of the pruned text. A pure-ASCII marker can never join a neighbouring
// high or low surrogate into a new pair, and its code-point length equals its
// UTF-16 length. If upstream ever changes PRUNE_MARKER to something non-ASCII,
// src/index.js must fail fast at module load instead of silently mis-counting.
//
// These tests exercise the exported assertion directly so we can prove both
// the accept path (the real pinned marker) and the fail-fast path (a range of
// plausible non-ASCII / non-string markers) without mutating upstream exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { assertSafeMarker } from '../src/index.js';

test('the pinned upstream PRUNE_MARKER is accepted and counted as ASCII', () => {
  // Importing src/index.js already ran assertSafeMarker(PRUNE_MARKER) at module
  // load; reaching this test proves the real marker does not trip the guard.
  assert.equal(typeof PRUNE_MARKER, 'string');
  assert.equal(assertSafeMarker(PRUNE_MARKER), PRUNE_MARKER.length);
  assert.equal(assertSafeMarker(PRUNE_MARKER), Array.from(PRUNE_MARKER).length);
});

test('pure-ASCII markers are accepted with an exact code-point count', () => {
  for (const marker of [
    '',
    'x',
    '\n\n[... tool result middle pruned ...]\n\n',
    '\x00\t\r\n\x7f',
    '!'.repeat(128),
  ]) {
    assert.equal(assertSafeMarker(marker), marker.length, `accept ${JSON.stringify(marker)}`);
  }
});

test('any non-ASCII or non-string marker fails fast', () => {
  const unsafe = [
    '…',                         // U+2026, single non-ASCII BMP unit
    '中',                         // CJK
    '😀',                         // surrogate pair (two UTF-16 units)
    '\ud800',                    // lone high surrogate
    '\udc00',                    // lone low surrogate
    '\u0080',                    // just past ASCII
    '\ufeff',                    // BOM
    'ok\u00a0',                  // ASCII prefix then non-ASCII
    '\ud800ok',                  // leading high surrogate (could pair with kept head)
    'ok\udc00',                  // trailing low surrogate (could pair with kept tail)
  ];
  for (const marker of unsafe) {
    assert.throws(
      () => assertSafeMarker(marker),
      /PRUNE_MARKER must be a pure-ASCII string/,
      `must reject ${JSON.stringify(marker)}`,
    );
  }
  for (const marker of [undefined, null, 39, 0, {}, [], new String('ascii')]) {
    assert.throws(
      () => assertSafeMarker(marker),
      /PRUNE_MARKER must be a pure-ASCII string/,
      `must reject non-string ${Object.prototype.toString.call(marker)}`,
    );
  }
});

test('why the guard matters: a boundary surrogate marker would break the derivation', () => {
  // Constructive illustration of the invariant the guard protects. If the
  // marker ended in an unpaired high surrogate, concatenating it with a kept
  // tail that starts with a low surrogate would merge two UTF-16 units into one
  // code point, changing the exact code-point count that charsAfter derives.
  const head = 'A';
  const boundaryMarker = '\ud800';       // lone high surrogate
  const tail = '\udc00';                 // lone low surrogate
  const joined = head + boundaryMarker + tail;
  const naive = Array.from(head).length + Array.from(boundaryMarker).length + Array.from(tail).length;
  const exact = Array.from(joined).length;
  assert.notEqual(naive, exact, 'summed parts overcount a pair formed across the boundary');
  // The guard rejects such a marker before it could ever be used.
  assert.throws(() => assertSafeMarker(boundaryMarker), /pure-ASCII string/);
});
