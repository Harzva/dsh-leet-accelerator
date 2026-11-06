# dsh-leet-accelerator

Independent, optional allocation-conscious tool-result pruning for **DeepSeek Harness (DSH)**, with per-optimization switches and Web UI buttons. This project is **not related to OpenBot** and is not an official DeepSeek plugin.

[中文说明](README.zh.md) · [Verification record](VERIFICATION.md)

## What it changes

Upstream [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) implements `measureContent` and `pruneContent` by expanding each text block with `Array.from(text)` into a code-point array, then `slice().join('')` on the head and tail. For a long tool result that allocates one array of per-code-point strings plus two more slices.

This bundle replaces the `toolResultPruner` provider **only where its patch applies** and keeps the upstream `pruneSession` (shadow-price events, token meter, replay). Three independent config switches (two of them have Web buttons):

| Switch | Default | What it does |
|---|---|---|
| `enabled` | `false` | Linear UTF-16 scan instead of `Array.from`, recording in the same pass whether the block contains a valid surrogate pair. Boundary lookup is O(1) when there is no pair (a UTF-16 offset equals a code-point position), otherwise it scans from the nearer end. No whole-string code-point array is allocated. |
| `fastLength` | `false` | **Experimental candidate.** Probes with a regular expression; when the block has no adjacent surrogate pair, `text.length` is already the code-point count, so the linear scan is skipped. Text *with* pairs pays for the probe and still runs the scan. Depends on `enabled`; with `enabled: false` it does not participate in the algorithm. |
| `shortCircuit` | `true` | **Added in 0.3.0.** Upper-bound pruning: every code point is one or two UTF-16 units, so the sum of `text.length` over text blocks is an upper bound on the code-point total. If that bound is already within `thresholdChars`, the exact count cannot exceed the threshold and `pruneContent` returns `null` without scanning any text. `measureContent` stays exact. Output is unchanged, no immutability assumption is needed, and over-budget inputs show no measurable regression (the −0.1% to +0.7% spread is within noise). |

All eight combinations of `enabled × fastLength × shortCircuit` are tested. In either `enabled: false` state the code delegates to `super.measureContent` / `super.pruneContent`, i.e. the official algorithm runs unchanged and context protection stays on. `shortCircuit` is a config-level switch: the Web buttons still control only `enabled` and `fastLength`, and Web sessions inherit `shortCircuit: true` through the provider default, so preset ids and historical sessions are unaffected.

`fastLength` is **not** a validated optimization. In the current Node 24 run it gives no measurable benefit on emoji-heavy, mixed or multi-block inputs (−1.2% to +0.3% versus linear, i.e. noise), while a previous run on the same input classes measured −5.5% to −12.3%; the two runs' official baselines differ by roughly 2×, so machine variance is large. It has never been measured against a real model task. Keep it off unless you have measured your own workload.

## Local microbenchmark

`benchmark/compare.js`, Node v24.16.0 on darwin/arm64, `pruneContent` only. 12 warmups, 60 alternating samples per variant, alternating variant order each round. Milliseconds. Full P50/P95/min/max data in [`benchmark/last-run.json`](benchmark/last-run.json).

Variants: `official` = upstream provider; `off` = this provider with `enabled: false` (delegates to `super`); `linear` = `enabled` only; `+shortCircuit` = `enabled` + `shortCircuit`; `fast` = `enabled` + `fastLength`; `fast+short` = all three on.

**P50 (ms)**

| Case | Code points | Official | Off | Linear | +shortCircuit | fast | fast+short | Linear gain | shortCircuit vs linear |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0237 | 0.0238 | 0.0071 | 0.0002 | 0.0003 | 0.0002 | 70.1% | +97.1% |
| within-8k-ascii | 8192 | 0.0456 | 0.0457 | 0.0192 | 0.0002 | 0.0002 | 0.0002 | 57.9% | +99.1% |
| within-4k-emoji | 4096 | 0.0371 | 0.0371 | 0.0172 | 0.0002 | 0.0172 | 0.0002 | 53.6% | +99.0% |
| large-ascii | 300000 | 4.0967 | 4.1055 | 0.7108 | 0.7065 | 0.0024 | 0.0010 | 82.7% | +0.6% |
| large-cjk | 300000 | 4.9089 | 5.1203 | 0.7155 | 0.7103 | 0.3058 | 0.3049 | 85.4% | +0.7% |
| large-emoji | 150000 | 3.4025 | 3.3535 | 0.6725 | 0.6702 | 0.6722 | 0.6697 | 80.2% | +0.3% |
| large-mixed | 300000 | 6.0002 | 5.9958 | 1.1054 | 1.1061 | 1.1023 | 1.1154 | 81.6% | −0.1% |
| many-blocks | 297000 | 4.5665 | 4.5430 | 0.9065 | 0.9019 | 0.9063 | 0.9129 | 80.1% | +0.5% |

