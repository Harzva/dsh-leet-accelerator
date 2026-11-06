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

// The four independent switch combinations, plus the untouched upstream
// implementation as the reference. `off/fast-ignored` is deliberately present:
// fastLength must be a no-op while the whole optimization is off.
const SWITCHES = [
  { name: 'official', original: true },
  { name: 'off/plain', enabled: false, fastLength: false },
  { name: 'off/fast-ignored', enabled: false, fastLength: true },
  { name: 'on/linear', enabled: true, fastLength: false },
  { name: 'on/fast', enabled: true, fastLength: true },
];

function implementations(options = config) {
  return SWITCHES.map(sw => ({
    ...sw,
    service: sw.original
      ? createService(Original, options)
      : createService(LeetAccelerator, { ...options, enabled: sw.enabled, fastLength: sw.fastLength }),
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
  for (const { name, original, enabled, fastLength, service } of implementations()) {
    if (original) continue;
    assert.equal(service.enabled, enabled, name);
    assert.equal(service.fastLength, fastLength, name);
  }
  assert.throws(() => createService(LeetAccelerator, { ...config, enabled: 'true' }));
  assert.throws(() => createService(LeetAccelerator, { ...config, fastLength: 1 }));
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

test('threshold boundaries, non-text ordering, surrogate pairs and unpaired surrogates match upstream in all four combinations', () => {
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

test('seeded random multi-block content matches upstream in all four combinations', () => {
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

test('invalid upstream configuration fails in all four combinations', () => {
  for (const invalid of [{ thresholdChars: 0 }, { headChars: -1 }, { tailChars: 1.5 }, { thresholdChars: 50, headChars: 20, tailChars: 20 }, { threshold: 10 }]) {
    assert.throws(() => createService(Original, invalid));
    for (const sw of SWITCHES) {
      if (sw.original) continue;
      assert.throws(() => createService(LeetAccelerator, { ...invalid, enabled: sw.enabled, fastLength: sw.fastLength }), sw.name);
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

test('session receipt, shadow-price event, replay and repeated prune agree with upstream in all four combinations', () => {
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
