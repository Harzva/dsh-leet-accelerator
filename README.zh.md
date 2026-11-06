# dsh-leet-accelerator

面向 **DeepSeek Harness（DSH）** 的独立可选插件：减少长工具结果裁剪时的临时数组分配，并为每项优化提供独立开关与 Web 界面按钮。本项目**与 OpenBot 无关**，也不是 DeepSeek 官方插件。

[English](README.md) · [验证记录](VERIFICATION.md)

## 改了什么

上游 [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) 的 `measureContent` / `pruneContent` 会对每个文本块执行 `Array.from(text)` 展开成码点数组，再用 `slice().join('')` 保留头尾。长结果会分配一个整串码点数组外加两个切片。

本插件**只在 patch 生效的作用域**替换 `toolResultPruner` provider，并继承官方 `pruneSession`（影子计价事件、token 计量、回放）。三个独立的配置开关（其中两个有 Web 按钮）：

| 开关 | 默认 | 做法 |
|---|---|---|
| `enabled` | `false` | 用一次线性 UTF-16 扫描代替 `Array.from`，同一遍顺便记录块内是否存在有效代理对。没有代理对时码点位置就等于 UTF-16 偏移，边界定位降到 O(1)；有代理对时从更近的一端扫描。不分配整串码点数组。 |
| `fastLength` | `false` | **实验候选**：先用正则探测，若块内没有相邻代理对，`text.length` 就是码点数，跳过线性扫描。含代理对的文本会多付一次探测，然后仍要完整扫描。依赖 `enabled`；`enabled: false` 时不参与算法。 |
| `shortCircuit` | `true` | **0.3.0 新增**。上界剪枝：每个码点占 1 或 2 个 UTF-16 单元，所以各文本块 `text.length` 之和是码点总数的上界。若这个上界已在 `thresholdChars` 内，精确码点数也必然不超阈值，`pruneContent` 直接返回 `null`，不扫描任何文本。`measureContent` 仍返回精确值。输出不变，不需要「content 不可变」这类前提，超阈值输入的 −0.1%~+0.7% 差异在噪声范围内、无可测退化。 |

八种组合 `enabled × fastLength × shortCircuit` 都有测试。两种 `enabled: false` 状态都会委托 `super.measureContent` / `super.pruneContent`，也就是**原样执行官方算法**，上下文保护仍然开启。`shortCircuit` 是配置层开关：Web 按钮仍只控制 `enabled` 与 `fastLength`，Web 会话通过 provider 默认值继承 `shortCircuit: true`，因此 preset id 和历史会话不受影响。

`fastLength` **不是已验证的优化**。本轮 Node 24 数据里，它在 emoji 密集、混合和多块输入上没有可测收益（相对线性 −1.2%~+0.3%，属于噪声），而上一轮同样输入类别曾测到 −5.5%~−12.3% 的退化；两轮的 official 基线本身相差约 2 倍，说明机器波动很大。它从未用真实模型任务测过。除非你测过自己的负载，否则保持关闭。

## 算法局部基准

`benchmark/compare.js`，Node v24.16.0 / darwin/arm64，只计 `pruneContent`。预热 12 次，每个变体 60 个交替样本，每轮交替变体顺序。单位毫秒。完整 P50/P95/min/max 数据在 [`benchmark/last-run.json`](benchmark/last-run.json)。

变体：`official` 为上游实现；`off` 是本插件 `enabled: false`（委托 `super`）；`linear` 只开 `enabled`；`+shortCircuit` 开 `enabled` + `shortCircuit`；`fast` 开 `enabled` + `fastLength`；`fast+short` 三个全开。

**P50（毫秒）**

| 输入 | 码点数 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short | 线性提升 | shortCircuit 相对线性 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0237 | 0.0238 | 0.0071 | 0.0002 | 0.0003 | 0.0002 | 70.1% | +97.1% |
| within-8k-ascii | 8192 | 0.0456 | 0.0457 | 0.0192 | 0.0002 | 0.0002 | 0.0002 | 57.9% | +99.1% |
| within-4k-emoji | 4096 | 0.0371 | 0.0371 | 0.0172 | 0.0002 | 0.0172 | 0.0002 | 53.6% | +99.0% |
| large-ascii | 300000 | 4.0967 | 4.1055 | 0.7108 | 0.7065 | 0.0024 | 0.0010 | 82.7% | +0.6% |
| large-cjk | 300000 | 4.9089 | 5.1203 | 0.7155 | 0.7103 | 0.3058 | 0.3049 | 85.4% | +0.7% |
| large-emoji | 150000 | 3.4025 | 3.3535 | 0.6725 | 0.6702 | 0.6722 | 0.6697 | 80.2% | +0.3% |
| large-mixed | 300000 | 6.0002 | 5.9958 | 1.1054 | 1.1061 | 1.1023 | 1.1154 | 81.6% | −0.1% |
| many-blocks | 297000 | 4.5665 | 4.5430 | 0.9065 | 0.9019 | 0.9063 | 0.9129 | 80.1% | +0.5% |

**P95（毫秒）**

| 输入 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0290 | 0.0477 | 0.0181 | 0.0005 | 0.0007 | 0.0003 |
| within-8k-ascii | 0.0474 | 0.0807 | 0.0197 | 0.0002 | 0.0003 | 0.0002 |
| within-4k-emoji | 0.0913 | 0.0490 | 0.0175 | 0.0002 | 0.0176 | 0.0002 |
| large-ascii | 4.9015 | 4.8854 | 0.8828 | 1.0440 | 0.0039 | 0.0018 |
| large-cjk | 17.0456 | 19.8360 | 1.3634 | 1.4011 | 0.4805 | 0.7938 |
| large-emoji | 7.3663 | 6.9890 | 1.1290 | 0.7804 | 0.9855 | 0.7706 |
| large-mixed | 11.0940 | 10.6041 | 1.3737 | 1.5468 | 1.5622 | 1.7598 |
| many-blocks | 5.0763 | 5.3664 | 1.0323 | 1.0102 | 1.4402 | 1.0603 |