**P95 (ms)**

| Case | Official | Off | Linear | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0290 | 0.0477 | 0.0181 | 0.0005 | 0.0007 | 0.0003 |
| within-8k-ascii | 0.0474 | 0.0807 | 0.0197 | 0.0002 | 0.0003 | 0.0002 |
| within-4k-emoji | 0.0913 | 0.0490 | 0.0175 | 0.0002 | 0.0176 | 0.0002 |
| large-ascii | 4.9015 | 4.8854 | 0.8828 | 1.0440 | 0.0039 | 0.0018 |
| large-cjk | 17.0456 | 19.8360 | 1.3634 | 1.4011 | 0.4805 | 0.7938 |
| large-emoji | 7.3663 | 6.9890 | 1.1290 | 0.7804 | 0.9855 | 0.7706 |
| large-mixed | 11.0940 | 10.6041 | 1.3737 | 1.5468 | 1.5622 | 1.7598 |
| many-blocks | 5.0763 | 5.3664 | 1.0323 | 1.0102 | 1.4402 | 1.0603 |

Reading these numbers:

- `off` tracks `official` closely in every case, which is the expected cost of delegating to `super`.
- `shortCircuit` is a **within-budget fast path**: the three short cases drop 97–99% below linear (99.1–99.6% below official) because no text is scanned at all. Over-budget cases pay only a few `.length` reads; the −0.1% to +0.7% spread versus linear is noise.
- `fastLength` is workload-specific: very large gains on long ASCII/CJK without surrogate pairs, no gain on emoji/mixed/multi-block. `within-4k-emoji` shows the probe path still running a full scan (0.0172) while `fast+short` skips it entirely (0.0002).
- P95 and max are noisy (official `large-cjk` P95 17.0 ms, max 26.4 ms; `linear+short` `large-ascii` P95 1.04 ms versus P50 0.71 ms). 60 samples per variant is a small sample; these are single-process, single-machine numbers and are **not** a model task, end-to-end latency, token usage, memory, or success-rate measurement. The pruner only runs when compaction conditions are met, so no overall task speedup is implied.

## Web switches

The client half registers a `conversation.hero.options` slot entry with two buttons: **Linear prune** and **Fast count (experimental)**. Selecting a state switches the session's agent preset through the official `ctx.remote.agentPresets.select(sessionId, presetId)` endpoint — no upstream code is modified or monkey-patched.

Three derived preset snapshots are registered from the current `standard` preset:

| Preset id | `enabled` | `fastLength` |
|---|---|---|
| `leet-comparison-off` | official provider only | n/a |
| `leet-comparison-linear` | `true` | `false` |
| `leet-comparison-fast` | `true` | `true` |

- `standard` and any custom presets are **never overwritten**; registration fails closed and rolls back on a collision.
- A preset is a startup snapshot. Buttons only act on the current **blank** session and on sessions created afterwards. A started session is rejected by the Host (`agent-preset/locked`); the UI disables the buttons and explains why. The plugin never claims an in-flight session switches instantly.
- `fastLength` is disabled in the UI until `enabled` is on, with the dependency stated in the button tooltip.
- `shortCircuit` has **no Web button**. All three derived presets inherit the provider default `true`; a `--patch` overlay can turn it off per row. No preset id changed in 0.3.0, so existing sessions keep resolving.
- Save failures, connection loss and server-side refusals are shown in a `role="status"` live region; a busy state blocks double submission. Buttons are native `<button>`s with `aria-pressed`, `aria-describedby` and a labelled group, so they work from the keyboard.
- On restart or reload the state is read back from the session's `agentPreset` projection, not from a client-only flag.

**Lifecycle limitation (important):** a session records the preset id it used. After this bundle is uninstalled, sessions that used `leet-comparison-linear` or `leet-comparison-fast` may no longer be able to recover that composition, because those snapshots name this package as their pruner provider. The `leet-comparison-off` snapshot uses only official providers and stays resolvable. Switch affected sessions back to `standard` **before** uninstalling. The preset descriptions state this too.

See [VERIFICATION.md](VERIFICATION.md) for exactly which Web checks were actually performed, on which DSH version, and which remain open.

## Compatibility and installation

