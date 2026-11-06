// Replay the session-isolated compaction-group pruner rows that a REAL DSH
// 0.2.2-rc.1 Web Host returned via `POST /api/agentPresets/read` during 0.2.0
// verification (VERIFICATION.md §4). The rows are transcribed here so the
// check is reproducible without a running Host. They are configuration data,
// NOT a simulated model result and NOT a synthetic benchmark.
//
// The current implementation is instantiated with those exact rows. This
// answers: "which provider and which switch values would a Web session that
// selected one of the three derived presets actually use?" It does not start a
// Web Host or an agent session; see VERIFICATION.md for that boundary.
import { Context } from '@deepseek-ai/cordis';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Original from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import LeetAccelerator from '../src/index.js';

const OFFICIAL = '@deepseek-ai/dsh-compaction-tool-result-pruner';
const HOST_READ_ROWS = [
  {
    id: 'leet-comparison-off',
    name: OFFICIAL,
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  },
  {
    id: 'leet-comparison-linear',
    name: 'dsh-leet-accelerator',
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024, enabled: true, fastLength: false },
  },
  {
    id: 'leet-comparison-fast',
    name: 'dsh-leet-accelerator',
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024, enabled: true, fastLength: true },
  },
];

function createService(Class, config) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Class(ctx, config);
}

const longBlocks = [
  { type: 'text', text: 'A中😀\ud800'.repeat(3000) }, // 12000 code points, 15000 UTF-16 units
  { type: 'reasoning', text: 'untouched' },
  { type: 'text', text: '中'.repeat(2000) },
];
const shortBlocks = [{ type: 'text', text: 'a'.repeat(4096) }];
const edgeBlocks = [{ type: 'text', text: '😀'.repeat(4096) }]; // exactly 8192 UTF-16 units / 4096 code points

const officialRow = HOST_READ_ROWS[0];
const official = createService(Original, officialRow.config);
const expectedLong = official.pruneContent(structuredClone(longBlocks));

const rows = HOST_READ_ROWS.map(row => {
  const isOfficial = row.name === OFFICIAL;
  const service = createService(isOfficial ? Original : LeetAccelerator, row.config);
  return {
    id: row.id,
    provider: row.name,
    instance: service.constructor.name,
    shortCircuit: service instanceof LeetAccelerator ? service.shortCircuit : 'n/a (official)',
    shortCircuitInPreset: Object.hasOwn(row.config, 'shortCircuit'),
    longParity: JSON.stringify(service.pruneContent(structuredClone(longBlocks))) === JSON.stringify(expectedLong),
    shortReturnsNull: service.pruneContent(shortBlocks) === null,
    edgeReturnsNull: service.pruneContent(edgeBlocks) === null,
  };
});

// Same Host-read linear row with the switch explicitly disabled.
const linearRow = HOST_READ_ROWS[1];
const noShort = createService(LeetAccelerator, { ...linearRow.config, shortCircuit: false });
const offVariant = {
  longParity: JSON.stringify(noShort.pruneContent(structuredClone(longBlocks))) === JSON.stringify(expectedLong),
  shortReturnsNull: noShort.pruneContent(shortBlocks) === null,
  edgeReturnsNull: noShort.pruneContent(edgeBlocks) === null,
};

const [off, linear, fast] = rows;
const pass = off.provider === OFFICIAL && off.instance === 'ToolResultPruner'
  && linear.provider === 'dsh-leet-accelerator' && fast.provider === 'dsh-leet-accelerator'
  && linear.shortCircuit === true && fast.shortCircuit === true
  && rows.every(row => row.shortCircuitInPreset === false)
  && rows.every(row => row.longParity && row.shortReturnsNull && row.edgeReturnsNull)
  && offVariant.longParity && offVariant.shortReturnsNull && offVariant.edgeReturnsNull;

console.log(JSON.stringify({ source: 'real Host agentPresets/read (0.2.0 run, VERIFICATION.md §4)', rows, shortCircuitOffVariant: offVariant, verdict: pass ? 'PASS' : 'FAIL' }, null, 2));
if (!pass) process.exit(1);
