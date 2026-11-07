// Round-3 candidate study. Research only: nothing here is loaded by the plugin.
//
// Two independent ideas are measured against the official provider:
//
//   regexCount   - Replace the JS per-code-unit `charCodeAt` loop used to count
//                  Unicode code points with a native-regex surrogate-pair count.
//                  Since every valid pair is 2 UTF-16 units but 1 code point,
//                  points = text.length - pairCount. Question: is the engine's
//                  regex scan faster than a hand-written JS loop, and does it
//                  regress on emoji-dense / mixed text?
//
//   reuseWhole   - When pruneContent keeps a text block in full (entirely in
//                  the head or entirely in the tail), reuse the original string
//                  instead of rebuilding it via slice(0,len) + '' + slice(len).
//                  Saves a large string allocation for untouched blocks.
//
// All variants must be byte-identical to the official implementation. This is
// an algorithm-local microbenchmark: no model, no network, no quota, no
// end-to-end agent run, no token or memory claim.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { PRUNE_MARKER, ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';

const cfg = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
function official() {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new ToolResultPruner(ctx, cfg);
}
const OFFICIAL = official();

// --- counting primitives -----------------------------------------------------
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
const SURROGATE_PAIR_G = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/** Shipping linear scan: exact code-point count in one UTF-16 pass. */
function scanPoints(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++, count++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; }
    }
  }
  return count;
}

/** The official algorithm, for reference. */
function arrayFrom(text) { return Array.from(text).length; }

/** fastLength-style probe: no pair means length is already exact. */
function fastProbe(text) { return SURROGATE_PAIR.test(text) ? scanPoints(text) : text.length; }

/** Native engine iteration, one step per code point (no JS charCodeAt loop). */
function forOf(text) { let n = 0; for (const _ of text) n++; return n; }

/** Native codePointAt stride, advancing 1 or 2 UTF-16 units per code point. */
function codePointAtLoop(text) {
  let n = 0;
  for (let i = 0; i < text.length; n++) i += text.codePointAt(i) > 0xffff ? 2 : 1;
  return n;
}

/** Candidate A1: one native regex, count matches via String.match array. */
function regexMatch(text) {
  const m = text.match(SURROGATE_PAIR_G);
  return text.length - (m ? m.length : 0);
}

/** Candidate A2: one native regex, count via exec loop (no match array). */
function regexExec(text) {
  SURROGATE_PAIR_G.lastIndex = 0;
  let pairs = 0;
  while (SURROGATE_PAIR_G.exec(text) !== null) pairs++;
  return text.length - pairs;
}

/** Candidate A3: split-based pair count, for completeness. */
function regexSplit(text) {
  return text.length - (text.split(SURROGATE_PAIR_G).length - 1);
}

const counters = [
  { name: 'official(arrayFrom)', fn: arrayFrom },
  { name: 'shipping(scanPoints)', fn: scanPoints },
  { name: 'fastProbe(test)', fn: fastProbe },
  { name: 'forOf(native iter)', fn: forOf },
  { name: 'codePointAt(stride)', fn: codePointAtLoop },
  { name: 'regexMatch(match/g)', fn: regexMatch },
  { name: 'regexExec(exec loop)', fn: regexExec },
  { name: 'regexSplit(split/g)', fn: regexSplit },
];

const countTexts = [
  { name: 'ascii-1k', text: 'a'.repeat(1000) },
  { name: 'ascii-8k', text: 'a'.repeat(8192) },
  { name: 'ascii-300k', text: 'a'.repeat(300_000) },
  { name: 'cjk-300k', text: '中'.repeat(300_000) },
  { name: 'emoji-150k-pairs', text: '😀'.repeat(150_000) },        // 300k units, 150k points
  { name: 'mixed-300k', text: 'A中😀\ud800'.repeat(60_000) },
  { name: 'lone-surrogates-300k', text: '\ud800\udc00'.length ? ('\ud800x\udc00y'.repeat(60_000)) : '' },
  { name: 'few-pairs-in-ascii', text: 'a'.repeat(150_000) + '😀'.repeat(50) + 'b'.repeat(149_900) },
  { name: 'high-high-low-low', text: '\ud800\ud800\udc00\udc00'.repeat(60_000) },
];