- DSH `0.2.2-rc.1` is the version actually used for parity tests. `engines.dsh` is `>=0.2.2-rc.1 <0.3.0`; other versions in that range were **not** verified.
- Node.js >= 24.9.0. Upstream reference commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- Peer dependencies must resolve to the running installation's copies: `@deepseek-ai/dsh-compaction-tool-result-pruner` `0.2.2-rc.1`, `@deepseek-ai/schemastery` `~3.19.0`.
- Pure JavaScript, no build step: the `./client` export points at a checked-in browser factory script (a lazy-CJS `window.__ModuleLoader__.load` registration), and the root export is the Node plugin. Nothing is generated at install time, so a Git install needs no `prepare` script and no `pnpm allowBuilds` allowlist. Pin a commit anyway.

```sh
# Git source, pinned to a released tag (no build permission needed)
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.3.0
# ...or pin the exact commit SHA instead of the tag

# Or a released tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.3.0.tgz

# Inspect the composed layer, then boot
dsh --profile YOUR_WEB_PROFILE --dump-config
dsh --profile YOUR_WEB_PROFILE

# Upgrade / remove
dsh plugin --profile YOUR_WEB_PROFILE update dsh-leet-accelerator
dsh plugin --profile YOUR_WEB_PROFILE remove dsh-leet-accelerator
```

`--dump-config` only proves the layer composition. It does **not** prove that a Web session actually uses the provider; see the verification record.

## Switches outside the Web UI

Two headless ways to control the same config flags, without touching a user profile:

1. Bundle patch default — `cordis.patch.yml` inserts `dsh-leet-accelerator` with `enabled: true`. A later `--patch` overlay can override the row by id; remember a patch replaces the whole `config`, so restate `thresholdChars`, `headChars`, `tailChars` and any switch you want to keep non-default.
2. `npm run control` — a local HTTP page that writes `control/accelerator.patch.json` in the plugin directory only. Pass it with `dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "task"`. It stores the setting read at the **next** startup, does not detect a running instance, and must never be exposed to a network or edited by two processes.

The bundle patch disables the official `tool-result-pruner` row in the same scope. Do not enable both providers for one `toolResultPruner` scope. Web sessions use isolated compaction groups inside their agent preset, which is why the preset-based switches above exist.

## Tests and reproduction

```sh
npm ci
npm test          # 18 tests: eight switch combinations, shortCircuit boundary, Unicode edges, session replay, client unit tests
npm run benchmark # writes benchmark/last-run.json
node research/candidate-round2.mjs      # shortCircuit now shipped; reuseMeasure research-only
node research/host-preset-replay.mjs     # replay real Host preset rows against the current provider
```

`test/parity.test.js` compares all eight combinations against the official `0.2.2-rc.1` implementation: threshold boundaries, 300 seeded random multi-block Unicode cases, isolated surrogates, ZWJ sequences, odd head/tail budgets, invalid config, a dedicated `shortCircuit` UTF-16/code-point boundary test (49/50/51 units, emoji pairs, lone surrogates), and full `pruneSession` event/replay parity. `test/web-presets.test.js` covers preset derivation plus client-side slot/state-machine unit tests with a fake React — those are **unit tests**, not browser or session-scope proof.

## Market status

Per the [official plugin index docs](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), DSH **ships no built-in index source**. Discover reads a third-party `index.json` that a user adds manually; indexes are third-party content. A GitHub `dsh-plugin` topic helps humans find the repository but does **not** put a plugin into any DSH market. This project is **not listed in any concrete market index**. See [VERIFICATION.md](VERIFICATION.md) for the format checks performed.

## Known limits

- No real-model before/after comparison exists. The single real request returned HTTP 402 / `QUOTA: Insufficient Balance`; no tool ran and no pruner fired. No mock result is presented as a real one.
- `fastLength` has no measurable benefit on emoji-heavy, mixed or multi-block inputs in the latest run and was worse in an earlier run; it is off by default and has no real-task evidence.
- `shortCircuit` only helps content that is already within budget. Over-budget tool results still take the full scan.
- Preset-based switching cannot change a session that has already started.
- Derived preset ids can break historical session recovery after uninstall (see above).
- Parity is verified only against DSH `0.2.2-rc.1`; parity with other releases in the declared range is untested.
- The top-level bundle patch does not control Web sessions' isolated compaction groups; use the derived presets for those.

## License

MIT. Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), MIT, Copyright (c) 2026 DeepSeek. The upstream copyright and permission notice are retained in [LICENSE](LICENSE).
