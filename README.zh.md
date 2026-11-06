# dsh-leet-accelerator

面向 **DeepSeek Harness（DSH）** 的独立可选插件：减少长工具结果裁剪时的临时数组分配与重复扫描，并为每项优化提供独立开关与 Web 界面按钮。本项目**与 OpenBot 无关**，也不是 DeepSeek 官方插件。

[English](README.md) · [验证记录](VERIFICATION.md)

## 改了什么

上游 [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) 的 `measureContent` / `pruneContent` 会对每个文本块执行 `Array.from(text)` 展开成码点数组，再用 `slice().join('')` 保留头尾。长结果会分配一个整串码点数组外加两个切片。

本插件**只在 patch 生效的作用域**替换 `toolResultPruner` provider，并继承官方 `pruneSession`（影子计价事件、token 计量、回放）。四个独立的配置开关（其中两个有 Web 按钮）：

| 开关 | 默认 | 做法 |
|---|---|---|
| `enabled` | `false` | 用一次线性 UTF-16 扫描代替 `Array.from`，同一遍顺便记录块内是否存在有效代理对。没有代理对时码点位置就等于 UTF-16 偏移，边界定位降到 O(1)；有代理对时从更近的一端扫描。不分配整串码点数组。 |
| `fastLength` | `false` | **实验候选**：先用正则探测，若块内没有相邻代理对，`text.length` 就是码点数，跳过线性扫描。含代理对的文本会多付一次探测，然后仍要完整扫描。依赖 `enabled`；`enabled: false` 时不参与算法。 |
| `shortCircuit` | `true` | **0.3.0 新增**。上界剪枝：每个码点占 1 或 2 个 UTF-16 单元，所以各文本块 `text.length` 之和是码点总数的上界。若这个上界已在 `thresholdChars` 内，精确码点数也必然不超阈值，`pruneContent` 直接返回 `null`，不扫描任何文本。`measureContent` 仍返回精确值。输出不变，不需要「content 不可变」这类前提；0.4.0 这一轮超阈值输入相对线性的 −1.7%~+4.6% 属于轮次波动，没有一致性退化。 |
| `sessionMetrics` | `true` | **0.4.0 新增**。在一次 `pruneSession` 调用内用短生命周期、带结构校验的 `WeakMap` 去掉重复测量，并用已算出的码点位置推导 `charsAfter`，不再重新扫描裁剪后文本。只在第一个真正需要裁剪的结果上惰性建缓存，预算内会话零额外开销。依赖 `enabled`；设为 `false` 即回到 0.3.0 路径。详见下节。 |

十六种组合 `enabled × fastLength × shortCircuit × sessionMetrics` 都有测试。所有 `enabled: false` 状态都会委托 `super.measureContent` / `super.pruneContent`，也就是**原样执行官方算法**，上下文保护仍然开启。`shortCircuit` 与 `sessionMetrics` 是配置层开关：Web 按钮仍只控制 `enabled` 与 `fastLength`，Web 会话通过 provider 默认值继承这两项，因此 preset id 和历史会话不受影响。

`fastLength` **不是已验证的优化**。在这台机器上，它在 emoji 密集、混合、多块输入上相对线性的 P50 跨轮波动范围是 −12.3%~+3.9%，各轮 official 基线本身变化很大。它从未用真实模型任务测过。除非你测过自己的负载，否则保持关闭。

## 0.4.0 的会话层优化

上游 `pruneSession` 对每个超阈值工具结果要测量**四次**：`pruneContent` 内部量一次原始内容、一次裁剪后内容，`pruneSession` 自己又以 `charsBefore` / `charsAfter` 再各量一次。0.4.0 之前，`shortCircuit` 让预算内结果变便宜了，但这条超阈值路径没有变化。

`sessionMetrics` 在**单次同步 `pruneSession` 调用栈内**装一个缓存：

