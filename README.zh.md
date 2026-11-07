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
| `shortCircuit` | `true` | **0.3.0 新增**。上界剪枝：每个码点占 1 或 2 个 UTF-16 单元，所以各文本块 `text.length` 之和是码点总数的上界。若这个上界已在 `thresholdChars` 内，精确码点数也必然不超阈值，`pruneContent` 直接返回 `null`，不扫描任何文本。`measureContent` 仍返回精确值。输出不变，不需要「content 不可变」这类前提；0.4.1 这一轮超阈值输入相对线性的 −2.3%~+2.9% 属于轮次波动，没有一致性退化。 |
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

## 0.4.1：加固，无新增算法收益

这是一次加固版本。**没有新增优化，也没有改动任何开关。** 它落实 0.4.0 独立复核留下的三个非阻断建议，并记录第三轮候选研究——该研究**没有**产出值得落地的改进。

- **Marker 断言（S1）**：`charsAfter` 由码点位置推导时要加上 marker 的码点长度，这只有在 marker 为纯 ASCII 时才精确（纯 ASCII 不可能与相邻的高/低代理拼成新代理对）。`src/index.js` 现在会在模块加载时调用导出的 `assertSafeMarker()`：上游一旦把 `PRUNE_MARKER` 改成非 ASCII，立即 fail fast，而不是静默算错。`test/marker-safety.test.js` 覆盖当前 pinned marker、纯 ASCII 放行、非 ASCII / 非字符串拒绝，以及「边界代理为什么会让推导出错」的构造性示例。
- **历史交叉引用（S2）**：`VERIFICATION.md` 的 0.3.0 章节现在明确把 `18/18` 和 `§3` 标为 0.3.0 当时的测试套件，不会被误读成当前 0.4.x 的数字。
- **交替预热（S3）**：`benchmark/session-compare.js` 在预热阶段也交替变体顺序，而不只是采样阶段。两个基准都在 Node `v24.16.0` 上重跑，下面所有表格都由仓库内的 JSON 重新生成。
- **运行时改动面**：只有 `src/index.js` 变了（断言）。`cordis.patch.yml`、`src/web-presets.js`、`src/client/index.js`、`src/metrics-cache.js` 和所有 preset id 都没变；Web 层仍与 `v0.2.0` 逐字节一致。

### 第三轮候选研究（纯研究）

`research/candidate-round3.mjs` 以官方实现为对照实测两个想法。**两者都保持 research-only，没有进入发布版算法**，因为都没有净收益：

| 候选 | 结果 | 判断 |
|---|---|---|
| 用原生正则统计代理对求码点数（`text.length − 代理对数`），分别用 `match` / `exec` / `split` | 纯 ASCII、CJK、孤立代理、少量代理对文本上比线性扫描快 71–100%，但 **emoji 密集、混合、high/high/low/low 文本上慢 4–8 倍**（每个匹配都要分配槽位，15 万对时尤其严重） | 不落地。真实长工具结果常含混合 Unicode；`fastLength` 已覆盖「无代理对」快路径（默认关闭），`sessionMetrics` 已消除大会话的重复扫描。 |
| 文本块整体保留在头或尾时直接复用原字符串，不做 `slice(0,len) + '' + slice(len)` | 两次运行相对基线 −6.2%~+0.2%，方向不稳，P95 波动更大 | 不落地。V8 已优化整串 `slice` 与空串拼接，没有可测收益，只多出分支。 |

另外测了两个对照，同样未采用：引擎原生 `for...of` 迭代（比线性扫描慢 1.1–3.7 倍）、`codePointAt` 跨步循环（大致持平，混合文本最多 +20%）。研究脚本要求所有 shape 加 40 组随机多块输入与官方输出完全一致，并把每个返回值折入一个会被断言并序列化的 sink，防止纯计数函数被 JIT 优化掉——早先丢弃返回值的草稿曾产生不合理的亚微秒「加速」。两次独立运行做了对照，确认退化稳定、不是噪声。完整 P50/P95/min/max、样本量与跨运行比值在 [`research/candidate-round3-results.json`](research/candidate-round3-results.json)。与本文所有数字一样，这些只是算法局部微基准，**不是**模型任务。

