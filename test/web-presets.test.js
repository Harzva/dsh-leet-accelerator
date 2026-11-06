import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { apply, derivePresets } from '../src/web-presets.js'

function standard() {
  return { id: 'standard', order: 1, plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'unchanged' } },
    { id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true }, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ] },
    { id: 'shell', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
  ] }
}

test('comparison presets preserve user configuration and isolate only the on provider', () => {
  const source = standard(), before = structuredClone(source)
  const [off, on, fast] = derivePresets(source)
  assert.deepEqual(source, before)
  assert.equal(off.id, 'leet-comparison-off')
  assert.equal(on.id, 'leet-comparison-linear')
  assert.equal(fast.id, 'leet-comparison-fast')
  assert.deepEqual(off.plugins, source.plugins)
  assert.deepEqual(on.plugins[0], source.plugins[0])
  assert.deepEqual(on.plugins[2], source.plugins[2])
  assert.deepEqual(on.plugins[1].isolate, source.plugins[1].isolate)
  assert.deepEqual(on.plugins[1].config[0], source.plugins[1].config[0])
  assert.deepEqual(on.plugins[1].config[1], { id: 'tool-result-pruner', name: 'dsh-leet-accelerator',
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024, enabled: true, fastLength: false } })
  assert.equal(fast.plugins[1].config[1].config.fastLength, true)
  on.plugins[0].config.prefix = 'independent'
  assert.equal(source.plugins[0].config.prefix, 'unchanged')
})

test('comparison fails closed when a user changed or disabled the pruner', () => {
  for (const mutate of [
    value => { value.plugins[1].config[1].name = 'other-provider' },
    value => { value.plugins[1].config[1].disabled = true },
    value => { value.plugins[1].config[1].config.extra = 1 },
    value => { value.plugins[1].isolate.toolResultPruner = false },
    value => { value.plugins[1].config.push(structuredClone(value.plugins[1].config[1])) },
  ]) {
    const value = standard()
    mutate(value)
    assert.throws(() => derivePresets(value))
  }
  assert.throws(() => derivePresets({ id: 'minimal', plugins: [] }))
})

test('registrations are separate, disposed, and never mutate the original entry', async () => {
  const source = standard(), before = structuredClone(source), registered = [], disposed = []
  let cleanup
  const ctx = {
    loader: { entries: () => [{ options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: source } }] },
    agentPresets: { register: async value => { registered.push(value); return async () => disposed.push(value.id) } },
    effect: factory => { cleanup = factory() },
  }
  await apply(ctx)
  assert.deepEqual(registered.map(value => value.id), ['leet-comparison-off', 'leet-comparison-linear', 'leet-comparison-fast'])
  assert.deepEqual(source, before)
  await cleanup()
  assert.deepEqual(disposed, ['leet-comparison-fast', 'leet-comparison-linear', 'leet-comparison-off'])
})

test('partial registration is rolled back if the second id collides', async () => {
  const disposed = []
  let calls = 0
  const ctx = {
    loader: { entries: () => [{ options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: standard() } }] },
    agentPresets: { register: async value => { if (++calls === 2) throw new Error('Duplicate agent preset'); return async () => disposed.push(value.id) } },
    effect: () => { throw new Error('cleanup must not register') },
  }
  await assert.rejects(apply(ctx), /Duplicate agent preset/)
  assert.deepEqual(disposed, ['leet-comparison-off'])
})

test('DSH client bundle exposes independent algorithm transitions and refuses unrelated presets', async () => {
  let definition
  const source = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value } } } })
  assert.equal(definition.id, 'dsh-leet-accelerator')
  const client = definition.factory(request => {
    assert.equal(request, 'react')
    return { createElement() {}, useState() {}, useEffect() {} }
  })
  assert.equal(client.nextPreset('leet-comparison-off', 'linear'), 'leet-comparison-linear')
  assert.equal(client.nextPreset('leet-comparison-linear', 'linear'), 'leet-comparison-off')
  assert.equal(client.nextPreset('leet-comparison-fast', 'linear'), 'leet-comparison-off')
  assert.equal(client.nextPreset('leet-comparison-linear', 'fast'), 'leet-comparison-fast')
  assert.equal(client.nextPreset('leet-comparison-fast', 'fast'), 'leet-comparison-linear')
  assert.equal(client.nextPreset('leet-comparison-off', 'fast'), null)
  assert.equal(client.nextPreset('standard', 'linear'), null)
})
