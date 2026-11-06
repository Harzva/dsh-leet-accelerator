# dsh-leet-accelerator

面向 **DeepSeek Harness（DSH）** 的独立可选插件：减少长工具结果裁剪时的临时数组分配，并为每项优化提供独立开关与 Web 界面按钮。本项目**与 OpenBot 无关**，也不是 DeepSeek 官方插件。

[English](README.md) · [验证记录](VERIFICATION.md)

## 改了什么

上游 [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) 的 `measureContent` / `pruneContent` 会对每个文本块执行 `Array.from(text)` 展开成码点数组，再用 `slice().join('')` 保留头尾。长结果会分配一个整串码点数组外加两个切片。

本插件**只在 patch 生效的作用域**替换 `toolResultPruner` provider，并继承官方 `pruneSession`（影子计价事件、token 计量、回放）。两个独立开关：

| 开关 | 默认 | 做法 |
|---|---|---|
| `enabled` | `false` | 用一次线性 UTF-16 扫描代替 `Array.from`，同一遍顺便记录块内是否存在有效代理对。没有代理对时码点位置就等于 UTF-16 偏移，边界定位降到 O(1)；有代理对时从更近的一端扫描。不分配整串码点数组。 |
| `fastLength` | `false` | **实验候选**：先用正则探测，若块内没有相邻代理对，`text.length` 就是码点数，跳过线性扫描。含代理对的文本会多付一次探测，然后仍要完整扫描。依赖 `enabled`；`enabled: false` 时不参与算法。 |

四种组合 `enabled × fastLength` 都有测试。两种 `enabled: false` 状态都会委托 `super.measureContent` / `super.pruneContent`，也就是**原样执行官方算法**，上下文保护仍然开启。

`fastLength` **不是已验证的优化**：它在 emoji 密集和多块输入上退化（见下表），也从未用真实模型任务测过。除非你测过自己的负载，否则保持关闭。

## 算法局部基准

`benchmark/compare.js`，Node v24.16.0 / darwin/arm64，只计 `pruneContent`。预热 12 次，每个变体 60 个交替样本，每轮交替变体顺序。单位毫秒。完整数据在 [`benchmark/last-run.json`](benchmark/last-run.json)。

| 输入 | 码点数 | 官方 P50 / P95 | 线性 P50 / P95 | +fastLength P50 / P95 | 线性提升 | fastLength 相对线性 |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0261 / 0.1252 | 0.0075 / 0.0630 | 0.0003 / 0.0045 | 71.2% | 95.6% |
| large-ascii | 300000 | 6.5405 / 16.5320 | 0.8298 / 3.1730 | 0.0031 / 0.0075 | 87.3% | 99.6% |
| large-cjk | 300000 | 6.5791 / 34.3798 | 0.8538 / 3.3254 | 0.2352 / 0.8321 | 87.0% | 72.5% |
| large-emoji | 150000 | 5.6723 / 20.9982 | 0.7117 / 3.0680 | 0.7606 / 2.7589 | 87.5% | **-6.9%** |
| large-mixed | 300000 | 12.8945 / 179.9068 | 1.4041 / 5.7415 | 1.4815 / 13.2795 | 89.1% | **-5.5%** |
| many-blocks | 297000 | 9.1445 / 14.5886 | 1.1627 / 3.8307 | 1.3062 / 4.6193 | 87.3% | **-12.3%** |

本机 P95 波动很大（官方 large-mixed 有一个样本到 179.9 ms，符合 GC 或系统负载干扰）。每变体 60 个样本属于小样本，且是单机单进程数字；**不是**模型任务、端到端耗时、Token 用量、内存或成功率测量。裁剪只在满足上下文压缩条件时触发，因此这些数字不代表整体任务会加速。

## Web 开关

客户端在 `conversation.hero.options` slot 注册两个按钮：**线性裁剪** 与 **快速计数（实验）**。切换状态通过官方 `ctx.remote.agentPresets.select(sessionId, presetId)` 更换会话的 agent preset，**不修改、不 monkey-patch 上游代码**。

从当前 `standard` 预设派生三份快照：

| 预设 id | `enabled` | `fastLength` |
|---|---|---|
| `leet-comparison-off` | 只用官方 provider | 无 |
| `leet-comparison-linear` | `true` | `false` |
| `leet-comparison-fast` | `true` | `true` |

- **不覆盖** `standard` 或任何自定义预设；遇到 id 冲突或结构不符会失败关闭并回滚注册。
- preset 是启动快照。按钮只对当前**空白会话**以及之后新建的会话生效；已开始的会话由 Host 以 `agent-preset/locked` 拒绝，界面禁用按钮并说明原因。插件不宣称已运行会话能即时切换。
- `fastLength` 在 `enabled` 未开启时按钮禁用，依赖关系写在 tooltip 里。
- 保存失败、连接中断、服务端拒绝都会显示在 `role="status"` 的实时区域；busy 状态阻止重复提交。按钮是原生 `<button>`，带 `aria-pressed`、`aria-describedby` 和有标签的分组，可用键盘操作。
- 重启或刷新页面后，状态从会话的 `agentPreset` 投影读回，不依赖仅存在于客户端的标志。