## 算法局部基准：`pruneContent`

`benchmark/compare.js`，Node `v24.16.0` / darwin/arm64，只计 `pruneContent`，**0.4.1 已重跑**。预热 12 次、每个变体 60 个交替样本、每轮交替变体顺序，单位毫秒。完整 P50/P95/min/max 在 [`benchmark/last-run.json`](benchmark/last-run.json)。直接调用 `pruneContent` 不会激活会话缓存，因此这组数字描述的是无缓存路径，与 0.3.0 可比。

变体：`official` 为上游实现；`off` 是本插件 `enabled: false`（委托 `super`）；`linear` 只开 `enabled`；`+shortCircuit` 开 `enabled` + `shortCircuit`；`fast` 开 `enabled` + `fastLength`；`fast+short` 三个全开。

**P50（毫秒）**

| 输入 | 码点数 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short | 线性提升 | shortCircuit 相对线性 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0242 | 0.0242 | 0.0071 | 0.0002 | 0.0003 | 0.0002 | 70.6% | +97.1% |
| within-8k-ascii | 8192 | 0.0464 | 0.0464 | 0.0193 | 0.0002 | 0.0002 | 0.0002 | 58.4% | +99.1% |
| within-4k-emoji | 4096 | 0.0376 | 0.0378 | 0.0174 | 0.0002 | 0.0175 | 0.0002 | 53.7% | +99.0% |
| large-ascii | 300000 | 4.2156 | 4.4170 | 0.7285 | 0.7075 | 0.0022 | 0.0012 | 82.7% | +2.9% |
| large-cjk | 300000 | 5.4200 | 5.2240 | 0.7325 | 0.7317 | 0.2043 | 0.2040 | 86.5% | +0.1% |
| large-emoji | 150000 | 3.5652 | 3.5920 | 0.6853 | 0.7013 | 0.6931 | 0.6839 | 80.8% | −2.3% |
| large-mixed | 300000 | 6.7394 | 6.9120 | 1.1569 | 1.1460 | 1.1558 | 1.1282 | 82.8% | +0.9% |
| many-blocks | 297000 | 4.8636 | 5.0921 | 0.9390 | 0.9457 | 0.9465 | 0.9574 | 80.7% | −0.7% |

**P95（毫秒）**

| 输入 | 官方 | Off | 线性 | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0296 | 0.0327 | 0.0128 | 0.0003 | 0.0006 | 0.0003 |
| within-8k-ascii | 0.1320 | 0.0486 | 0.0211 | 0.0006 | 0.0010 | 0.0002 |
| within-4k-emoji | 0.1022 | 0.1315 | 0.0542 | 0.0007 | 0.0261 | 0.0003 |
| large-ascii | 5.8100 | 5.3129 | 1.0163 | 0.8938 | 0.0045 | 0.0026 |
| large-cjk | 13.8135 | 15.1510 | 1.2994 | 1.6942 | 0.4224 | 0.4645 |
| large-emoji | 8.0165 | 8.1617 | 0.8229 | 1.4326 | 1.7706 | 0.9463 |
| large-mixed | 13.8531 | 15.1845 | 2.5250 | 2.1954 | 2.2562 | 3.2948 |
| many-blocks | 7.1663 | 7.0531 | 1.9126 | 1.9369 | 1.7626 | 1.3061 |

怎么看这些数字：

