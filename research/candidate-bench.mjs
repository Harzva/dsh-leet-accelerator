import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Base from '../src/index.js';

const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `unique replacement: ${from}`);
  return source.replace(from, to);
}
let fastSrc = replaceOnce(src, 'function countPoints(text) {',
  'function countPoints(text) {\n  if (!/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/.test(text)) return text.length;');
let cacheSrc = replaceOnce(src, '  constructor(ctx, options = {}) {',
  '  pruneSession(session) { const previous = this._counts; this._counts = new WeakMap(); try { return super.pruneSession(session); } finally { this._counts = previous; } }\n\n  constructor(ctx, options = {}) {');
cacheSrc = replaceOnce(cacheSrc, '    let chars = 0;\n    for (const block of blocks)',
  '    if (this._counts?.has(blocks)) return this._counts.get(blocks);\n    let chars = 0;\n    for (const block of blocks)');
cacheSrc = replaceOnce(cacheSrc, "    for (const block of blocks) if (block.type === 'text') chars += countPoints(block.text);\n    return chars;",
  "    for (const block of blocks) if (block.type === 'text') chars += countPoints(block.text);\n    if (this._counts) this._counts.set(blocks, chars);\n    return chars;");
cacheSrc = replaceOnce(cacheSrc, '    const totalChars = lengths.reduce((sum, length) => sum + length, 0);',
  '    const totalChars = lengths.reduce((sum, length) => sum + length, 0);\n    if (this._counts) this._counts.set(blocks, totalChars);');
await writeFile(new URL('./candidate-fast.mjs', import.meta.url), fastSrc);
await writeFile(new URL('./candidate-cache.mjs', import.meta.url), cacheSrc);
const Fast = (await import('./candidate-fast.mjs')).default;
const Cache = (await import('./candidate-cache.mjs')).default;

function service(Type) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  return new Type(ctx, { enabled: true });
}
const base = service(Base), fast = service(Fast), cache = service(Cache);
const options = [
  ['short-ascii', 'A'.repeat(4096)],
  ['long-ascii', 'A'.repeat(300000)],
  ['long-cjk', '中'.repeat(300000)],
  ['long-emoji', '😀'.repeat(150000)],
  ['long-mixed', 'A中😀\ud800'.repeat(75000)],
];
const q = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
const results = { node: process.version, platform: `${process.platform}/${process.arch}`, samples: 50, warmups: 10, unit: 'ms', fastLength: [], pruneSessionCache: [] };
function score(fn) { const start=performance.now(); fn(); return performance.now()-start; }
for (const [name, text] of options) {
  const input=[{ type:'text', text }];
  assert.deepEqual(fast.pruneContent(input), base.pruneContent(input));
  for (let i=0;i<10;i++) { base.pruneContent(input); fast.pruneContent(input); }
  const a=[], b=[];
  for (let i=0;i<50;i++) {
    if(i%2) { b.push(score(()=>fast.pruneContent(input))); a.push(score(()=>base.pruneContent(input))); }
    else { a.push(score(()=>base.pruneContent(input))); b.push(score(()=>fast.pruneContent(input))); }
  }
  results.fastLength.push({ name, inputUnits:text.length, off:{p50:q(a,.5),p95:q(a,.95)}, on:{p50:q(b,.5),p95:q(b,.95)} });
}
function session(text) {
  const s=Session.create(SessionId('bench')); const id=ToolCallId('call');
  s.append('turn/start',{turn:1}); s.append('step/start',{turn:1,step:1});
  s.append('assistant/message',{stream:[],turn:1,step:1,message:createMessage({role:'assistant',content:[{type:'tool-call',id,name:'bash',arguments:'{}'}],source:{kind:'model',provider:'test',model:'test'}})},{surfaceOp:'append'});
  s.append('tool/call',{turn:1,step:1,callId:id,name:'bash',arguments:'{}'});
  s.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:id,content:[{type:'text',text}],isError:false})},{surfaceOp:'append'});
  s.append('step/end',{turn:1,step:1}); s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  return s;
}
for (const [name, text] of options) {
  const seed=session(text).snapshotEvents(),s1=Session.create(SessionId('bench'),seed),s2=Session.create(SessionId('bench'),seed);
  assert.deepEqual(cache.pruneSession(s2),base.pruneSession(s1));
  assert.deepEqual(s2.deriveMessages(),s1.deriveMessages());
  const a=[],b=[];
  for(let i=0;i<60;i++) {
    const one=session(text), two=session(text);
    const forward = () => { const x=score(()=>base.pruneSession(one)); const y=score(()=>cache.pruneSession(two)); return [x,y]; };
    const backward = () => { const y=score(()=>cache.pruneSession(two)); const x=score(()=>base.pruneSession(one)); return [x,y]; };
    const [x,y] = i%2 ? backward() : forward();
    if(i>=10){a.push(x);b.push(y);}
  }
  results.pruneSessionCache.push({name,inputUnits:text.length,off:{p50:q(a,.5),p95:q(a,.95)},on:{p50:q(b,.5),p95:q(b,.95)}});
}
console.log(JSON.stringify(results,null,2));
