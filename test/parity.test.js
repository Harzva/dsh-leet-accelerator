import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Original, { PRUNE_MARKER, ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import LeetAccelerator from '../src/index.js';

function createService(Class, config) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Class(ctx, config);
}

const config = { thresholdChars: 50, headChars: 4, tailChars: 3 };

// All eight independent switch combinations (enabled x fastLength x
// shortCircuit), plus the untouched upstream implementation as the reference.
// The `off/...` rows deliberately keep the other switches set: they must be
// no-ops while the whole optimization is off.
const SWITCHES = [{ name: 'official', original: true }];
for (const enabled of [false, true]) {
  for (const fastLength of [false, true]) {
    for (const shortCircuit of [false, true]) {
      SWITCHES.push({
        name: `${enabled ? 'on' : 'off'}/${fastLength ? 'fast' : 'linear'}/${shortCircuit ? 'short' : 'full'}`,
        enabled, fastLength, shortCircuit,
      });
    }
  }
}

function implementations(options = config) {
  return SWITCHES.map(sw => ({
    ...sw,
    service: sw.original
      ? createService(Original, options)
      : createService(LeetAccelerator, {
        ...options, enabled: sw.enabled, fastLength: sw.fastLength, shortCircuit: sw.shortCircuit,
      }),
  }));
}

function compare(blocks, options = config) {
  const [reference, ...variants] = implementations(options);
  const before = structuredClone(blocks);
  const expectedMeasure = reference.service.measureContent(blocks);
  const expectedPrune = reference.service.pruneContent(blocks);
  for (const { name, service } of variants) {
    assert.equal(service.measureContent(blocks), expectedMeasure, `${name}: measureContent`);
    assert.deepEqual(service.pruneContent(blocks), expectedPrune, `${name}: pruneContent`);
  }
  assert.deepEqual(blocks, before, 'input must not be mutated');
}

test('every switch combination exposes its own state', () => {
  for (const { name, original, enabled, fastLength, shortCircuit, service } of implementations()) {
    if (original) continue;
    assert.equal(service.enabled, enabled, name);
    assert.equal(service.fastLength, fastLength, name);
    assert.equal(service.shortCircuit, shortCircuit, name);
  }
  assert.equal(createService(LeetAccelerator, { ...config, enabled: true }).shortCircuit, true,
    'shortCircuit defaults to on');
  assert.throws(() => createService(LeetAccelerator, { ...config, enabled: 'true' }));
  assert.throws(() => createService(LeetAccelerator, { ...config, fastLength: 1 }));
  assert.throws(() => createService(LeetAccelerator, { ...config, shortCircuit: 'yes' }));
});

test('the off position delegates to the official algorithm even when fastLength is set', () => {
  const blocks = [{ type: 'text', text: 'A中😀\ud800'.repeat(60) }];
  for (const { name, enabled, service } of implementations()) {
    if (name === 'official' || enabled !== false) continue;
    // Call the upstream method directly on the same instance to prove that the
    // off branch produces exactly what the official implementation produces.
    assert.equal(service.measureContent(blocks),
      ToolResultPruner.prototype.measureContent.call(service, blocks), name);
    assert.deepEqual(service.pruneContent(blocks),
      ToolResultPruner.prototype.pruneContent.call(service, blocks), name);
  }
});

test('threshold boundaries, non-text ordering, surrogate pairs and unpaired surrogates match upstream in all eight combinations', () => {
  for (const length of [0, 1, 49, 50, 51, 52, 100]) {
    for (const unit of ['a', '中', '😀', '\ud800', '\udc00', 'e\u0301']) {
      compare([{ type: 'text', text: unit.repeat(length) }]);
    }
  }
  compare([{ type: 'reasoning', text: 'nontext' }, { type: 'text', text: '😀'.repeat(23) }, { type: 'image', attachment: { mediaType: 'image/png', bytes: 2 } }, { type: 'text', text: '\ud800A\udc00'.repeat(30) }, { type: 'text', text: '' }, { type: 'tool-call', id: 'nested', name: 'nested', arguments: '{}' }, { type: 'text', text: '中'.repeat(25) }]);
  // An isolated high surrogate and low surrogate in separate blocks remain
  // separate code points; combining them across blocks changes the result.
  compare([{ type: 'text', text: 'a'.repeat(20) + '\ud800' }, { type: 'text', text: '\udc00' + 'b'.repeat(60) }]);
  compare([{ type: 'text', text: '😀\ud800\udc00A'.repeat(40) }], { thresholdChars: Array.from(PRUNE_MARKER).length, headChars: 0, tailChars: 0 });
});