- `off` 在每个 case 都紧贴 `official`，这正是委托 `super` 的预期开销。
- `shortCircuit` 是**未超阈值快速路径**：三个短输入相对线性降低约 99%，因为完全不扫描文本。超阈值输入只多读几次 `.length`，−1.7%~+4.6% 是噪声；official 基线在 0.3.0 与 0.4.1 两轮之间本身就有明显移动。
- `fastLength` 强依赖负载：无代理对的长 ASCII / CJK 提升极大，emoji / 混合 / 多块输入没有稳定收益。`within-4k-emoji` 能看出探测路径仍跑完整扫描（0.0173），而 `fast+short` 直接跳过（0.0002）。
- P95 与 max 波动大（官方 `large-cjk` P95 38.1 ms）。每变体 60 个样本属于小样本，且是单机单进程数字；**不是**模型任务、端到端耗时、Token 用量、内存或成功率测量。裁剪只在满足上下文压缩条件时触发，因此这些数字不代表整体任务会加速。

## 算法局部基准：`pruneSession`

`benchmark/session-compare.js`，同一 Node 版本，**0.4.0 新增，0.4.1 以交替预热顺序重跑**。预热 8 次、每个变体 40 个交替样本。每个样本都用固定事件种子新建 `Session`，且**建 Session 放在计时区外**（`pruneSession` 会追加事件、改变会话状态，因此不能复用同一个对象）；这部分开销对每个变体相同，不会被算到裁剪算法头上。计时前会断言每个变体的 `PruneResult` 与官方完全一致。完整数据与逐变体扫描审计在 [`benchmark/session-last-run.json`](benchmark/session-last-run.json)。

变体：`official`；`off`；`linear`（0.2.0 路径）；`+short`（0.3.0 路径）；`+cache`（0.4.0 默认，`sessionMetrics: true`）；`fast+cache`（额外打开默认关闭的实验开关 `fastLength`）。

**P50（毫秒）**

| 输入 | 官方 | Off | 线性 (0.2.0) | +short (0.3.0) | +cache (0.4.0) | fast+cache | 缓存相对 0.3.0 |
|---|---:|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0340 | 0.0370 | 0.0125 | 0.0014 | 0.0014 | 0.0015 | +3.0% |
| mixed-budget | 6.9428 | 6.9732 | 1.1683 | 1.1434 | 0.6210 | 0.0510 | +45.7% |
| single-large-ascii | 6.7322 | 6.8681 | 1.1273 | 1.1227 | 0.5465 | 0.0457 | +51.3% |
| single-large-cjk | 5.6288 | 5.1456 | 1.2159 | 1.2240 | 0.6022 | 0.2610 | +50.8% |
| single-large-emoji | 3.1136 | 2.9083 | 1.0335 | 1.0100 | 0.4990 | 0.5078 | +50.6% |
| single-large-mixed | 7.1606 | 6.5771 | 1.8775 | 1.8047 | 0.9924 | 0.9774 | +45.0% |
| multi-block | 4.3842 | 4.2705 | 1.5031 | 1.5268 | 0.8213 | 0.8274 | +46.2% |
| ten-results | 12.3472 | 12.9920 | 3.1543 | 2.9773 | 1.5694 | 1.2793 | +47.3% |

**P95（毫秒）**

| 输入 | 官方 | Off | 线性 | +short | +cache | fast+cache |
|---|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0532 | 0.0868 | 0.0160 | 0.0044 | 0.0026 | 0.0054 |
| mixed-budget | 11.3981 | 10.2990 | 2.1621 | 2.3288 | 0.7936 | 0.1164 |
| single-large-ascii | 10.3577 | 8.3110 | 1.5043 | 1.4942 | 0.9963 | 0.1450 |
| single-large-cjk | 16.9082 | 20.7748 | 2.8177 | 3.2380 | 1.0360 | 1.1804 |
| single-large-emoji | 7.2144 | 8.2275 | 1.2569 | 1.3808 | 0.8438 | 0.9443 |
| single-large-mixed | 18.6648 | 13.2160 | 3.5507 | 3.0799 | 2.0626 | 2.4547 |
| multi-block | 6.4030 | 5.8148 | 2.6686 | 2.3156 | 1.3333 | 1.7136 |
| ten-results | 17.9405 | 20.0979 | 6.2236 | 4.6578 | 4.6536 | 2.5977 |

