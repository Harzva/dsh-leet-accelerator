// Round-2 candidate study. Research only: nothing here is loaded by the plugin.
// Two independent ideas are measured against the official provider and against
// the current shipping implementation:
//   shortCircuit  - codePointLength <= text.length, so if the sum of UTF-16
//                   lengths is <= threshold the content is definitely within
//                   budget and the whole Unicode scan can be skipped.
//   reuseMeasure  - pruneSession measures the same content array twice
//                   (pruneContent's total, then charsBefore). Reuse the value
//                   only inside one pruneSession call, keyed by array identity.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { PRUNE_MARKER, ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import LeetAccelerator from '../src/index.js';

// --- shared algorithm (byte-for-byte the shipping src/index.js logic) --------
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
function scanPoints(text) {
  let count = 0, paired = false;
  for (let i = 0; i < text.length; i++, count++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; paired = true; }
    }
  }
  return { length: count, paired };
}
function analyze(text, fastLength) {
  if (fastLength && !SURROGATE_PAIR.test(text)) return { length: text.length, paired: false };
  return scanPoints(text);
}
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

/** Base class: shipping semantics, with optional candidate switches. */
class Candidate extends LeetAccelerator {
  constructor(ctx, options = {}) {
    const { shortCircuit = false, reuseMeasure = false, ...rest } = options;
    super(ctx, rest);
    this.shortCircuit = shortCircuit;
    this.reuseMeasure = reuseMeasure;
    this._cache = undefined;
  }

  measureContent(blocks) {
    if (!this.enabled) return super.measureContent(blocks);
    if (this._cache) {
      const hit = this._cache.get(blocks);
      if (hit !== undefined) return hit;
    }
    let chars = 0;
    for (const block of blocks) if (block.type === 'text') chars += analyze(block.text, this.fastLength).length;
    if (this._cache) this._cache.set(blocks, chars);
    return chars;
  }

  pruneContent(blocks) {
    if (!this.enabled) return super.pruneContent(blocks);
    if (this.shortCircuit) {
      let units = 0;
      for (const block of blocks) if (block.type === 'text') units += block.text.length;
      // code points <= UTF-16 units, so a small upper bound proves within budget
      if (units <= this.config.thresholdChars) return null;
    }
    const analyzed = blocks.map(block => block.type === 'text'
      ? analyze(block.text, this.fastLength)
      : { length: 0, paired: false });
    const totalChars = analyzed.reduce((sum, entry) => sum + entry.length, 0);
    if (totalChars <= this.config.thresholdChars) return null;
    // Feed the value we just computed into the one-shot session cache.
    if (this._cache) this._cache.set(blocks, totalChars);

    const removedStart = this.config.headChars;
    const removedEnd = totalChars - this.config.tailChars;
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
      const text = block.text.slice(0, pointOffset(block.text, headEnd, length, paired))
        + marker + block.text.slice(pointOffset(block.text, tailStart, length, paired));
      if (text.length > 0) pruned.push({ ...block, text });
      consumed = blockEnd;
    }
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span');
    const charsAfter = this.measureContent(pruned);
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold');
    }
    return pruned;
  }

  pruneSession(session) {
    if (!this.enabled || !this.reuseMeasure) return super.pruneSession(session);
    const previous = this._cache;
    this._cache = new WeakMap();
    try { return super.pruneSession(session); }
    finally { this._cache = previous; }
  }
}

const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
function service(Type, options) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Type(ctx, options);
}
const variants = [
  { name: 'official', service: service(ToolResultPruner, config) },
  { name: 'shipping', service: service(LeetAccelerator, { ...config, enabled: true, fastLength: false }) },
  { name: 'shortCircuit', service: service(Candidate, { ...config, enabled: true, fastLength: false, shortCircuit: true }) },
  { name: 'reuseMeasure', service: service(Candidate, { ...config, enabled: true, fastLength: false, reuseMeasure: true }) },
  { name: 'both', service: service(Candidate, { ...config, enabled: true, fastLength: false, shortCircuit: true, reuseMeasure: true }) },
];

// --- parity ------------------------------------------------------------------
const parityInputs = [
  [{ type: 'text', text: 'a'.repeat(100) }],
  [{ type: 'text', text: 'a'.repeat(8192) }],
  [{ type: 'text', text: '中'.repeat(8192) }],
  [{ type: 'text', text: '😀'.repeat(4096) }],           // 8192 UTF-16 units, 4096 points
  [{ type: 'text', text: '😀'.repeat(8192) }],
  [{ type: 'text', text: 'a中😀\ud800'.repeat(2000) }],
  [{ type: 'reasoning', text: 'untouched' }, { type: 'text', text: 'a'.repeat(20000) }],
  Array.from({ length: 20 }, (_, i) => i % 4 === 0
    ? { type: 'reasoning', text: 'untouched' }
    : { type: 'text', text: '中😀'.repeat(600) }),
];
for (let i = 0; i < parityInputs.length; i++) {
  const blocks = parityInputs[i];
  const reference = variants[0].service.pruneContent(blocks);
  for (const v of variants.slice(1)) {
    assert.deepEqual(v.service.pruneContent(blocks), reference, `pruneContent parity case ${i} / ${v.name}`);
  }
}

