// DSH client module format: the Host serves this factory without bundling React.
// Slot contract (packages/extensions/cordis-client-runner/src/client/slot-catalog.ts,
// key `conversation.hero.options`, scope `session`): framework props already
// include `sessionId` and `useSessions`; the entry's `inject` face is spread
// onto the component props as-is.
window.__ModuleLoader__.load({
  id: 'dsh-leet-accelerator',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const OFF = 'leet-comparison-off'
    const LINEAR = 'leet-comparison-linear'
    const FAST = 'leet-comparison-fast'
    const supported = value => value === OFF || value === LINEAR || value === FAST

    function nextPreset(current, algorithm) {
      if (!supported(current)) return null
      if (algorithm === 'linear') return current === OFF ? LINEAR : OFF
      if (algorithm === 'fast') return current === FAST ? LINEAR : current === LINEAR ? FAST : null
      return null
    }

    // Remote calls answer with { ok, value, error }; tolerate a bare id too so
    // a transport that unwraps the result still reports the committed state.
    function committedPreset(result) {
      if (typeof result === 'string') return result
      if (result && result.ok === true) return result.value
      return undefined
    }

    function AcceleratorOptions({ sessionId, useSessions, selectPreset }) {
      const session = useSessions(state => state.byId[sessionId])
      const projected = session?.projectionValues?.agentPreset
      const [confirmed, setConfirmed] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      useEffect(() => { setConfirmed(null); setMessage('') }, [sessionId, projected])
      const current = confirmed ?? projected
      const isSupported = supported(current)
      const linear = current === LINEAR || current === FAST
      const fast = current === FAST
      const locked = busy || !session || !session.blank || !isSupported

      async function toggle(algorithm) {
        const target = nextPreset(current, algorithm)
        if (locked || target === null) return
        setBusy(true)
        setMessage('')
        try {
          const result = await selectPreset(target)
          const value = committedPreset(result)
          if (value === undefined) {
            throw new Error(result?.error?.message || '服务端未确认所选状态')
          }
          if (value !== target) throw new Error('服务端未确认所选状态')
          setConfirmed(target)
        } catch (error) {
          setMessage(error instanceof Error ? error.message : '切换失败，请检查连接后重试')
        } finally { setBusy(false) }
      }

      const baseStyle = { minHeight: 28, padding: '0 8px', border: 0,
        borderRadius: 'var(--dsw-radius-sm, 6px)', fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer' }
      const button = (label, algorithm, active, disabled, title) => h('button', {
        type: 'button', key: algorithm, disabled, title, 'aria-pressed': active,
        'aria-describedby': 'leet-accelerator-scope',
        onClick: () => toggle(algorithm),
        style: { ...baseStyle, opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'default' : 'pointer',
          background: active ? 'var(--dsw-alias-interactive-bg-hover, #ddd)' : 'transparent' },
      }, `${label}：${active ? '开' : '关'}`)
      const reason = !session ? '正在读取会话状态'
        : !session.blank ? '已开始的会话不能更换预设，切换只对当前空白会话及之后新建的会话生效'
        : !isSupported ? '先在预设菜单选择 Leet 比较预设，再调整算法'
        : ''
      const hint = busy ? '正在保存…'
        : reason || (fast ? '快速计数已开启：实验候选，纯 emoji 等输入可能变慢'
          : linear ? '线性裁剪已开启；快速计数尚未开启'
            : '当前使用官方裁剪算法')
      return h('div', { role: 'group', 'aria-label': 'Leet 优化开关',
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
        button('线性裁剪', 'linear', linear, locked, reason || '切换线性裁剪'),
        button('快速计数（实验）', 'fast', fast, locked || !linear,
          reason || (!linear ? '快速计数依赖线性裁剪，请先开启线性裁剪' : '切换快速计数（实验候选）')),
        h('span', { id: 'leet-accelerator-scope', role: 'status', 'aria-live': 'polite',
          style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } },
          message || hint),
        h('span', { style: { display: 'none' } },
          '开关只对当前空白会话及之后新建的会话生效；已开始的会话不会即时切换。快速计数依赖线性裁剪，且为未通过真实模型任务验收的实验候选。'))
    }

    const inject = ['slots', 'sessions', 'remote', 'remote.agentPresets']
    function apply(ctx) {
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options', id: 'leet-accelerator', order: 50,
        inject: sessionId => ({
          selectPreset: id => ctx.remote.agentPresets.select(sessionId, id),
        }),
      }, AcceleratorOptions))
    }
    return { inject, apply, nextPreset, committedPreset }
  },
})