- **惰性创建**：只有第一个精确码点总数超过阈值的结果才会建缓存。整个会话都在预算内时，既不分配缓存也不做结构校验。
- 命中条件：数组长度、每个 block 的 `type`、每个文本块的 `text` 字符串都要与快照一致。JS 字符串不可变，非 text block 对码点数贡献为 0，所以快照一致就证明总数不可能变化。push / splice / 替换 block / 改 `type` / 换掉 `text` 都会使缓存失效并回退到精确扫描。**不需要假设上游不修改数组** —— 早期 `reuseMeasure` 研究候选正因为有这个前提才没有落地。
- `charsAfter` 由裁剪时已算出的位置推导：`headEnd + (length - tailStart) + markerPoints`。`PRUNE_MARKER` 是纯 ASCII，且只要某个 block 存在被删区间，它就夹在保留的头尾之间，因此边界处不会拼出新的代理对。专项测试用 250 组随机多块 Unicode 输入（含孤立代理、ZWJ 序列）把推导值与官方 `measureContent` 逐一比对。
- 缓存在 `try/finally` 中安装与撤销，嵌套 `pruneSession` 会保存并恢复上一层状态，绝不跨调用存活。
- 新增的运行时文件只有 `src/metrics-cache.js`。`cordis.patch.yml`、`src/web-presets.js`、`src/client/index.js` 与 `v0.2.0` tag **逐字节一致**。

## 算法局部基准：`pruneContent`

`benchmark/compare.js`，Node `v24.16.0` / darwin/arm64，只计 `pruneContent`，**0.4.0 已重跑**。预热 12 次、每个变体 60 个交替样本、每轮交替变体顺序，单位毫秒。完整 P50/P95/min/max 在 [`benchmark/last-run.json`](benchmark/last-run.json)。直接调用 `pruneContent` 不会激活会话缓存，因此这组数字描述的是无缓存路径，与 0.3.0 可比。

变体：`official` 为上游实现；`off` 是本插件 `enabled: false`（委托 `super`）；`linear` 只开 `enabled`；`+shortCircuit` 开 `enabled` + `shortCircuit`；`fast` 开 `enabled` + `fastLength`；`fast+short` 三个全开。

**P50（毫秒）**

| 输入 | 码点数 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short | 线性提升 | shortCircuit 相对线性 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0239 | 0.0242 | 0.0073 | 0.0002 | 0.0003 | 0.0002 | 69.5% | +97.1% |
| within-8k-ascii | 8192 | 0.0465 | 0.0468 | 0.0193 | 0.0002 | 0.0002 | 0.0002 | 58.4% | +99.1% |
| within-4k-emoji | 4096 | 0.0379 | 0.0384 | 0.0174 | 0.0002 | 0.0173 | 0.0002 | 54.2% | +99.0% |
| large-ascii | 300000 | 4.5125 | 4.7061 | 0.7299 | 0.7238 | 0.0023 | 0.0013 | 83.8% | +0.8% |
| large-cjk | 300000 | 5.5238 | 7.8990 | 0.7533 | 0.7658 | 0.2073 | 0.2065 | 86.4% | −1.7% |
| large-emoji | 150000 | 3.5401 | 4.1616 | 0.7071 | 0.6834 | 0.6793 | 0.6803 | 80.0% | +3.4% |
| large-mixed | 300000 | 7.3956 | 7.3792 | 1.1808 | 1.1264 | 1.1529 | 1.1223 | 84.0% | +4.6% |
| many-blocks | 297000 | 5.1812 | 5.4078 | 0.9655 | 0.9549 | 0.9732 | 0.9553 | 81.4% | +1.1% |

**P95（毫秒）**