test('fastLength probe and paired-boundary lookup agree at Unicode edge cases', () => {
  const edges = [
    // No adjacent pair: the probe must take the O(1) path and still be exact.
    '\ud800A\udc00'.repeat(40),
    '\udc00\ud800'.repeat(40),
    'a\ud800b\udc00c'.repeat(30),
    // A pair at the very end: the probe scans the whole block before falling back.
    'a'.repeat(120) + '😀',
    // A pair at the very front: the probe short-circuits, then a full scan runs.
    '😀' + '中'.repeat(120),
    // ZWJ sequences, combining marks, BOM and NUL.
    '👩‍💻'.repeat(40),
    'e\u0301'.repeat(80),
    '\ufeff\u0000中'.repeat(40),
    // Mixed, with the head/tail boundaries landing between pairs.
    'A中😀B\ud800'.repeat(30),
  ];
  for (const text of edges) {
    compare([{ type: 'text', text }]);
    compare([{ type: 'text', text: text.slice(0, 37) }, { type: 'text', text }, { type: 'text', text: text.slice(-41) }]);
  }
  // Odd head/tail budgets force the boundary lookup onto a surrogate pair.
  // The marker is 39 code points, so keep head + tail within budget.
  for (const headChars of [1, 3, 5, 7]) {
    for (const tailChars of [1, 2, 5]) {
      compare([{ type: 'text', text: '😀'.repeat(120) }], { thresholdChars: 100, headChars, tailChars });
      compare([{ type: 'text', text: '👩‍💻A中'.repeat(40) }], { thresholdChars: 100, headChars, tailChars });
    }
  }
});

test('shortCircuit upper bound is exact at the UTF-16 / code-point boundary', () => {
  const on = createService(LeetAccelerator, { ...config, enabled: true, shortCircuit: true });
  const off = createService(LeetAccelerator, { ...config, enabled: true, shortCircuit: false });
  const official = createService(Original, config);
  // threshold is 50. A code point is 1 or 2 UTF-16 units, so `units <= 50`
  // proves the code-point total is within budget; `units > 50` proves nothing
  // and must fall through to the exact scan. Exercise both sides, including
  // lone surrogates (1 unit, 1 code point) and non-text blocks (0 points).
  const cases = [
    'a'.repeat(49), 'a'.repeat(50), 'a'.repeat(51),
    '中'.repeat(50), '中'.repeat(51),
    '😀'.repeat(24), '😀'.repeat(25), '😀'.repeat(26), '😀'.repeat(50), '😀'.repeat(51),
    '\ud800'.repeat(50), '\ud800'.repeat(51), '\udc00'.repeat(51),
    'a\ud800b\udc00'.repeat(13),
  ];
  for (const text of cases) {
    for (const blocks of [
      [{ type: 'text', text }],
      [{ type: 'reasoning', text: 'ignored' }, { type: 'text', text }, { type: 'image', attachment: { mediaType: 'image/png', bytes: 2 } }],
      [{ type: 'text', text: text.slice(0, 20) }, { type: 'text', text: text.slice(20) }],
    ]) {
      const expected = official.pruneContent(blocks);
      assert.deepEqual(on.pruneContent(blocks), expected, 'shortCircuit on');
      assert.deepEqual(off.pruneContent(blocks), expected, 'shortCircuit off');
      // The short-circuit only decides whether to prune; measurement stays exact.
      assert.equal(on.measureContent(blocks), official.measureContent(blocks));
    }
  }
  // With the whole optimization off, shortCircuit must not change anything.
  const disabled = createService(LeetAccelerator, { ...config, enabled: false, shortCircuit: true });
  assert.deepEqual(disabled.pruneContent([{ type: 'text', text: 'a'.repeat(20) }]),
    ToolResultPruner.prototype.pruneContent.call(disabled, [{ type: 'text', text: 'a'.repeat(20) }]));
});

