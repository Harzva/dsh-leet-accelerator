# dsh-leet-accelerator

Independent, optional allocation-conscious tool-result pruning for **DeepSeek Harness (DSH)**, with per-optimization switches and Web UI buttons. This project is **not related to OpenBot** and is not an official DeepSeek plugin.

[中文说明](README.zh.md) · [Verification record](VERIFICATION.md)

## What it changes

Upstream [`@deepseek-ai/dsh-compaction-tool-result-pruner`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-tool-result-pruner/src/index.ts) implements `measureContent` and `pruneContent` by expanding each text block with `Array.from(text)` into a code-point array, then `slice().join('')` on the head and tail. For a long tool result that allocates one array of per-code-point strings plus two more slices.

This bundle replaces the `toolResultPruner` provider **only where its patch applies** and keeps the upstream `pruneSession` (shadow-price events, token meter, replay). Four independent config switches (two of them have Web buttons):

| Switch | Default | What it does |
|---|---|---|
| `enabled` | `false` | Linear UTF-16 scan instead of `Array.from`, recording in the same pass whether the block contains a valid surrogate pair. Boundary lookup is O(1) when there is no pair (a UTF-16 offset equals a code-point position), otherwise it scans from the nearer end. No whole-string code-point array is allocated. |
| `fastLength` | `false` | **Experimental candidate.** Probes with a regular expression; when the block has no adjacent surrogate pair, `text.length` is already the code-point count, so the linear scan is skipped. Text *with* pairs pays for the probe and still runs the scan. Depends on `enabled`; with `enabled: false` it does not participate in the algorithm. |
| `shortCircuit` | `true` | **Added in 0.3.0.** Upper-bound pruning: every code point is one or two UTF-16 units, so the sum of `text.length` over text blocks is an upper bound on the code-point total. If that bound is already within `thresholdChars`, the exact count cannot exceed the threshold and `pruneContent` returns `null` without scanning any text. `measureContent` stays exact. Output is unchanged and no immutability assumption is needed. Over-budget inputs show no consistent regression (the −2.3% to +2.9% spread in the 0.4.1 run sits inside run-to-run variance). |
| `sessionMetrics` | `true` | **Added in 0.4.0.** Removes repeated measurement inside one `pruneSession` call with a short-lived, structure-verified `WeakMap`, and derives `charsAfter` from code-point positions already computed instead of rescanning the pruned text. Created lazily on the first result that actually needs pruning, so within-budget sessions pay no cache cost. Depends on `enabled`; `sessionMetrics: false` restores the 0.3.0 path. See below. |

All sixteen combinations of `enabled × fastLength × shortCircuit × sessionMetrics` are tested. In every `enabled: false` state the code delegates to `super.measureContent` / `super.pruneContent`, i.e. the official algorithm runs unchanged and context protection stays on. `shortCircuit` and `sessionMetrics` are config-level switches: the Web buttons still control only `enabled` and `fastLength`, and Web sessions inherit both defaults through the provider, so preset ids and historical sessions are unaffected.

`fastLength` is **not** a validated optimization. On emoji-heavy, mixed or multi-block inputs its P50 versus linear has ranged from −12.3% to +3.9% across runs on this machine — unstable, with official baselines moving substantially between runs. It has never been measured against a real model task. Keep it off unless you have measured your own workload.

## The 0.4.0 session optimization

Upstream `pruneSession` measures each over-budget tool result **four times**: once for the original content and once for the replacement inside `pruneContent`, then again as `charsBefore` and `charsAfter` in `pruneSession` itself. Before 0.4.0, `shortCircuit` made within-budget results cheap but left this over-budget path untouched.

`sessionMetrics` wraps one `pruneSession` call in a cache that lives only on that synchronous call stack:

- The cache is created **lazily**, on the first result whose exact code-point total exceeds the threshold. A session where everything is within budget never allocates a cache and never runs a structural check.
- A hit requires the array length, every block's `type` and every text block's `text` string to match the stored snapshot. Strings are immutable and non-text blocks contribute zero code points, so a matching snapshot proves the total cannot have changed. Pushing, splicing, replacing a block, flipping its type or assigning a different text all invalidate the entry and fall back to an exact scan. **No assumption that upstream never mutates the arrays is needed** — that precondition is exactly why the earlier `reuseMeasure` research candidate was never shipped.
- `charsAfter` is derived as `headEnd + (length - tailStart) + markerPoints` from positions already computed during pruning. `PRUNE_MARKER` is ASCII and sits between the retained head and tail whenever a removed span is non-empty, so no new surrogate pair can form across that boundary. A dedicated test compares the derived value against the official `measureContent` on 250 randomized multi-block Unicode cases, including isolated surrogates and ZWJ sequences.
- The cache is installed and removed in `try/finally`; nested `pruneSession` calls save and restore the previous state. It never survives into another call.
- `src/metrics-cache.js` is the only new runtime file. `cordis.patch.yml`, `src/web-presets.js` and `src/client/index.js` are byte-identical to the `v0.2.0` tag.