| 输入 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0291 | 0.0666 | 0.0323 | 0.0004 | 0.0005 | 0.0003 |
| within-8k-ascii | 0.0918 | 0.1658 | 0.0245 | 0.0006 | 0.0014 | 0.0002 |
| within-4k-emoji | 0.1390 | 0.0685 | 0.0338 | 0.0010 | 0.0191 | 0.0003 |
| large-ascii | 7.5443 | 9.0410 | 2.1073 | 1.4332 | 0.0042 | 0.0045 |
| large-cjk | 38.0620 | 20.2379 | 3.0689 | 1.7208 | 0.7394 | 1.6199 |
| large-emoji | 7.9790 | 8.6844 | 1.0568 | 1.0279 | 1.3991 | 0.9477 |
| large-mixed | 14.3650 | 14.7255 | 2.8287 | 2.1648 | 2.1780 | 2.9268 |
| many-blocks | 7.2400 | 6.9218 | 1.5754 | 1.7001 | 2.0659 | 2.1303 |

怎么看这些数字：

- `off` 在每个 case 都紧贴 `official`，这正是委托 `super` 的预期开销。
- `shortCircuit` 是**未超阈值快速路径**：三个短输入相对线性降低约 99%，因为完全不扫描文本。超阈值输入只多读几次 `.length`，−1.7%~+4.6% 是噪声；official 基线在 0.3.0 与 0.4.0 两轮之间本身就移动了 20% 以上。
- `fastLength` 强依赖负载：无代理对的长 ASCII / CJK 提升极大，emoji / 混合 / 多块输入没有稳定收益。`within-4k-emoji` 能看出探测路径仍跑完整扫描（0.0173），而 `fast+short` 直接跳过（0.0002）。
- P95 与 max 波动大（官方 `large-cjk` P95 38.1 ms）。每变体 60 个样本属于小样本，且是单机单进程数字；**不是**模型任务、端到端耗时、Token 用量、内存或成功率测量。裁剪只在满足上下文压缩条件时触发，因此这些数字不代表整体任务会加速。

## 算法局部基准：`pruneSession`

`benchmark/session-compare.js`，同一 Node 版本，**0.4.0 新增**。预热 8 次、每个变体 40 个交替样本。每个样本都用固定事件种子新建 `Session`，且**建 Session 放在计时区外**（`pruneSession` 会追加事件、改变会话状态，因此不能复用同一个对象）；这部分开销对每个变体相同，不会被算到裁剪算法头上。计时前会断言每个变体的 `PruneResult` 与官方完全一致。完整数据与逐变体扫描审计在 [`benchmark/session-last-run.json`](benchmark/session-last-run.json)。

变体：`official`；`off`；`linear`（0.2.0 路径）；`+short`（0.3.0 路径）；`+cache`（0.4.0 默认，`sessionMetrics: true`）；`fast+cache`（额外打开默认关闭的实验开关 `fastLength`）。

**P50（毫秒）**

| 输入 | 官方 | Off | 线性 (0.2.0) | +short (0.3.0) | +cache (0.4.0) | fast+cache | 缓存相对 0.3.0 |
|---|---:|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0404 | 0.0417 | 0.0126 | 0.0015 | 0.0015 | 0.0015 | +2.8% |
| mixed-budget | 7.1048 | 7.3431 | 1.1667 | 1.1635 | 0.5921 | 0.0544 | +49.1% |
| single-large-ascii | 6.7831 | 7.0582 | 1.1020 | 1.0990 | 0.5601 | 0.0449 | +49.0% |
| single-large-cjk | 7.0510 | 5.7798 | 1.1643 | 1.1810 | 0.5721 | 0.2570 | +51.6% |
| single-large-emoji | 3.7391 | 3.8749 | 1.0292 | 1.0109 | 0.5244 | 0.5109 | +48.1% |
| single-large-mixed | 7.5499 | 6.3150 | 1.8438 | 1.7520 | 0.8780 | 0.8738 | +49.9% |
| multi-block | 3.9738 | 3.9462 | 1.3874 | 1.3925 | 0.7239 | 0.7251 | +48.0% |
| ten-results | 11.7470 | 12.3609 | 2.8572 | 2.7870 | 1.5008 | 1.2160 | +46.2% |

**P95（毫秒）**

