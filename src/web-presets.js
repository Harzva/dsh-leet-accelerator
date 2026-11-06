// Derive explicit comparison presets without editing the source preset.
// A preset is a startup snapshot: existing sessions retain their own revision.
export const inject = ['loader', 'agentPresets']

const ORIGINAL = '@deepseek-ai/dsh-compaction-tool-result-pruner'
const ACCELERATOR = 'dsh-leet-accelerator'
const ids = ['leet-comparison-off', 'leet-comparison-linear', 'leet-comparison-fast']

/** Create independent baseline, linear, and fast-count copies of a preset. */
export function derivePresets(source) {
  if (!source || source.id !== 'standard' || !Array.isArray(source.plugins)) {
    throw new Error('Leet comparison requires the current standard preset definition')
  }
  const off = structuredClone(source)
  const linear = structuredClone(source)
  const groups = linear.plugins.filter(row => row?.id === 'compaction' && row.group === true && Array.isArray(row.config))
  if (groups.length !== 1 || groups[0].isolate?.toolResultPruner !== true || groups[0].isolate?.compaction !== true) {
    throw new Error('Leet comparison requires one isolated compaction group')
  }
  const matches = groups[0].config.filter(row => row?.id === 'tool-result-pruner')
  if (matches.length !== 1 || matches[0].name !== ORIGINAL || matches[0].disabled) {
    throw new Error('Leet comparison requires one enabled official pruner')
  }
  const target = matches[0]
  if (target.config !== undefined && (!target.config || typeof target.config !== 'object' || Array.isArray(target.config))) {
    throw new Error('Leet comparison cannot preserve this pruner configuration')
  }
  const config = target.config || {}
  if (Object.keys(config).some(key => !['thresholdChars', 'headChars', 'tailChars'].includes(key))) {
    throw new Error('Leet comparison cannot preserve unknown pruner settings')
  }
  target.name = ACCELERATOR
  target.config = { ...config, enabled: true, fastLength: false }
  const fast = structuredClone(linear)
  const fastGroup = fast.plugins.find(row => row.id === 'compaction')
  fastGroup.config.find(row => row.id === 'tool-result-pruner').config.fastLength = true
  // Lifecycle: these are registered preset IDs, so a session that recorded one
  // keeps referencing it after this plugin is disabled or uninstalled. We do
  // NOT silently rewrite those sessions. The off snapshot uses only official
  // providers and stays resolvable; the two optimized snapshots name this
  // package, so their historical sessions may fail to recover once the bundle
  // is gone. The descriptions surface that, and README documents switching
  // affected sessions back to `standard` before uninstalling.
  return [
    { ...off, id: ids[0], name: 'Leet 优化关闭（标准预设快照）', description: '官方裁剪算法，仅使用官方 provider；只影响空白/新会话。', order: 100 },
    { ...linear, id: ids[1], name: 'Leet 线性裁剪（标准预设快照）', description: '线性裁剪；只影响空白/新会话。卸载本插件后，使用此预设的历史会话可能无法恢复。', order: 101 },
    { ...fast, id: ids[2], name: 'Leet 快速计数（实验，标准预设快照）', description: '线性裁剪 + 快速计数；实验候选，纯 emoji 等输入可能变慢；只影响空白/新会话。卸载本插件后历史会话可能无法恢复。', order: 102 },
  ]
}

function findStandard(ctx) {
  const rows = [...ctx.loader.entries()].filter(row => row.options?.id === 'preset-standard'
    && row.options?.name === '@deepseek-ai/dsh-agent-preset')
  if (rows.length > 1) throw new Error('Leet comparison found ambiguous standard preset declarations')
  return rows[0]?.options?.config
}

/** Register selectable preset snapshots; never change the standard preset. */
export async function apply(ctx) {
  // Host rows start concurrently, so registration can run just before the
  // standard declaration reaches the Loader. Bound the wait and fail visibly.
  let source = findStandard(ctx)
  const deadline = Date.now() + 5000
  while (!source && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    source = findStandard(ctx)
  }
  const definitions = derivePresets(source)
  const disposers = []
  let disposed = false
  // Copy before reversing: the cleanup callback must stay idempotent even if
  // the host invokes it more than once, and must not reorder the shared array.
  async function rollback() {
    if (disposed) return
    disposed = true
    for (const dispose of [...disposers].reverse()) await dispose()
  }
  try {
    for (const definition of definitions) disposers.push(await ctx.agentPresets.register(definition))
  } catch (error) {
    await rollback()
    throw error
  }
  ctx.effect(() => async () => { await rollback() })
}