**生命周期限制（重要）**：会话会记录它使用的 preset id。卸载本插件后，用过 `leet-comparison-linear` / `leet-comparison-fast` 的历史会话可能无法恢复该组合，因为这两份快照把本包写成裁剪 provider。`leet-comparison-off` 只用官方 provider，仍可解析。**卸载前请把相关会话切回 `standard`**。三份预设的描述里也写明了这一点。

Web 具体做了哪些真实检查、基于哪个 DSH 版本、还有哪些未完成，见 [VERIFICATION.md](VERIFICATION.md)。

## 兼容范围与安装

- 实际做过 parity 测试的版本是 DSH `0.2.2-rc.1`。`engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`，范围内其它版本**未验证**。
- Node.js >= 24.9.0。上游参考提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。
- peer 依赖必须复用运行实例的版本：`@deepseek-ai/dsh-compaction-tool-result-pruner` `0.2.2-rc.1`、`@deepseek-ai/schemastery` `~3.19.0`。
- 纯 JS、无构建步骤：`./client` 导出指向仓库内已提交的浏览器 factory 脚本（lazy-CJS 的 `window.__ModuleLoader__.load` 注册），根导出是 Node 插件。安装时不生成任何产物，因此 Git 安装不需要 `prepare` 脚本，也不需要 `pnpm allowBuilds` 许可；但仍建议固定提交 SHA。

```sh
# Git 源码安装，固定到发布 tag（不需要构建许可）
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.2.0
# ...也可以改用精确的 commit SHA 固定

# 或安装发布 tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.2.0.tgz

# 查看组合层，然后启动
dsh --profile YOUR_WEB_PROFILE --dump-config
dsh --profile YOUR_WEB_PROFILE

# 升级 / 卸载
dsh plugin --profile YOUR_WEB_PROFILE update dsh-leet-accelerator
dsh plugin --profile YOUR_WEB_PROFILE remove dsh-leet-accelerator
```

`--dump-config` 只能证明配置层组合结果，**不能**证明 Web 会话实际使用了哪个 provider；见验证记录。

## Web 之外的开关

两种不触碰用户 profile 的方式，控制的是同两个标志：

1. bundle patch 默认值 —— `cordis.patch.yml` 插入 `dsh-leet-accelerator` 并设 `enabled: true`。后续 `--patch` 覆盖可按 id 改写该行；注意 patch 会替换整份 `config`，需要把 `thresholdChars`、`headChars`、`tailChars` 一起写全。
2. `npm run control` —— 本地 HTTP 页面，只写插件目录下的 `control/accelerator.patch.json`。启动方式：`dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "任务"`。它保存的是**下次启动读取的设置**，不检测运行实例，不要暴露到网络，也不要多进程同时编辑。

bundle patch 会在同一作用域禁用官方 `tool-result-pruner` 行。不要给同一个 `toolResultPruner` 作用域同时启用两个 provider。Web 会话在 agent preset 内使用隔离的 compaction 组，这正是需要上面那套 preset 开关的原因。

## 测试与复现

```sh
npm ci
npm test          # 17 项：四种开关组合、Unicode 边界、会话回放、客户端单测
npm run benchmark # 写入 benchmark/last-run.json
```

`test/parity.test.js` 用官方 `0.2.2-rc.1` 实现作对照，覆盖四种组合：阈值边界、300 组随机多块 Unicode 输入、孤立代理字符、ZWJ 序列、奇数头尾预算、非法配置，以及完整 `pruneSession` 事件与回放一致性。`test/web-presets.test.js` 覆盖预设派生和用假 React 做的客户端 slot / 状态机**单元测试** —— 这些不是浏览器操作，也不是会话作用域证明。

## 市场状态

按[官方插件索引文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)，DSH **不内置任何索引源**。Discover 读取用户手动添加的第三方 `index.json`，索引属于第三方内容。GitHub 加 `dsh-plugin` topic 只是方便人搜索，**不会**自动进入任何 DSH 市场。本项目**尚未被任何具体市场索引收录**。已核验的格式规则见 [VERIFICATION.md](VERIFICATION.md)。

## 已知限制

- **没有真实模型前后对照**。唯一一次真实请求返回 HTTP 402 / `QUOTA: Insufficient Balance`，没有工具执行、没有 pruner 触发；没有用 mock 冒充真实结果。
- `fastLength` 在 emoji 密集和多块输入上退化，默认关闭。
- preset 方式无法改变已启动的会话。
- 卸载后派生 preset id 可能导致历史会话无法恢复（见上）。
- parity 只针对 DSH `0.2.2-rc.1` 验证过，声明范围内其它版本未测。
- 顶层 bundle patch 不控制 Web 会话的隔离 compaction 组；Web 会话请用派生 preset。

## 许可

MIT。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）；上游版权与许可声明保留在 [LICENSE](LICENSE)。
