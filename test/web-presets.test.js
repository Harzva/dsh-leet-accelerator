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

test('derived presets document the uninstall lifecycle and the experimental candidate', () => {
  const [, linear, fast] = derivePresets(standard())
  assert.match(linear.description, /卸载/)
  assert.match(fast.description, /实验/)
  assert.match(fast.description, /卸载/)
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

// Client-side unit tests only. They use a fake React and a fake slot registry;
// they do NOT prove that a real Web Host mounts the slot or that a real
// session's pruner changes. Those need the separate Host verification.
function loadClientBundle() {
  return readFile(new URL('../src/client/index.js', import.meta.url), 'utf8').then(source => {
    let definition
    runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value } } } })
    return definition
  })
}

function clientHarness(hookValues = {}) {
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => {
      const index = hookIndex++
      return [Object.hasOwn(hookValues, index) ? hookValues[index] : initial, value => { hookValues[index] = value }]
    },
    useEffect: () => {},
  }
  return React
}

async function mountClient(options = {}) {
  const definition = await loadClientBundle()
  const React = clientHarness(options.hooks)
  let registered
  const selected = []
  const ctx = {
    slots: {
      inject: (key, factory) => { assert.equal(key, 'conversation.hero.options'); return factory() },
      register: (slotOptions, Component) => { registered = { slotOptions, Component }; return () => {} },
    },
    sessions: { list: () => {} },
    remote: { agentPresets: { select: async (sessionId, id) => { selected.push([sessionId, id]); return options.selectResult ?? { ok: true, value: id } } } },
  }
  const client = definition.factory(request => { assert.equal(request, 'react'); return React })
  client.apply(ctx)
  assert.equal(client.inject.join(','), 'slots,sessions,remote,remote.agentPresets')
  // The real ClientContext withholds `ctx.remote` unless 'remote' itself is
  // injected; a fake context in a unit test would not catch that.
  assert.ok(client.inject.includes('remote'))
  assert.equal(registered.slotOptions.name, 'conversation.hero.options')
  assert.equal(registered.slotOptions.id, 'leet-accelerator')
  const injectFace = registered.slotOptions.inject('session-1')
  const useSessions = selector => selector({ byId: { 'session-1': options.session ?? { blank: true, projectionValues: { agentPreset: 'leet-comparison-off' } } } })
  const render = () => registered.Component({ sessionId: 'session-1', useSessions, selectPreset: injectFace.selectPreset })
  return { client, ctx, registered, injectFace, selected, render }
}

function buttons(tree) {
  return tree.children.filter(child => child.type === 'button')
}

test('DSH client bundle exposes independent algorithm transitions and refuses unrelated presets', async () => {
  const definition = await loadClientBundle()
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
  assert.equal(client.committedPreset({ ok: true, value: 'leet-comparison-linear' }), 'leet-comparison-linear')
  assert.equal(client.committedPreset('leet-comparison-fast'), 'leet-comparison-fast')
  assert.equal(client.committedPreset({ ok: false, error: { message: 'no' } }), undefined)
})

test('client slot inject passes only selectPreset and targets the real remote with the session id', async () => {
  const { injectFace, selected } = await mountClient()
  assert.deepEqual(Object.keys(injectFace), ['selectPreset'])
  const result = await injectFace.selectPreset('leet-comparison-linear')
  assert.deepEqual(result, { ok: true, value: 'leet-comparison-linear' })
  assert.deepEqual(selected, [['session-1', 'leet-comparison-linear']])
})

test('client buttons show state, keyboard attributes, dependency and scope on a blank session', async () => {
  const { render } = await mountClient()
  const tree = render()
  assert.equal(tree.props['aria-label'], 'Leet 优化开关')
  const [linear, fast] = buttons(tree)
  assert.equal(linear.props.type, 'button')
  assert.equal(linear.props['aria-pressed'], false)
  assert.equal(fast.props['aria-pressed'], false)
  assert.equal(linear.props.disabled, false)
  assert.equal(fast.props.disabled, true, 'fastLength depends on the linear optimization')
  assert.match(fast.props.title, /依赖|先开启/)
  assert.equal(linear.props['aria-describedby'], 'leet-accelerator-scope')
  const status = tree.children.find(child => child.props?.role === 'status')
  assert.equal(status.props['aria-live'], 'polite')
  assert.equal(status.props.id, 'leet-accelerator-scope')
})

test('client refuses a started session, an unrelated preset, and reports a remote failure', async () => {
  const started = await mountClient({ session: { blank: false, projectionValues: { agentPreset: 'leet-comparison-linear' } } })
  const [linear, fast] = buttons(started.render())
  assert.equal(linear.props.disabled, true)
  assert.equal(fast.props.disabled, true)
  assert.match(started.render().children.find(c => c.props?.role === 'status').children[0], /已开始的会话/)

  const foreign = await mountClient({ session: { blank: true, projectionValues: { agentPreset: 'standard' } } })
  assert.equal(buttons(foreign.render())[0].props.disabled, true)

  const failed = await mountClient({ hooks: { 1: true } })
  assert.equal(buttons(failed.render())[0].props.disabled, true, 'busy state blocks double submit')

  const refused = await mountClient({ selectResult: { ok: false, error: { message: '连接中断' } } })
  const [toggle] = buttons(refused.render())
  let captured
  // Re-render with a message hook value to assert the failure surface.
  const withMessage = await mountClient({ hooks: { 2: '连接中断' }, selectResult: { ok: false, error: { message: '连接中断' } } })
  captured = withMessage.render().children.find(c => c.props?.role === 'status').children[0]
  assert.equal(captured, '连接中断')
  assert.equal(typeof toggle.props.onClick, 'function')
})
