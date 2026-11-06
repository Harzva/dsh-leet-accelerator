// Bounded, single-process microbenchmark. This does not measure model or network latency.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LeetAccelerator from '../src/index.js';

const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
const baseline = new LeetAccelerator(new Context(), { ...config, enabled: false });
const accelerated = new LeetAccelerator(new Context(), { ...config, enabled: true });
const cases = [
  { name: 'short-ascii', blocks: [{ type: 'text', text: 'a'.repeat(4096) }] },
  { name: 'large-ascii', blocks: [{ type: 'text', text: 'a'.repeat(300_000) }] },
  { name: 'large-unicode', blocks: [{ type: 'text', text: 'A中😀\ud800'.repeat(75_000) }] },
  { name: 'many-blocks', blocks: Array.from({ length: 100 }, (_, i) => i % 10 === 0 ? { type: 'reasoning', text: 'untouched' } : { type: 'text', text: 'a中😀'.repeat(1100) }) },
];
function percentile(samples, p) { return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]; }
function run(pruner, blocks) { const start = performance.now(); pruner.pruneContent(blocks); return performance.now() - start; }
const output = { node: process.version, platform: `${process.platform}/${process.arch}`, warmups: 12, samplesPerCase: 60, unit: 'milliseconds', cases: [] };
for (const item of cases) {
  assert.deepEqual(accelerated.pruneContent(item.blocks), baseline.pruneContent(item.blocks), `parity: ${item.name}`);
  for (let i = 0; i < output.warmups; i++) { run(baseline, item.blocks); run(accelerated, item.blocks); }
  const off = [], on = [];
  for (let i = 0; i < output.samplesPerCase; i++) {
    if (i % 2 === 0) { off.push(run(baseline, item.blocks)); on.push(run(accelerated, item.blocks)); }
    else { on.push(run(accelerated, item.blocks)); off.push(run(baseline, item.blocks)); }
  }
  output.cases.push({ name: item.name, inputCodePoints: baseline.measureContent(item.blocks), off: { p50: percentile(off, .50), p95: percentile(off, .95) }, on: { p50: percentile(on, .50), p95: percentile(on, .95) } });
}
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