// Correctness: every counter must equal the official measureContent exactly,
// including lone surrogates and pathological high/high/low/low sequences.
for (const item of countTexts) {
  const expected = OFFICIAL.measureContent([{ type: 'text', text: item.text }]);
  for (const c of counters) {
    assert.equal(c.fn(item.text), expected, `count parity ${item.name} / ${c.name}`);
  }
}

// --- pruneContent: reuse-whole-block candidate -------------------------------
function pointOffset(text, position, length, paired) {
  if (position <= 0) return 0;
  if (position >= length) return text.length;
  if (!paired) return position;
  if (position <= length - position) {
    let offset = 0;
    for (let points = 0; points < position; points++) {
      const unit = text.charCodeAt(offset++);
      if (unit >= 0xd800 && unit <= 0xdbff && offset < text.length) {
        const next = text.charCodeAt(offset);
        if (next >= 0xdc00 && next <= 0xdfff) offset++;
      }
    }
    return offset;
  }
  let offset = text.length;
  for (let points = 0; points < length - position; points++) {
    const unit = text.charCodeAt(--offset);
    if (unit >= 0xdc00 && unit <= 0xdfff && offset > 0) {
      const previous = text.charCodeAt(offset - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) offset--;
    }
  }
  return offset;
}

/**
 * Shared pruneContent skeleton. `reuseWhole` toggles the single candidate
 * behaviour: skip rebuilding a string for a block kept entirely in head/tail.
 * Both paths use the same linear analyzer, so any timing difference is due to
 * the string construction, not the counting method.
 */
function pruneContent(blocks, reuseWhole) {
  const analyzed = blocks.map(block => block.type === 'text'
    ? (() => {
      const text = block.text;
      let length = 0, paired = false;
      for (let i = 0; i < text.length; i++, length++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
          const next = text.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) { i++; paired = true; }
        }
      }
      return { length, paired };
    })()
    : { length: 0, paired: false });
  const totalChars = analyzed.reduce((sum, e) => sum + e.length, 0);
  if (totalChars <= cfg.thresholdChars) return null;
  const removedStart = cfg.headChars;
  const removedEnd = totalChars - cfg.tailChars;
  const pruned = [];
  let consumed = 0, markerInserted = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== 'text') { pruned.push(block); continue; }
    const { length, paired } = analyzed[i];
    const blockStart = consumed, blockEnd = blockStart + length;
    const headEnd = Math.min(length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(length, Math.max(0, removedEnd - blockStart));
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : '';
    if (marker) markerInserted = true;
    // A block is fully kept when both boundaries sit at one end. In that case
    // there is no marker (the kept span cannot intersect the removed span), so
    // the result is exactly the original string.
    const fullyHead = headEnd === length && tailStart === length;
    const fullyTail = headEnd === 0 && tailStart === 0;
    const text = reuseWhole && !marker && (fullyHead || fullyTail)
      ? block.text
      : block.text.slice(0, pointOffset(block.text, headEnd, length, paired))
        + marker + block.text.slice(pointOffset(block.text, tailStart, length, paired));
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) throw new Error('failed to locate removed span');
  const charsAfter = OFFICIAL.measureContent(pruned);
  if (charsAfter > cfg.thresholdChars || charsAfter >= totalChars) {
    throw new Error('replacement must be smaller and within threshold');
  }
  return pruned;
}

const manyBlocks = (unit, count, size) => Array.from({ length: count }, (_, i) => i % 7 === 0
  ? { type: 'reasoning', text: 'untouched' }
  : { type: 'text', text: unit.repeat(size) });

const pruneCases = [
  { name: 'single-300k-ascii', blocks: [{ type: 'text', text: 'a'.repeat(300_000) }] },
  { name: 'single-300k-emoji', blocks: [{ type: 'text', text: '😀'.repeat(150_000) }] },
  { name: 'many-small-blocks-200', blocks: manyBlocks('a', 200, 300) },
  { name: 'many-mixed-blocks-120', blocks: manyBlocks('A中😀', 120, 200) },
  { name: 'head-heavy-40', blocks: manyBlocks('中', 40, 400) },
  { name: 'tail-heavy-40', blocks: manyBlocks('😀', 40, 250) },
  { name: 'lone-surrogate-blocks', blocks: manyBlocks('\ud800a\udc00', 60, 200) },
];