| 输入 | 官方 | Off | 线性 | +short | +cache | fast+cache |
|---|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0616 | 0.0642 | 0.0513 | 0.0039 | 0.0022 | 0.0047 |
| mixed-budget | 11.0852 | 15.1856 | 2.7391 | 2.9465 | 1.9366 | 0.1253 |
| single-large-ascii | 7.8219 | 9.5808 | 1.4754 | 1.5181 | 0.9015 | 0.0640 |
| single-large-cjk | 31.6940 | 31.0057 | 2.3581 | 3.0141 | 1.1737 | 0.4629 |
| single-large-emoji | 10.0967 | 10.4679 | 2.2113 | 1.7476 | 0.7853 | 2.0435 |
| single-large-mixed | 12.9070 | 14.4543 | 4.2287 | 3.8584 | 2.3152 | 2.0308 |
| multi-block | 4.9693 | 4.9577 | 2.0672 | 2.2556 | 1.6398 | 1.1600 |
| ten-results | 16.5988 | 17.6397 | 4.5935 | 3.3322 | 3.0495 | 2.1188 |

**扫描审计**（每个 case 单独跑一次不计时；`exactScans` 统计本插件的整串扫描 `_measureExact`。`official` / `off` 走的是上游 `measureContent` 里的 `Array.from`，这个计数器看不到，所以只列它的 `measureContent` 调用次数。）

| 输入 | 官方 `measureContent` 调用 | 0.3.0 调用 / 精确扫描 | 0.4.0 调用 / 精确扫描 |
|---|---:|---:|---:|
| within-budget | 2 | 0 / 0 | 0 / 0 |
| 单个大结果 | 4 | 3 / 3 | 3 / 0 |
| ten-results | 40 | 30 / 30 | 30 / 0 |

怎么看这些数字：

- 所有超阈值 case 上，`+cache` 的 P50 比 0.3.0 路径**低 46.2–51.6%**，比官方低 81.8–91.9%。P95 改善 8.5–61.1%，但这台机器上 P95 波动较大。
- 审计解释了原因：每个超阈值结果从 3 次额外的整串扫描降到 **0 次**；十个结果从 30 次降到 0 次。唯一剩下的是 `pruneContent` 里那次 `analyze` 扫描原始内容。
- `within-budget` 两版都是 0.0015 ms。那 +2.8% / +43% 是微秒级计时噪声；审计显示两版都没有缓存、没有精确扫描。
- `fast+cache` 在 ASCII / CJK 上更快是 `fastLength` 的功劳，**不是**缓存的功劳。`fastLength` 仍默认关闭、未经真实任务验证；这一列只是实验对照，不是推荐配置。
- 这些只是算法局部数字，**不是**模型任务、端到端耗时、Token 用量、内存或正确率。真实模型前后对照目前还不存在（见「已知限制」）。

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
- `shortCircuit` 与 `sessionMetrics` **没有 Web 按钮**。三份派生预设都继承 provider 默认值（`true` / `true`）；需要关闭可用 `--patch` 覆盖对应行。0.3.0 与 0.4.0 都没有改动任何 preset id，历史会话仍可解析。
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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.4.0
# ...也可以改用精确的 commit SHA 固定

# 或安装发布 tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.4.0.tgz

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

1. bundle patch 默认值 —— `cordis.patch.yml` 插入 `dsh-leet-accelerator` 并设 `enabled: true`。后续 `--patch` 覆盖可按 id 改写该行；注意 patch 会替换整份 `config`，需要把 `thresholdChars`、`headChars`、`tailChars` 以及想保留的非默认开关一起写全。想对比 0.4.0 之前的路径，就在该行写 `sessionMetrics: false`（也可同时写 `shortCircuit: false`）。
2. `npm run control` —— 本地 HTTP 页面，只写插件目录下的 `control/accelerator.patch.json`。启动方式：`dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "任务"`。它保存的是**下次启动读取的设置**，不检测运行实例，不要暴露到网络，也不要多进程同时编辑。

