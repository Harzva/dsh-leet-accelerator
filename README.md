# dsh-leet-accelerator

Independent, optional allocation-conscious tool-result pruning for **DeepSeek Harness (DSH)**, with per-optimization switches and Web UI buttons. This project is **not related to OpenBot** and is not an official DeepSeek plugin.

[中文说明](README.zh.md) · [Verification record](VERIFICATION.md)

## What it changes

Upstream [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) implements `measureContent` and `pruneContent` by expanding each text block with `Array.from(text)` into a code-point array, then `slice().join('')` on the head and tail. For a long tool result that allocates one array of per-code-point strings plus two more slices.

This bundle replaces the `toolResultPruner` provider **only where its patch applies** and keeps the upstream `pruneSession` (shadow-price events, token meter, replay). Two independent switches:

| Switch | Default | What it does |
|---|---|---|
| `enabled` | `false` | Linear UTF-16 scan instead of `Array.from`, recording in the same pass whether the block contains a valid surrogate pair. Boundary lookup is O(1) when there is no pair (a UTF-16 offset equals a code-point position), otherwise it scans from the nearer end. No whole-string code-point array is allocated. |
| `fastLength` | `false` | **Experimental candidate.** Probes with a regular expression; when the block has no adjacent surrogate pair, `text.length` is already the code-point count, so the linear scan is skipped. Text *with* pairs pays for the probe and still runs the scan. Depends on `enabled`; with `enabled: false` it does not participate in the algorithm. |

Four combinations are tested: `enabled × fastLength`. In either `enabled: false` state the code delegates to `super.measureContent` / `super.pruneContent`, i.e. the official algorithm runs unchanged and context protection stays on.

`fastLength` is **not** a validated optimization. It regresses on emoji-heavy and multi-block inputs (see below) and has never been measured against a real model task. Keep it off unless you have measured your own workload.

## Local microbenchmark

`benchmark/compare.js`, Node v24.16.0 on darwin/arm64, `pruneContent` only. 12 warmups, 60 alternating samples per variant, alternating variant order each round. Milliseconds. Full data in [`benchmark/last-run.json`](benchmark/last-run.json).

| Case | Code points | Official P50 / P95 | Linear P50 / P95 | +fastLength P50 / P95 | Linear gain | fastLength vs linear |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0261 / 0.1252 | 0.0075 / 0.0630 | 0.0003 / 0.0045 | 71.2% | 95.6% |
| large-ascii | 300000 | 6.5405 / 16.5320 | 0.8298 / 3.1730 | 0.0031 / 0.0075 | 87.3% | 99.6% |
| large-cjk | 300000 | 6.5791 / 34.3798 | 0.8538 / 3.3254 | 0.2352 / 0.8321 | 87.0% | 72.5% |
| large-emoji | 150000 | 5.6723 / 20.9982 | 0.7117 / 3.0680 | 0.7606 / 2.7589 | 87.5% | **-6.9%** |
| large-mixed | 300000 | 12.8945 / 179.9068 | 1.4041 / 5.7415 | 1.4815 / 13.2795 | 89.1% | **-5.5%** |
| many-blocks | 297000 | 9.1445 / 14.5886 | 1.1627 / 3.8307 | 1.3062 / 4.6193 | 87.3% | **-12.3%** |

P95 is noisy on this machine (one official large-mixed sample reached 179.9 ms, consistent with GC or system load). 60 samples per variant is a small sample; these are single-process, single-machine numbers and are **not** a model task, end-to-end latency, token usage, memory, or success-rate measurement. The pruner only runs when compaction conditions are met, so no overall task speedup is implied.

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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.2.0
# ...or pin the exact commit SHA instead of the tag

# Or a released tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.2.0.tgz

# Inspect the composed layer, then boot
dsh --profile YOUR_WEB_PROFILE --dump-config
dsh --profile YOUR_WEB_PROFILE

# Upgrade / remove
dsh plugin --profile YOUR_WEB_PROFILE update dsh-leet-accelerator
dsh plugin --profile YOUR_WEB_PROFILE remove dsh-leet-accelerator
```

`--dump-config` only proves the layer composition. It does **not** prove that a Web session actually uses the provider; see the verification record.

## Switches outside the Web UI

Two headless ways to control the same two flags, without touching a user profile:

1. Bundle patch default — `cordis.patch.yml` inserts `dsh-leet-accelerator` with `enabled: true`. A later `--patch` overlay can override the row by id; remember a patch replaces the whole `config`, so restate `thresholdChars`, `headChars`, `tailChars`.
2. `npm run control` — a local HTTP page that writes `control/accelerator.patch.json` in the plugin directory only. Pass it with `dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "task"`. It stores the setting read at the **next** startup, does not detect a running instance, and must never be exposed to a network or edited by two processes.

The bundle patch disables the official `tool-result-pruner` row in the same scope. Do not enable both providers for one `toolResultPruner` scope. Web sessions use isolated compaction groups inside their agent preset, which is why the preset-based switches above exist.

## Tests and reproduction

```sh
npm ci
npm test          # 17 tests: four switch combinations, Unicode edges, session replay, client unit tests
npm run benchmark # writes benchmark/last-run.json
```

`test/parity.test.js` compares all four combinations against the official `0.2.2-rc.1` implementation: threshold boundaries, 300 seeded random multi-block Unicode cases, isolated surrogates, ZWJ sequences, odd head/tail budgets, invalid config, and full `pruneSession` event/replay parity. `test/web-presets.test.js` covers preset derivation plus client-side slot/state-machine unit tests with a fake React — those are **unit tests**, not browser or session-scope proof.

## Market status

Per the [official plugin index docs](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), DSH **ships no built-in index source**. Discover reads a third-party `index.json` that a user adds manually; indexes are third-party content. A GitHub `dsh-plugin` topic helps humans find the repository but does **not** put a plugin into any DSH market. This project is **not listed in any concrete market index**. See [VERIFICATION.md](VERIFICATION.md) for the format checks performed.

## Known limits

- No real-model before/after comparison exists. The single real request returned HTTP 402 / `QUOTA: Insufficient Balance`; no tool ran and no pruner fired. No mock result is presented as a real one.
- `fastLength` regresses on emoji-heavy and multi-block inputs and is off by default.
- Preset-based switching cannot change a session that has already started.
- Derived preset ids can break historical session recovery after uninstall (see above).
- Parity is verified only against DSH `0.2.2-rc.1`; parity with other releases in the declared range is untested.
- The top-level bundle patch does not control Web sessions' isolated compaction groups; use the derived presets for those.

## License

MIT. Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), MIT, Copyright (c) 2026 DeepSeek. The upstream copyright and permission notice are retained in [LICENSE](LICENSE).