// Correctness: both paths must be byte-identical to official pruneContent, and
// to each other, on every shape (including null for within-budget content).
for (const item of pruneCases) {
  const expected = OFFICIAL.pruneContent(item.blocks);
  const base = pruneContent(item.blocks, false);
  const reuse = pruneContent(item.blocks, true);
  assert.deepEqual(base, expected, `base parity ${item.name}`);
  assert.deepEqual(reuse, expected, `reuse parity ${item.name}`);
  assert.deepEqual(reuse, base, `reuse/base parity ${item.name}`);
}
// Extra within-budget null parity + multi-block Unicode fuzz.
assert.equal(pruneContent([{ type: 'text', text: 'a'.repeat(4096) }], true), null);
for (let k = 0; k < 40; k++) {
  const blocks = Array.from({ length: 8 }, () => ({ type: 'text', text: ('A中😀\ud800\udc00'.repeat(300)) }));
  const expected = OFFICIAL.pruneContent(blocks);
  assert.deepEqual(pruneContent(blocks, true), expected, `fuzz reuse ${k}`);
}

// --- benchmark harness -------------------------------------------------------
const WARMUPS = 12, SAMPLES = 60;
const q = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

// Dead-code-elimination guard: pure counters such as scanPoints have no side
// effects, so a benchmark that discards their return value can be optimized
// away entirely by the JIT (producing absurd sub-microsecond "speedups"). Every
// call's result is folded into a module-level sink that is asserted and
// serialized at the end, so the computation is genuinely observed.
let SINK = 0;
function consume(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  return 1;
}

function measure(fn, iters) {
  const s = performance.now();
  let acc = 0;
  for (let i = 0; i < iters; i++) acc += consume(fn());
  SINK += acc;
  return (performance.now() - s) / iters;
}

function bench(label, entries, makeRun) {
  const runs = entries.map(e => ({ name: e.name, run: makeRun(e) }));
  for (let i = 0; i < WARMUPS; i++) {
    const order = i % 2 === 0 ? runs : [...runs].reverse();
    for (const r of order) consume(r.run());
  }
  const samples = Object.fromEntries(runs.map(r => [r.name, []]));
  for (let i = 0; i < SAMPLES; i++) {
    const order = i % 2 === 0 ? runs : [...runs].reverse();
    for (const r of order) samples[r.name].push(measure(r.run, 1));
  }
  return {
    name: label,
    results: Object.fromEntries(runs.map(r => [r.name, {
      p50: q(samples[r.name], .50), p95: q(samples[r.name], .95),
      min: Math.min(...samples[r.name]), max: Math.max(...samples[r.name]),
    }])),
  };
}

const output = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  scope: 'algorithm-local counting / pruneContent microbenchmark; research-only, not shipped; no model, no network, no quota, no end-to-end run',
  warmups: WARMUPS,
  samplesPerCase: SAMPLES,
  unit: 'milliseconds per call',
  parity: 'all counting primitives equal official measureContent; base and reuseWhole pruneContent byte-identical to official on all shapes + 40 fuzz cases',
  counting: [],
  pruning: [],
};

for (const item of countTexts) {
  output.counting.push(bench(item.name, counters, c => () => c.fn(item.text)));
}
for (const item of pruneCases) {
  const entries = [
    { name: 'official', fn: () => OFFICIAL.pruneContent(item.blocks) },
    { name: 'base(linear)', fn: () => pruneContent(item.blocks, false) },
    { name: 'reuseWhole', fn: () => pruneContent(item.blocks, true) },
  ];
  output.pruning.push(bench(item.name, entries, e => e.fn));
}

// Derived verdicts (informational; decisions are made in the report, not here).
output.summary = {
  countingBaseline: 'shipping(scanPoints)',
  pruningBaseline: 'base(linear)',
  dceGuard: 'every return value is folded into SINK and asserted/serialized',
  sink: SINK,
};
assert.ok(Number.isFinite(SINK) && SINK > 0, 'benchmark results must be observed (DCE guard)');

const text = JSON.stringify(output, null, 2) + '\n';
process.stdout.write(text);
writeFileSync(new URL('./candidate-round3-results.json', import.meta.url), text);
