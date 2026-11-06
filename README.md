# dsh-leet-accelerator

面向 DeepSeek Harness 的独立实验插件。它保留上游工具结果裁剪的输出和会话记录方式，通过一次线性扫描和双端定位，减少处理长文本时的临时数组分配。本项目与 OpenBot 无关。

## 改了哪里，使用了什么算法

本插件针对官方 [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) 的 `measureContent` 和 `pruneContent`。上游每次通过 `Array.from(text)` 按 Unicode 码点展开文本，再选取要保留的头尾。

- **线性扫描**：按 UTF-16 代理对规则统计 Unicode 码点，避免为整个字符串创建码点数组。
- **双指针／双端定位**：从更接近目标的一端定位要保留的头部或尾部边界，再直接切片。保留跨块、孤立代理字符和非文本块的原有语义。

这是一项优化，使用了两种基础算法思路；并非实现了多道 LeetCode 题。插件继承官方 `pruneSession`，保留 token 计量、事件和回放机制。关闭优化时仍会执行官方裁剪，不会关闭 Harness 的上下文保护。

## 测量结果

下表是本机 Apple Silicon、Node 24.16.0 的合成微基准，只计 `pruneContent`，不是完整任务耗时。每个场景预热 12 次，交替运行关闭和开启各 60 次，表中为中位数（P50）；P95 和原始数据见 [`benchmark/last-run.json`](benchmark/last-run.json)。2026-11-06 测得：

| 输入 | 关闭（官方算法） | 开启 | 中位耗时下降 |
| --- | ---: | ---: | ---: |
| 4,096 码点 ASCII，未超过裁剪阈值 | 0.026 ms | 0.0085 ms | 约 67% |
| 300,000 码点 ASCII | 4.147 ms | 0.519 ms | 约 87.5% |
| 300,000 码点混合 Unicode | 6.210 ms | 1.161 ms | 约 81.3% |
| 297,000 码点、多内容块 | 4.740 ms | 0.923 ms | 约 80.5% |

计时会随设备、输入和系统负载变化；没有测量内存峰值、实际模型任务时间、Token 消耗或真实任务成功率。上游只在上下文压缩条件满足时调用裁剪服务，因此这些数字不表示所有任务都会加速。

## 兼容范围与安装

本实验锁定 DeepSeek Harness `0.2.2-rc.1`、Node.js 24.9 或更新版本；源码参考 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。已在隔离的 **base/headless 同作用域组合**中实际加载验证。Web 会话的 standard、cordis、ptc 等 preset 使用隔离的裁剪服务，本插件的顶层 patch 不控制这些会话，暂不支持。

在可写位置保存本插件目录，先创建或选定兼容的 headless profile，再运行：

```sh
dsh plugin --profile YOUR_HEADLESS_PROFILE add /absolute/path/to/dsh-leet-accelerator
```

安装后，bundle 默认启用优化实现，并禁用同作用域的官方 provider；不要另外在该作用域同时启用两个 `toolResultPruner`。用户的 profile、home 或命令行后续 patch 可能覆盖此设置。用 `dsh --profile YOUR_HEADLESS_PROFILE --dump-config` 检查实际组合。

## 开启与关闭按钮

在**可写的插件目录**中运行：

```sh
npm run control
```

打开终端打印的 `http://127.0.0.1:.../`，选择“开启算法”或“关闭算法”。控制台只写本插件目录下的 `control/accelerator.patch.json`，首次创建该文件时默认为关闭；它不更改用户 profile。停止控制台使用 Ctrl-C。

在启动目标 profile 时加入显示的文件：

```sh
dsh --profile YOUR_HEADLESS_PROFILE --patch /absolute/path/to/dsh-leet-accelerator/control/accelerator.patch.json "你的任务"
```

按钮保存的是**下次启动读取的设置**，不会更改已运行会话。界面显示保存值，而不是对运行实例状态的检测。该覆盖文件固定使用阈值 8192、头部 4096、尾部 1024 个 Unicode 码点；如果需要自定义预算，请自行编辑独立 patch 并保留完整配置。请勿将控制台暴露到网络或以多个进程同时编辑该文件。

## 测试与复现

在插件目录内安装开发依赖后：

```sh
npm install
npm test
npm run benchmark
```

测试使用官方 `0.2.2-rc.1` 实现作为对照，覆盖阈值、300 组随机多块 Unicode 输入、孤立代理字符、无效配置，以及真实 Session 的裁剪事件、重复处理和回放。实验没有使用真实模型或用户数据。

## 来源与许可

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 许可实现；改写部分保留其版权和许可，见 [LICENSE](LICENSE)。这是独立实验项目，并非 DeepSeek 官方插件。