bundle patch 会在同一作用域禁用官方 `tool-result-pruner` 行。不要给同一个 `toolResultPruner` 作用域同时启用两个 provider。Web 会话在 agent preset 内使用隔离的 compaction 组，这正是需要上面那套 preset 开关的原因。

## 测试与复现

```sh
npm ci
npm test                    # 26 项：十六种开关组合、Unicode 边界、会话数值与回放、
                            # 缓存失效与释放、客户端单测
npm run benchmark           # 重写 benchmark/last-run.json（pruneContent，8 x 6）
npm run benchmark:session   # 重写 benchmark/session-last-run.json（pruneSession，8 x 6）
node research/candidate-round2.mjs      # shortCircuit 已落地；reuseMeasure 仍是纯研究候选
node research/host-preset-replay.mjs     # 用真实 Host 读出的 preset 行回放当前实现
```

`test/parity.test.js` 用官方 `0.2.2-rc.1` 实现作对照，覆盖十六种组合：阈值边界、300 组随机多块 Unicode 输入、孤立代理字符、ZWJ 序列、奇数头尾预算、非法配置、`shortCircuit` 的 UTF-16 / 码点边界专项、250 组随机裁剪形状下推导 `charsAfter` 的精确性、缓存释放与预算内会话零开销，以及单结果 / 多结果会话的完整数值收据、事件与回放一致性。`test/metrics-cache.test.js` 覆盖安全命中与所有必须使缓存失效的结构变更。`test/web-presets.test.js` 覆盖预设派生和用假 React 做的客户端 slot / 状态机**单元测试** —— 这些不是浏览器操作，也不是会话作用域证明。

## 市场状态

按[官方插件索引文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)，DSH **不内置任何索引源**。Discover 读取用户手动添加的第三方 `index.json`，索引属于第三方内容。GitHub 加 `dsh-plugin` topic 只是方便人搜索，**不会**自动进入任何 DSH 市场。本项目**尚未被任何具体市场索引收录**。已核验的格式规则见 [VERIFICATION.md](VERIFICATION.md)。

## 已知限制

- **没有真实模型前后对照**。唯一一次真实请求返回 HTTP 402 / `QUOTA: Insufficient Balance`，没有工具执行、没有 pruner 触发；没有用 mock 冒充真实结果。本文档所有耗时结论都只是算法局部测量。
- `fastLength` 在 emoji 密集、混合、多块输入上没有稳定收益，默认关闭，也没有真实任务证据。
- `shortCircuit` 只帮助本来就在预算内的内容；超阈值的长工具结果仍要走完整扫描 —— `sessionMetrics` 处理的是这条路径。
- 只有 `enabled` 与 `fastLength` 有 Web 按钮。`shortCircuit` 与 `sessionMetrics` 是配置层开关，通过 provider 默认值或 `--patch` 覆盖来切换。给它们加 Web 按钮需要新增 preset id，会带上文所述的卸载生命周期风险，因此 Web 层刻意保持逐字节不变。
- `sessionMetrics` 用推导而非重新测量得到 `charsAfter`。随机多块 Unicode 输入与完整会话回放已验证其精确性，但只针对 DSH `0.2.2-rc.1`；上游若改动 `PRUNE_MARKER` 或裁剪形状，需要重新验证。
- preset 方式无法改变已启动的会话。
- 卸载后派生 preset id 可能导致历史会话无法恢复（见上）。
- parity 只针对 DSH `0.2.2-rc.1` 验证过，声明范围内其它版本未测。
- 顶层 bundle patch 不控制 Web 会话的隔离 compaction 组；Web 会话请用派生 preset。
- 0.3.0 与 0.4.0 都没有重跑真实 Chrome 点击 / wire 检查，原因是本沙箱 webserver 启动阶段挂起。Web 层与 `v0.2.0` 逐字节一致；详见 [VERIFICATION.md](VERIFICATION.md)。

## 许可

MIT。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）；上游版权与许可声明保留在 [LICENSE](LICENSE)。