## 0.4.1: hardening, no new algorithm gain

This is a hardening release. **No optimization was added and no switch changed.** It closes the three non-blocking review items from 0.4.0 and records a third candidate study that did **not** produce a ship-worthy improvement.

- **Marker guard (S1).** `charsAfter` is derived by adding the marker's code-point length, which is only exact if the marker is pure ASCII (it can then never join a neighbouring high/low surrogate into a new pair). `src/index.js` now runs an exported `assertSafeMarker()` at module load and fails fast if upstream ever changes `PRUNE_MARKER` to a non-ASCII string, instead of silently mis-counting. `test/marker-safety.test.js` covers the pinned marker, pure-ASCII accept, non-ASCII / non-string rejection, and a constructive example of why a boundary surrogate would break the derivation.
- **Historical cross-references (S2).** The 0.3.0 sections of `VERIFICATION.md` now label their `18/18` and `§3` references explicitly as the 0.3.0-era suite, so they are not misread as the current 0.4.x numbers.
- **Alternating warmups (S3).** `benchmark/session-compare.js` now alternates variant order during warmup, not just sampling. Both benchmarks were re-run on Node `v24.16.0` and every README table below was regenerated from the committed JSON.
- **Runtime surface.** Only `src/index.js` changed (the guard); `cordis.patch.yml`, `src/web-presets.js`, `src/client/index.js`, `src/metrics-cache.js` and all preset ids are unchanged. Web layer remains byte-identical to `v0.2.0`.

### Third candidate study (research only)

`research/candidate-round3.mjs` measures two ideas against the official provider. **Both stay research-only and are not in the shipped algorithm**, because neither has a net benefit:

| Candidate | Result | Decision |
|---|---|---|
| Count code points with a native regex (`text.length − surrogatePairs`), via `match`/`exec`/`split` | 71–100% faster than the linear scan on pure ASCII, CJK, lone-surrogate and few-pair text, but **4–8× slower** on emoji-dense, mixed and high/high/low/low text (each match allocates a slot; 150k pairs is pathological) | Not shipped. Long real tool results are commonly mixed Unicode. `fastLength` already covers the no-pair fast path (default off), and `sessionMetrics` already removes repeat scans on large sessions. |
| Reuse the original string for a text block kept entirely in the head or tail, instead of `slice(0,len) + '' + slice(len)` | −6.2% to +0.2% versus baseline across two runs, direction unstable, P95 noisier | Not shipped. V8 already optimizes whole-string `slice` and empty concatenation; no measurable gain, only extra branches. |

Two extra controls were measured and also rejected: engine-native `for...of` iteration (1.1–3.7× slower than the linear scan) and a `codePointAt` stride loop (roughly equal, up to +20% on mixed text). The study enforces output parity with the official implementation on all shapes plus 40 randomized multi-block cases, and folds every return value into an asserted, serialized sink so a pure counter cannot be optimized away by the JIT — an earlier draft that discarded return values produced implausible sub-microsecond "speedups". Two independent runs were compared to confirm the regressions are stable, not noise. Full data with P50/P95/min/max, sample counts and both runs' ratios are in [`research/candidate-round3-results.json`](research/candidate-round3-results.json). Like every other number here, these are algorithm-local microbenchmarks, **not** a model task.

## Algorithm-local benchmark: `pruneContent`

`benchmark/compare.js`, Node `v24.16.0` / darwin/arm64, `pruneContent` only, **re-run for 0.4.1**. 12 warmups, 60 alternating samples per variant, alternating variant order each round. Milliseconds. Full P50/P95/min/max data in [`benchmark/last-run.json`](benchmark/last-run.json). Calling `pruneContent` directly does not activate the session cache, so these numbers describe the off-cache path and are comparable with 0.3.0.

Variants: `official` = upstream provider; `off` = this provider with `enabled: false` (delegates to `super`); `linear` = `enabled` only; `+shortCircuit` = `enabled` + `shortCircuit`; `fast` = `enabled` + `fastLength`; `fast+short` = all three on.