test('seeded random multi-block content matches upstream in all eight combinations', () => {
  let state = 0x97cd47;
  const random = max => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
  const atoms = ['A', '界', '😀', '👩‍💻', '\ud800', '\udc00', '\n', '\u0301'];
  for (let caseNo = 0; caseNo < 300; caseNo++) {
    const blocks = [];
    for (let i = 0, n = 1 + random(12); i < n; i++) {
      if (random(5) === 0) blocks.push({ type: 'reasoning', text: 'hidden-' + i });
      else { let text = ''; for (let j = 0, len = random(50); j < len; j++) text += atoms[random(atoms.length)]; blocks.push({ type: 'text', text, tag: i }); }
    }
    compare(blocks);
  }
});

test('invalid upstream configuration fails in all eight combinations', () => {
  for (const invalid of [{ thresholdChars: 0 }, { headChars: -1 }, { tailChars: 1.5 }, { thresholdChars: 50, headChars: 20, tailChars: 20 }, { threshold: 10 }]) {
    assert.throws(() => createService(Original, invalid));
    for (const sw of SWITCHES) {
      if (sw.original) continue;
      assert.throws(() => createService(LeetAccelerator, {
        ...invalid, enabled: sw.enabled, fastLength: sw.fastLength, shortCircuit: sw.shortCircuit,
      }), sw.name);
    }
  }
});

function sessionWithToolResult() {
  const session = Session.create(SessionId('parity'));
  const callId = ToolCallId('one');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' });
  const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: '😀A\ud800'.repeat(80) }], isError: true }), error: { name: 'ExitError', code: 'EXIT_1' }, futureField: { nested: true } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { session, originalSeq: result.seq };
}

test('session receipt, shadow-price event, replay and repeated prune agree with upstream in all eight combinations', () => {
  const initial = sessionWithToolResult();
  const seed = initial.session.snapshotEvents();
  const impls = implementations();
  const sessions = impls.map(() => Session.create(SessionId('parity'), seed));
  const results = impls.map(({ service }, i) => service.pruneSession(sessions[i]));
  const referenceEvents = (session, length) => session.snapshotEvents().slice(length)
    .map(({ type, data, surfaceOp, sourceEventSeqs }) => ({ type, data, surfaceOp, sourceEventSeqs }));
  for (let i = 1; i < impls.length; i++) assert.deepEqual(results[i], results[0], impls[i].name);
  assert.equal(results[0].pruned[0].originalSeq, initial.originalSeq);
  for (let i = 0; i < impls.length; i++) {
    const session = sessions[i], entry = results[i].pruned[0], events = session.snapshotEvents();
    assert.equal(events[entry.replacementSeq - 1].type, 'compaction/prune', impls[i].name);
    assert.equal(events[entry.replacementSeq].type, 'tool/result', impls[i].name);
    assert.equal(events[entry.replacementSeq].data.error.code, 'EXIT_1', impls[i].name);
    assert.deepEqual(events[entry.replacementSeq].data.futureField, { nested: true }, impls[i].name);
    assert.deepEqual(events[entry.replacementSeq].sourceEventSeqs, [initial.originalSeq], impls[i].name);
    assert.deepEqual(impls[i].service.pruneSession(session), { pruned: [], charsRemoved: 0 }, impls[i].name);
    const replay = Session.create(SessionId('parity'), session.snapshotEvents());
    assert.deepEqual(replay.deriveMessages(), session.deriveMessages(), impls[i].name);
    assert.deepEqual(session.deriveMessages(), sessions[0].deriveMessages(), impls[i].name);
    assert.deepEqual(referenceEvents(session, seed.length), referenceEvents(sessions[0], seed.length), impls[i].name);
  }
});
