import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Original, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import LeetAccelerator from '../src/index.js';

function createService(Class, config) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Class(ctx, config);
}
const config = { thresholdChars: 50, headChars: 4, tailChars: 3 };
function implementations(options = config) {
  return [createService(Original, options), createService(LeetAccelerator, { ...options, enabled: false }), createService(LeetAccelerator, { ...options, enabled: true })];
}
function compare(blocks, options = config) {
  const [reference, off, on] = implementations(options);
  const before = structuredClone(blocks);
  for (const service of [off, on]) {
    assert.equal(service.measureContent(blocks), reference.measureContent(blocks));
    assert.deepEqual(service.pruneContent(blocks), reference.pruneContent(blocks));
  }
  assert.deepEqual(blocks, before, 'input must not be mutated');
}

test('threshold boundaries, non-text ordering, surrogate pairs and unpaired surrogates match the upstream implementation', () => {
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

test('seeded random multi-block content matches upstream for both switch positions', () => {
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

test('invalid upstream configuration fails in both switch positions', () => {
  for (const invalid of [{ thresholdChars: 0 }, { headChars: -1 }, { tailChars: 1.5 }, { thresholdChars: 50, headChars: 20, tailChars: 20 }, { threshold: 10 }]) {
    assert.throws(() => createService(Original, invalid));
    for (const enabled of [false, true]) assert.throws(() => createService(LeetAccelerator, { ...invalid, enabled }));
  }
  assert.throws(() => createService(LeetAccelerator, { enabled: 'true' }));
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
test('session receipt, shadow-price event, replay and repeated prune agree with upstream', () => {
  const initial = sessionWithToolResult();
  const seed = initial.session.snapshotEvents();
  const sessions = Array.from({ length: 3 }, () => Session.create(SessionId('parity'), seed));
  const services = implementations();
  const results = services.map((service, i) => service.pruneSession(sessions[i]));
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(results[0].pruned[0].originalSeq, initial.originalSeq);
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i], entry = results[i].pruned[0], events = session.snapshotEvents();
    assert.equal(events[entry.replacementSeq - 1].type, 'compaction/prune');
    assert.equal(events[entry.replacementSeq].type, 'tool/result');
    assert.equal(events[entry.replacementSeq].data.error.code, 'EXIT_1');
    assert.deepEqual(events[entry.replacementSeq].data.futureField, { nested: true });
    assert.deepEqual(events[entry.replacementSeq].sourceEventSeqs, [initial.originalSeq]);
    assert.deepEqual(services[i].pruneSession(session), { pruned: [], charsRemoved: 0 });
    const replay = Session.create(SessionId('parity'), session.snapshotEvents());
    assert.deepEqual(replay.deriveMessages(), session.deriveMessages());
  }
  assert.deepEqual(sessions[1].deriveMessages(), sessions[0].deriveMessages());
  assert.deepEqual(sessions[2].deriveMessages(), sessions[0].deriveMessages());
  assert.deepEqual(sessions[1].snapshotEvents().slice(seed.length).map(({ type, data, surfaceOp, sourceEventSeqs }) => ({ type, data, surfaceOp, sourceEventSeqs })), sessions[0].snapshotEvents().slice(seed.length).map(({ type, data, surfaceOp, sourceEventSeqs }) => ({ type, data, surfaceOp, sourceEventSeqs })));
  assert.deepEqual(sessions[2].snapshotEvents().slice(seed.length).map(({ type, data, surfaceOp, sourceEventSeqs }) => ({ type, data, surfaceOp, sourceEventSeqs })), sessions[0].snapshotEvents().slice(seed.length).map(({ type, data, surfaceOp, sourceEventSeqs }) => ({ type, data, surfaceOp, sourceEventSeqs })));
});