**P50 (ms)**

| Case | Code points | Official | Off | Linear | +shortCircuit | fast | fast+short | Linear gain | shortCircuit vs linear |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0242 | 0.0242 | 0.0071 | 0.0002 | 0.0003 | 0.0002 | 70.6% | +97.1% |
| within-8k-ascii | 8192 | 0.0464 | 0.0464 | 0.0193 | 0.0002 | 0.0002 | 0.0002 | 58.4% | +99.1% |
| within-4k-emoji | 4096 | 0.0376 | 0.0378 | 0.0174 | 0.0002 | 0.0175 | 0.0002 | 53.7% | +99.0% |
| large-ascii | 300000 | 4.2156 | 4.4170 | 0.7285 | 0.7075 | 0.0022 | 0.0012 | 82.7% | +2.9% |
| large-cjk | 300000 | 5.4200 | 5.2240 | 0.7325 | 0.7317 | 0.2043 | 0.2040 | 86.5% | +0.1% |
| large-emoji | 150000 | 3.5652 | 3.5920 | 0.6853 | 0.7013 | 0.6931 | 0.6839 | 80.8% | −2.3% |
| large-mixed | 300000 | 6.7394 | 6.9120 | 1.1569 | 1.1460 | 1.1558 | 1.1282 | 82.8% | +0.9% |
| many-blocks | 297000 | 4.8636 | 5.0921 | 0.9390 | 0.9457 | 0.9465 | 0.9574 | 80.7% | −0.7% |

**P95 (ms)**

| Case | Official | Off | Linear | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0296 | 0.0327 | 0.0128 | 0.0003 | 0.0006 | 0.0003 |
| within-8k-ascii | 0.1320 | 0.0486 | 0.0211 | 0.0006 | 0.0010 | 0.0002 |
| within-4k-emoji | 0.1022 | 0.1315 | 0.0542 | 0.0007 | 0.0261 | 0.0003 |
| large-ascii | 5.8100 | 5.3129 | 1.0163 | 0.8938 | 0.0045 | 0.0026 |
| large-cjk | 13.8135 | 15.1510 | 1.2994 | 1.6942 | 0.4224 | 0.4645 |
| large-emoji | 8.0165 | 8.1617 | 0.8229 | 1.4326 | 1.7706 | 0.9463 |
| large-mixed | 13.8531 | 15.1845 | 2.5250 | 2.1954 | 2.2562 | 3.2948 |
| many-blocks | 7.1663 | 7.0531 | 1.9126 | 1.9369 | 1.7626 | 1.3061 |

Reading these numbers:

- `off` tracks `official` closely in every case, which is the expected cost of delegating to `super`.
- `shortCircuit` is a **within-budget fast path**: the three short cases drop ~99% below linear because no text is scanned at all. Over-budget cases pay only a few `.length` reads; the −1.7% to +4.6% spread is noise, and the official baseline itself moved substantially between the 0.3.0 and 0.4.1 runs.
- `fastLength` is workload-specific: very large gains on long ASCII/CJK without surrogate pairs, no stable gain on emoji/mixed/multi-block. `within-4k-emoji` shows the probe path still running a full scan (0.0173) while `fast+short` skips it entirely (0.0002).
- P95 and max are noisy (official `large-cjk` P95 38.1 ms). 60 samples per variant is a small sample; these are single-process, single-machine numbers and are **not** a model task, end-to-end latency, token usage, memory, or success-rate measurement. The pruner only runs when compaction conditions are met, so no overall task speedup is implied.

## Algorithm-local benchmark: `pruneSession`

`benchmark/session-compare.js`, same Node, **new in 0.4.0; re-run for 0.4.1 with alternating warmups**. 8 warmups, 40 alternating samples per variant. A fresh `Session` is built from a fixed event seed for each sample **outside the timed region**, because `pruneSession` appends events and mutates session state; session construction therefore costs the same for every variant and is never attributed to the pruner. Every variant's `PruneResult` is asserted equal to the official one before timing. Full data and a per-variant scan audit are in [`benchmark/session-last-run.json`](benchmark/session-last-run.json).

Variants: `official`; `off`; `linear` (0.2.0 path); `+short` (0.3.0 path); `+cache` (0.4.0 default, `sessionMetrics: true`); `fast+cache` (adds the default-off experimental `fastLength`).

**P50 (ms)**