// --- session construction ----------------------------------------------------
function makeSession(texts) {
  const s = Session.create(SessionId('bench'));
  s.append('turn/start', { turn: 1 });
  s.append('step/start', { turn: 1, step: 1 });
  const calls = texts.map((_, i) => ToolCallId('call-' + i));
  s.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: calls.map((id, i) => ({ type: 'tool-call', id, name: 'bash-' + i, arguments: '{}' })),
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' });
  for (let i = 0; i < texts.length; i++) {
    s.append('tool/call', { turn: 1, step: 1, callId: calls[i], name: 'bash-' + i, arguments: '{}' });
    s.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: calls[i], content: [{ type: 'text', text: texts[i] }], isError: false }),
    }, { surfaceOp: 'append' });
  }
  s.append('step/end', { turn: 1, step: 1 });
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return s;
}
const q = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const score = fn => { const t = performance.now(); fn(); return performance.now() - t; };
const WARMUPS = 10, SAMPLES = 60;

const cases = [
  { name: 'pruneContent/within-1k', kind: 'content', blocks: [{ type: 'text', text: 'a'.repeat(1000) }] },
  { name: 'pruneContent/within-8k-ascii', kind: 'content', blocks: [{ type: 'text', text: 'a'.repeat(8192) }] },
  { name: 'pruneContent/within-8k-emoji', kind: 'content', blocks: [{ type: 'text', text: '😀'.repeat(4096) }] },
  { name: 'pruneContent/over-300k', kind: 'content', blocks: [{ type: 'text', text: 'a'.repeat(300_000) }] },
  { name: 'pruneSession/one-short', kind: 'session', texts: ['a'.repeat(1000)] },
  { name: 'pruneSession/one-large', kind: 'session', texts: ['a'.repeat(300_000)] },
  { name: 'pruneSession/mixed-8-results', kind: 'session', texts: [
    'a'.repeat(500), '中'.repeat(700), 'a'.repeat(300_000), 'a'.repeat(900),
    '😀'.repeat(400), 'a'.repeat(200), '中😀'.repeat(3000), 'a'.repeat(600),
  ] },
];

// Session-level parity: identical results AND identical derived messages.
for (const item of cases.filter(c => c.kind === 'session')) {
  const seed = makeSession(item.texts).snapshotEvents();
  const baseline = Session.create(SessionId('bench'), seed);
  const expected = variants[1].service.pruneSession(baseline);
  const expectedMessages = baseline.deriveMessages();
  for (const v of variants.slice(2)) {
    const s = Session.create(SessionId('bench'), seed);
    assert.deepEqual(v.service.pruneSession(s), expected, `pruneSession parity ${item.name} / ${v.name}`);
    assert.deepEqual(s.deriveMessages(), expectedMessages, `derived messages ${item.name} / ${v.name}`);
  }
}

const output = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  scope: 'algorithm-local pruneContent / pruneSession microbenchmark; no model, no network, no quota',
  warmups: WARMUPS,
  samplesPerCase: SAMPLES,
  unit: 'milliseconds',
  parity: 'all variants byte-identical to official pruneContent; pruneSession results and derived messages identical to shipping',
  cases: [],
};
for (const item of cases) {
  const run = v => item.kind === 'content'
    ? score(() => v.service.pruneContent(item.blocks))
    : score(() => v.service.pruneSession(makeSession(item.texts)));
  for (let i = 0; i < WARMUPS; i++) for (const v of variants) run(v);
  const samples = Object.fromEntries(variants.map(v => [v.name, []]));
  for (let i = 0; i < SAMPLES; i++) {
    const order = i % 2 === 0 ? variants : [...variants].reverse();
    for (const v of order) samples[v.name].push(run(v));
  }
  output.cases.push({
    name: item.name,
    results: Object.fromEntries(variants.map(v => [v.name, {
      p50: q(samples[v.name], .50), p95: q(samples[v.name], .95),
      min: Math.min(...samples[v.name]), max: Math.max(...samples[v.name]),
    }])),
  });
}
const text = JSON.stringify(output, null, 2) + '\n';
process.stdout.write(text);
writeFileSync(new URL('./candidate-round2-results.json', import.meta.url), text);