**扫描审计**（每个 case 单独跑一次不计时；`exactScans` 统计本插件的整串扫描 `_measureExact`。`official` / `off` 走的是上游 `measureContent` 里的 `Array.from`，这个计数器看不到，所以只列它的 `measureContent` 调用次数。）

| 输入 | 官方 `measureContent` 调用 | 0.3.0 调用 / 精确扫描 | 0.4.0 调用 / 精确扫描 |
|---|---:|---:|---:|
| within-budget | 2 | 0 / 0 | 0 / 0 |
| 单个大结果 | 4 | 3 / 3 | 3 / 0 |
| ten-results | 40 | 30 / 30 | 30 / 0 |

怎么看这些数字：

- 所有超阈值 case 上，`+cache` 的 P50 比 0.3.0 路径**低 45.0–51.3%**，比官方低 81.3–91.9%。P95 改善 0.1–68.0%，但这台机器上 P95 波动较大。
- 审计解释了原因：每个超阈值结果从 3 次额外的整串扫描降到 **0 次**；十个结果从 30 次降到 0 次。唯一剩下的是 `pruneContent` 里那次 `analyze` 扫描原始内容。
- `within-budget` 两版都是 0.0014 ms。那 +3.0% 是微秒级计时噪声；审计显示两版都没有缓存、没有精确扫描。
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
- `shortCircuit` 与 `sessionMetrics` **没有 Web 按钮**。三份派生预设都继承 provider 默认值（`true` / `true`）；需要关闭可用 `--patch` 覆盖对应行。0.3.0、0.4.0 与 0.4.1 都没有改动任何 preset id，历史会话仍可解析。
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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.4.1
# ...也可以改用精确的 commit SHA 固定

# 或安装发布 tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.4.1.tgz

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
npm test                    # 30 项：十六种开关组合、Unicode 边界、会话数值与回放、
                            # 缓存失效与释放、marker 断言、客户端单测
npm run benchmark           # 重写 benchmark/last-run.json（pruneContent，8 x 6）
npm run benchmark:session   # 重写 benchmark/session-last-run.json（pruneSession，8 x 6）
node research/candidate-round2.mjs      # shortCircuit 已落地；reuseMeasure 仍是纯研究候选
node research/candidate-round3.mjs      # 正则计数 / 整块复用：两者均为纯研究候选
node research/host-preset-replay.mjs     # 用真实 Host 读出的 preset 行回放当前实现
```

`test/parity.test.js` 用官方 `0.2.2-rc.1` 实现作对照，覆盖十六种组合：阈值边界、300 组随机多块 Unicode 输入、孤立代理字符、ZWJ 序列、奇数头尾预算、非法配置、`shortCircuit` 的 UTF-16 / 码点边界专项、250 组随机裁剪形状下推导 `charsAfter` 的精确性、缓存释放与预算内会话零开销，以及单结果 / 多结果会话的完整数值收据、事件与回放一致性。`test/metrics-cache.test.js` 覆盖安全命中与所有必须使缓存失效的结构变更。`test/marker-safety.test.js`（0.4.1 新增）覆盖 `PRUNE_MARKER` 的 ASCII 断言。`test/web-presets.test.js` 覆盖预设派生和用假 React 做的客户端 slot / 状态机**单元测试** —— 这些不是浏览器操作，也不是会话作用域证明。

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
- 0.3.0、0.4.0 与 0.4.1 都没有重跑真实 Chrome 点击 / wire 检查，原因是本沙箱 webserver 启动阶段挂起。Web 层与 `v0.2.0` 逐字节一致；详见 [VERIFICATION.md](VERIFICATION.md)。

## 许可

MIT。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）；上游版权与许可声明保留在 [LICENSE](LICENSE)。