| Case | Official | Off | Linear (0.2.0) | +short (0.3.0) | +cache (0.4.0) | fast+cache | Cache vs 0.3.0 |
|---|---:|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0340 | 0.0370 | 0.0125 | 0.0014 | 0.0014 | 0.0015 | +3.0% |
| mixed-budget | 6.9428 | 6.9732 | 1.1683 | 1.1434 | 0.6210 | 0.0510 | +45.7% |
| single-large-ascii | 6.7322 | 6.8681 | 1.1273 | 1.1227 | 0.5465 | 0.0457 | +51.3% |
| single-large-cjk | 5.6288 | 5.1456 | 1.2159 | 1.2240 | 0.6022 | 0.2610 | +50.8% |
| single-large-emoji | 3.1136 | 2.9083 | 1.0335 | 1.0100 | 0.4990 | 0.5078 | +50.6% |
| single-large-mixed | 7.1606 | 6.5771 | 1.8775 | 1.8047 | 0.9924 | 0.9774 | +45.0% |
| multi-block | 4.3842 | 4.2705 | 1.5031 | 1.5268 | 0.8213 | 0.8274 | +46.2% |
| ten-results | 12.3472 | 12.9920 | 3.1543 | 2.9773 | 1.5694 | 1.2793 | +47.3% |

**P95 (ms)**

| Case | Official | Off | Linear | +short | +cache | fast+cache |
|---|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0532 | 0.0868 | 0.0160 | 0.0044 | 0.0026 | 0.0054 |
| mixed-budget | 11.3981 | 10.2990 | 2.1621 | 2.3288 | 0.7936 | 0.1164 |
| single-large-ascii | 10.3577 | 8.3110 | 1.5043 | 1.4942 | 0.9963 | 0.1450 |
| single-large-cjk | 16.9082 | 20.7748 | 2.8177 | 3.2380 | 1.0360 | 1.1804 |
| single-large-emoji | 7.2144 | 8.2275 | 1.2569 | 1.3808 | 0.8438 | 0.9443 |
| single-large-mixed | 18.6648 | 13.2160 | 3.5507 | 3.0799 | 2.0626 | 2.4547 |
| multi-block | 6.4030 | 5.8148 | 2.6686 | 2.3156 | 1.3333 | 1.7136 |
| ten-results | 17.9405 | 20.0979 | 6.2236 | 4.6578 | 4.6536 | 2.5977 |

**Scan audit** (one untimed `pruneSession` per case; `exactScans` counts this plugin's full-text scan, `_measureExact`. The official / `off` variants scan through upstream `measureContent`'s `Array.from`, which this counter does not see.)

| Case | Official `measureContent` calls | 0.3.0 calls / exact scans | 0.4.0 calls / exact scans |
|---|---:|---:|---:|
| within-budget | 2 | 0 / 0 | 0 / 0 |
| one large result | 4 | 3 / 3 | 3 / 0 |
| ten-results | 40 | 30 / 30 | 30 / 0 |

Reading these numbers:

- `+cache` is **45.0–51.3% below the 0.3.0 path** on P50 for every over-budget case, and 81.3–91.9% below official. P95 improvement is 0.1–68.0% but is noisy on this machine.
- The audit explains why: each over-budget result goes from three extra full-text scans to **zero**; ten results go from 30 to zero. The single remaining scan of the original content is the `analyze` pass inside `pruneContent`.
- `within-budget` is unchanged at 0.0014 ms. The +3.0% "gain" is microsecond-scale timer noise; the audit shows no cache and no exact scan in either version.
- `fast+cache` is faster on ASCII/CJK because of `fastLength`, **not** because of the cache. `fastLength` stays default-off and unvalidated; those rows are an experimental control, not a recommendation.
- These are algorithm-local numbers only — **not** a model task, end-to-end latency, token usage, memory or correctness rate. No real-model before/after comparison exists (see Known limits).

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
- `shortCircuit` and `sessionMetrics` have **no Web button**. All three derived presets inherit the provider defaults (`true` / `true`); a `--patch` overlay can turn either off per row. No preset id changed in 0.3.0, 0.4.0 or 0.4.1, so existing sessions keep resolving.
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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.4.1
# ...or pin the exact commit SHA instead of the tag

# Or a released tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.4.1.tgz

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

