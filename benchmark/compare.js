// Bounded, single-process microbenchmark of pruneContent only.
// This measures algorithm-local time. It is NOT a model task, session replay,
// end-to-end latency, token usage, or memory measurement.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import Original from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import LeetAccelerator from '../src/index.js';

const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
const variants = [
  { name: 'official', service: new Original(new Context(), config) },
  { name: 'off', service: new LeetAccelerator(new Context(), { ...config, enabled: false, fastLength: false }) },
  { name: 'linear', service: new LeetAccelerator(new Context(), { ...config, enabled: true, fastLength: false, shortCircuit: false }) },
  { name: 'linear+short', service: new LeetAccelerator(new Context(), { ...config, enabled: true, fastLength: false, shortCircuit: true }) },
  { name: 'fast', service: new LeetAccelerator(new Context(), { ...config, enabled: true, fastLength: true, shortCircuit: false }) },
  { name: 'fast+short', service: new LeetAccelerator(new Context(), { ...config, enabled: true, fastLength: true, shortCircuit: true }) },
];
const cases = [
  // Within-budget inputs (threshold is 8192): the common path in a real
  // session, where most tool results do not need pruning. shortCircuit can
  // skip the Unicode scan entirely. The emoji case is exactly 8192 UTF-16
  // units but only 4096 code points, so it sits on the upper-bound boundary.
  { name: 'short-ascii', blocks: [{ type: 'text', text: 'a'.repeat(4096) }] },
  { name: 'within-8k-ascii', blocks: [{ type: 'text', text: 'a'.repeat(8192) }] },
  { name: 'within-4k-emoji', blocks: [{ type: 'text', text: '😀'.repeat(4096) }] },
  // Over-budget inputs: the exact head/tail pruning path.
  { name: 'large-ascii', blocks: [{ type: 'text', text: 'a'.repeat(300_000) }] },
  { name: 'large-cjk', blocks: [{ type: 'text', text: '中'.repeat(300_000) }] },
  { name: 'large-emoji', blocks: [{ type: 'text', text: '😀'.repeat(150_000) }] },
  { name: 'large-mixed', blocks: [{ type: 'text', text: 'A中😀\ud800'.repeat(75_000) }] },
  { name: 'many-blocks', blocks: Array.from({ length: 100 }, (_, i) => i % 10 === 0 ? { type: 'reasoning', text: 'untouched' } : { type: 'text', text: 'a中😀'.repeat(1100) }) },
];
const WARMUPS = 12;
const SAMPLES = 60;
function percentile(samples, p) { return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]; }
function run(pruner, blocks) { const start = performance.now(); pruner.pruneContent(blocks); return performance.now() - start; }

const output = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  scope: 'pruneContent microbenchmark only; no model, no network, no session',
  warmups: WARMUPS,
  samplesPerCase: SAMPLES,
  unit: 'milliseconds',
  cases: [],
};
for (const item of cases) {
  const reference = variants[0].service.pruneContent(item.blocks);
  for (const variant of variants.slice(1)) {
    assert.deepEqual(variant.service.pruneContent(item.blocks), reference, `parity: ${item.name} / ${variant.name}`);
  }
  for (let i = 0; i < WARMUPS; i++) for (const variant of variants) run(variant.service, item.blocks);
  const samples = Object.fromEntries(variants.map(v => [v.name, []]));
  // Alternate the order each round so a drifting machine clock does not
  // systematically favour the first variant.
  for (let i = 0; i < SAMPLES; i++) {
    const order = i % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) samples[variant.name].push(run(variant.service, item.blocks));
  }
  output.cases.push({
    name: item.name,
    inputCodePoints: variants[0].service.measureContent(item.blocks),
    results: Object.fromEntries(variants.map(v => [v.name, {
      p50: percentile(samples[v.name], .50),
      p95: percentile(samples[v.name], .95),
      min: Math.min(...samples[v.name]),
      max: Math.max(...samples[v.name]),
    }])),
  });
}
const text = JSON.stringify(output, null, 2) + '\n';
process.stdout.write(text);
writeFileSync(new URL('./last-run.json', import.meta.url), text);
