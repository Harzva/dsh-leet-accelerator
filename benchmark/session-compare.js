// Bounded, single-process microbenchmark of pruneSession, the real session
// entry point that upstream compaction calls.
//
// This measures algorithm-local time only. It is NOT a model task, an
// end-to-end agent run, token usage, or a memory measurement. Sessions are
// built from a fixed event seed outside the timed region so the cost of
// Session.create is identical for every variant and never attributed to the
// pruner. A fresh Session is used for every sample because pruneSession
// appends events and mutates session state.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Original from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import LeetAccelerator from '../src/index.js';

const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

function createService(Class, options) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Class(ctx, options);
}

const variants = [
  { name: 'official', service: createService(Original, config) },
  { name: 'off', service: createService(LeetAccelerator, { ...config, enabled: false }) },
  { name: 'linear', service: createService(LeetAccelerator, { ...config, enabled: true, fastLength: false, shortCircuit: false, sessionMetrics: false }) },
  { name: 'linear+short', service: createService(LeetAccelerator, { ...config, enabled: true, fastLength: false, shortCircuit: true, sessionMetrics: false }) },
  { name: 'linear+short+cache', service: createService(LeetAccelerator, { ...config, enabled: true, fastLength: false, shortCircuit: true, sessionMetrics: true }) },
  { name: 'fast+short+cache', service: createService(LeetAccelerator, { ...config, enabled: true, fastLength: true, shortCircuit: true, sessionMetrics: true }) },
];

/** Build one deterministic session seed containing an arbitrary number of tool results. */
function buildSeed(resultContents) {
  const session = Session.create(SessionId('bench'));
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  for (let i = 0; i < resultContents.length; i++) {
    const callId = ToolCallId('call-' + i);
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' });
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' });
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: resultContents[i], isError: true }),
      error: { name: 'ExitError', code: 'EXIT_1' },
      futureField: { nested: true },
    }, { surfaceOp: 'append' });
  }
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session.snapshotEvents();
}

const text = (unit, count) => [{ type: 'text', text: unit.repeat(count) }];
const cases = [
  // Nothing to prune: the cache must be lazy and cost literally nothing here.
  { name: 'within-budget', contents: [text('a', 4096), text('中', 2000)] },
  { name: 'mixed-budget', contents: [text('a', 100), text('中', 100), text('😀', 100), text('a', 300_000)] },
  { name: 'single-large-ascii', contents: [text('a', 300_000)] },
  { name: 'single-large-cjk', contents: [text('中', 300_000)] },
  { name: 'single-large-emoji', contents: [text('😀', 150_000)] },
  { name: 'single-large-mixed', contents: [text('A中😀\ud800', 75_000)] },
  { name: 'multi-block', contents: [Array.from({ length: 100 }, (_, i) => i % 10 === 0
    ? { type: 'reasoning', text: 'untouched' }
    : { type: 'text', text: 'a中😀'.repeat(1100) })] },
  // Ten separate over-budget results: the cache is created once and reused
  // across every result in the same pruneSession call.
  { name: 'ten-results', contents: Array.from({ length: 10 }, (_, i) => text(i % 2 ? '中😀' : 'a', 30_000)) },
];

const WARMUPS = 8;
const SAMPLES = 40;

function percentile(samples, p) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
}

/** Timed region: session construction is deliberately excluded. */
function run(service, seed) {
  const session = Session.create(SessionId('bench'), seed);
  const start = performance.now();
  const result = service.pruneSession(session);
  return { ms: performance.now() - start, result };
}

/**
 * One-off instrumentation run (never timed): count exact Unicode scans.
 * `measureContent` calls are the upstream API surface; `_measureExact` is the
 * plugin's actual full-text scan, so a cache hit shows up as a call to
 * measureContent with zero new _measureExact work.
 */
function audit(service, seed) {
  let measureContentCalls = 0;
  let exactScans = 0;
  let utf16UnitsScanned = 0;
  const ownMeasure = service.measureContent;
  const ownExact = service._measureExact;
  service.measureContent = function (blocks) {
    measureContentCalls++;
    return ownMeasure.call(this, blocks);
  };
  if (typeof ownExact === 'function') {
    service._measureExact = function (blocks) {
      exactScans++;
      for (const block of blocks) if (block.type === 'text') utf16UnitsScanned += block.text.length;
      return ownExact.call(this, blocks);
    };
  }
  try {
    const session = Session.create(SessionId('audit'), seed);
    service.pruneSession(session);
  } finally {
    delete service.measureContent;
    if (typeof ownExact === 'function') delete service._measureExact;
  }
  return { measureContentCalls, exactScans, utf16UnitsScanned };
}

const output = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  scope: 'pruneSession algorithm-local microbenchmark only; no model, no network, no end-to-end agent run',
  warmups: WARMUPS,
  samplesPerCase: SAMPLES,
  unit: 'milliseconds',
  variants: variants.map(v => v.name),
  cases: [],
};

for (const item of cases) {
  const seed = buildSeed(item.contents);
  const reference = run(variants[0].service, seed).result;
  for (const variant of variants.slice(1)) {
    assert.deepEqual(run(variant.service, seed).result, reference,
      `parity: ${item.name} / ${variant.name}`);
  }
  // Alternate the warmup order too, so JIT/branch warming does not
  // systematically favour the variants that always warm up first (review S3).
  for (let i = 0; i < WARMUPS; i++) {
    const order = i % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) run(variant.service, seed);
  }
  const samples = Object.fromEntries(variants.map(v => [v.name, []]));
  // Alternate the order each round so a drifting machine clock does not
  // systematically favour the first variant.
  for (let i = 0; i < SAMPLES; i++) {
    const order = i % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) samples[variant.name].push(run(variant.service, seed).ms);
  }
  output.cases.push({
    name: item.name,
    toolResults: item.contents.length,
    results: Object.fromEntries(variants.map(v => [v.name, {
      p50: percentile(samples[v.name], .50),
      p95: percentile(samples[v.name], .95),
      min: Math.min(...samples[v.name]),
      max: Math.max(...samples[v.name]),
    }])),
    scanAudit: Object.fromEntries(variants.map(v => [v.name, audit(v.service, seed)])),
  });
}

const textOut = JSON.stringify(output, null, 2) + '\n';
process.stdout.write(textOut);
writeFileSync(new URL('./session-last-run.json', import.meta.url), textOut);