1. Bundle patch default — `cordis.patch.yml` inserts `dsh-leet-accelerator` with `enabled: true`. A later `--patch` overlay can override the row by id; remember a patch replaces the whole `config`, so restate `thresholdChars`, `headChars`, `tailChars` and any switch you want to keep non-default. To test the pre-0.4.0 path, put `sessionMetrics: false` (and optionally `shortCircuit: false`) in that row.
2. `npm run control` — a local HTTP page that writes `control/accelerator.patch.json` in the plugin directory only. Pass it with `dsh --profile NAME --patch /absolute/path/to/control/accelerator.patch.json "task"`. It stores the setting read at the **next** startup, does not detect a running instance, and must never be exposed to a network or edited by two processes.

The bundle patch disables the official `tool-result-pruner` row in the same scope. Do not enable both providers for one `toolResultPruner` scope. Web sessions use isolated compaction groups inside their agent preset, which is why the preset-based switches above exist.

## Tests and reproduction

```sh
npm ci
npm test                    # 30 tests: sixteen switch combinations, Unicode edges,
                            # session receipts/replay, cache invalidation, marker guard, client unit tests
npm run benchmark           # rewrites benchmark/last-run.json (pruneContent, 8 x 6)
npm run benchmark:session   # rewrites benchmark/session-last-run.json (pruneSession, 8 x 6)
node research/candidate-round2.mjs      # shortCircuit shipped; reuseMeasure research-only
node research/candidate-round3.mjs      # regex counting / whole-block reuse: both research-only
node research/host-preset-replay.mjs     # replay real Host preset rows against the current provider
```

`test/parity.test.js` compares all sixteen combinations against the official `0.2.2-rc.1` implementation: threshold boundaries, 300 seeded random multi-block Unicode cases, isolated surrogates, ZWJ sequences, odd head/tail budgets, invalid config, the `shortCircuit` UTF-16/code-point boundary, derived-`charsAfter` exactness over 250 randomized pruned shapes, cache disposal / zero-cost within-budget sessions, and full `pruneSession` numeric receipts, events and replay for both single- and multi-result sessions. `test/metrics-cache.test.js` covers safe hits and every mutation that must invalidate an entry. `test/marker-safety.test.js` (added in 0.4.1) covers the `PRUNE_MARKER` ASCII guard. `test/web-presets.test.js` covers preset derivation plus client-side slot/state-machine unit tests with a fake React — those are **unit tests**, not browser or session-scope proof.

## Market status

Per the [official plugin index docs](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), DSH **ships no built-in index source**. Discover reads a third-party `index.json` that a user adds manually; indexes are third-party content. A GitHub `dsh-plugin` topic helps humans find the repository but does **not** put a plugin into any DSH market. This project is **not listed in any concrete market index**. See [VERIFICATION.md](VERIFICATION.md) for the format checks performed.

## Known limits

- No real-model before/after comparison exists. The single real request returned HTTP 402 / `QUOTA: Insufficient Balance`; no tool ran and no pruner fired. No mock result is presented as a real one. All timing claims in this README are algorithm-local.
- `fastLength` has no stable benefit on emoji-heavy, mixed or multi-block inputs, is off by default and has no real-task evidence.
- `shortCircuit` only helps content that is already within budget. Over-budget tool results still take the full scan — that is the path `sessionMetrics` addresses.
- Only `enabled` and `fastLength` have Web buttons. `shortCircuit` and `sessionMetrics` are config-level switches set through the provider default or a `--patch` overlay. Adding Web buttons for them would require new preset ids, with the uninstall lifecycle risk described above; the Web layer was deliberately left byte-identical.
- `sessionMetrics` derives `charsAfter` rather than measuring it. This is validated against the official `measureContent` on randomized multi-block Unicode inputs and full session replay, but only against DSH `0.2.2-rc.1`; a future upstream change to `PRUNE_MARKER` or the pruned shape would need re-validation.
- Preset-based switching cannot change a session that has already started.
- Derived preset ids can break historical session recovery after uninstall (see above).
- Parity is verified only against DSH `0.2.2-rc.1`; parity with other releases in the declared range is untested.
- The top-level bundle patch does not control Web sessions' isolated compaction groups; use the derived presets for those.
- 0.3.0, 0.4.0 and 0.4.1 did not repeat the real-Chrome button / wire checks, because webserver startup hangs in this sandbox. The Web layer is byte-identical to `v0.2.0`; see [VERIFICATION.md](VERIFICATION.md).

## License

MIT. Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), MIT, Copyright (c) 2026 DeepSeek. The upstream copyright and permission notice are retained in [LICENSE](LICENSE).