怎么看这些数字：

- `off` 在每个 case 都紧贴 `official`，这正是委托 `super` 的预期开销。
- `shortCircuit` 是**未超阈值快速路径**：三个短输入相对线性降低 97–99%（相对官方 99.1–99.6%），因为完全不扫描文本。超阈值输入只多读几次 `.length`，相对线性的 −0.1%~+0.7% 是噪声。
- `fastLength` 强依赖负载：无代理对的长 ASCII / CJK 提升极大，emoji / 混合 / 多块输入没有收益。`within-4k-emoji` 这一行能看出探测路径仍跑完整扫描（0.0172），而 `fast+short` 直接跳过（0.0002）。
- P95 与 max 波动大（官方 `large-cjk` P95 17.0 ms、max 26.4 ms；`linear+short` 的 `large-ascii` P95 1.04 ms 而 P50 0.71 ms）。每变体 60 个样本属于小样本，且是单机单进程数字；**不是**模型任务、端到端耗时、Token 用量、内存或成功率测量。裁剪只在满足上下文压缩条件时触发，因此这些数字不代表整体任务会加速。

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
- `shortCircuit` **没有 Web 按钮**。三份派生预设都继承 provider 默认值 `true`；需要关闭可用 `--patch` 覆盖对应行。0.3.0 没有改动任何 preset id，历史会话仍可解析。
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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.3.0
# ...也可以改用精确的 commit SHA 固定

# 或安装发布 tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.3.0.tgz

# 查看组合层，然后启动
dsh --profile YOUR_WEB_PROFILE --dump-config
dsh --profile YOUR_WEB_PROFILE

# 升级 / 卸载
dsh plugin --profile YOUR_WEB_PROFILE update dsh-leet-accelerator
dsh plugin --profile YOUR_WEB_PROFILE remove dsh-leet-accelerator
```

`--dump-config` 只能证明配置层组合结果，**不能**证明 Web 会话实际使用了哪个 provider；见验证记录。

## Web 之外的开关

两种不触碰用户 profile 的方式，控制的是同一组配置标志：

1. bundle patch 默认值 —— `cordis.patch.yml` 插入 `dsh-leet-accelerator` 并设 `enabled: true`。后续 `--patch` 覆盖可按 id 改写该行；注意 patch 会替换整份 `config`，需要把 `thresholdChars`、`headChars`、`tailChars` 以及想保留的非默认开关一起写全。
2. `npm run control` —— 本地 HTTP 页面，只写插件目录下的 `control/accelerator.patch.json`。启动方式：`dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "任务"`。它保存的是**下次启动读取的设置**，不检测运行实例，不要暴露到网络，也不要多进程同时编辑。

bundle patch 会在同一作用域禁用官方 `tool-result-pruner` 行。不要给同一个 `toolResultPruner` 作用域同时启用两个 provider。Web 会话在 agent preset 内使用隔离的 compaction 组，这正是需要上面那套 preset 开关的原因。

## 测试与复现

```sh
npm ci
npm test          # 18 项：八种开关组合、shortCircuit 边界、Unicode 边界、会话回放、客户端单测
npm run benchmark # 写入 benchmark/last-run.json
node research/candidate-round2.mjs      # shortCircuit 已落地；reuseMeasure 仍是纯研究候选
node research/host-preset-replay.mjs     # 用真实 Host 读出的 preset 行回放当前实现
```

`test/parity.test.js` 用官方 `0.2.2-rc.1` 实现作对照，覆盖八种组合：阈值边界、300 组随机多块 Unicode 输入、孤立代理字符、ZWJ 序列、奇数头尾预算、非法配置、`shortCircuit` 的 UTF-16 / 码点边界专项（49/50/51 单元、emoji 代理对、孤立代理），以及完整 `pruneSession` 事件与回放一致性。`test/web-presets.test.js` 覆盖预设派生和用假 React 做的客户端 slot / 状态机**单元测试** —— 这些不是浏览器操作，也不是会话作用域证明。

## 市场状态

按[官方插件索引文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)，DSH **不内置任何索引源**。Discover 读取用户手动添加的第三方 `index.json`，索引属于第三方内容。GitHub 加 `dsh-plugin` topic 只是方便人搜索，**不会**自动进入任何 DSH 市场。本项目**尚未被任何具体市场索引收录**。已核验的格式规则见 [VERIFICATION.md](VERIFICATION.md)。

## 已知限制

- **没有真实模型前后对照**。唯一一次真实请求返回 HTTP 402 / `QUOTA: Insufficient Balance`，没有工具执行、没有 pruner 触发；没有用 mock 冒充真实结果。
- `fastLength` 在 emoji 密集、混合、多块输入上本轮无收益、上一轮有退化，默认关闭，也没有真实任务证据。
- `shortCircuit` 只帮助本来就在预算内的内容；超阈值的长工具结果仍要走完整扫描。
- preset 方式无法改变已启动的会话。
- 卸载后派生 preset id 可能导致历史会话无法恢复（见上）。
- parity 只针对 DSH `0.2.2-rc.1` 验证过，声明范围内其它版本未测。
- 顶层 bundle patch 不控制 Web 会话的隔离 compaction 组；Web 会话请用派生 preset。

## 许可

MIT。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）；上游版权与许可声明保留在 [LICENSE](LICENSE)。
