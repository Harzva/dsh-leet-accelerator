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
| `shortCircuit` | `true` | **Added in 0.3.0.** Upper-bound pruning: every code point is one or two UTF-16 units, so the sum of `text.length` over text blocks is an upper bound on the code-point total. If that bound is already within `thresholdChars`, the exact count cannot exceed the threshold and `pruneContent` returns `null` without scanning any text. `measureContent` stays exact. Output is unchanged and no immutability assumption is needed. Over-budget inputs show no consistent regression (the −1.7% to +4.6% spread in the 0.4.0 run sits inside run-to-run variance). |
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

## Algorithm-local benchmark: `pruneContent`

`benchmark/compare.js`, Node `v24.16.0` / darwin/arm64, `pruneContent` only, **re-run for 0.4.0**. 12 warmups, 60 alternating samples per variant, alternating variant order each round. Milliseconds. Full P50/P95/min/max data in [`benchmark/last-run.json`](benchmark/last-run.json). Calling `pruneContent` directly does not activate the session cache, so these numbers describe the off-cache path and are comparable with 0.3.0.

Variants: `official` = upstream provider; `off` = this provider with `enabled: false` (delegates to `super`); `linear` = `enabled` only; `+shortCircuit` = `enabled` + `shortCircuit`; `fast` = `enabled` + `fastLength`; `fast+short` = all three on.

**P50 (ms)**

| Case | Code points | Official | Off | Linear | +shortCircuit | fast | fast+short | Linear gain | shortCircuit vs linear |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| short-ascii | 4096 | 0.0239 | 0.0242 | 0.0073 | 0.0002 | 0.0003 | 0.0002 | 69.5% | +97.1% |
| within-8k-ascii | 8192 | 0.0465 | 0.0468 | 0.0193 | 0.0002 | 0.0002 | 0.0002 | 58.4% | +99.1% |
| within-4k-emoji | 4096 | 0.0379 | 0.0384 | 0.0174 | 0.0002 | 0.0173 | 0.0002 | 54.2% | +99.0% |
| large-ascii | 300000 | 4.5125 | 4.7061 | 0.7299 | 0.7238 | 0.0023 | 0.0013 | 83.8% | +0.8% |
| large-cjk | 300000 | 5.5238 | 7.8990 | 0.7533 | 0.7658 | 0.2073 | 0.2065 | 86.4% | −1.7% |
| large-emoji | 150000 | 3.5401 | 4.1616 | 0.7071 | 0.6834 | 0.6793 | 0.6803 | 80.0% | +3.4% |
| large-mixed | 300000 | 7.3956 | 7.3792 | 1.1808 | 1.1264 | 1.1529 | 1.1223 | 84.0% | +4.6% |
| many-blocks | 297000 | 5.1812 | 5.4078 | 0.9655 | 0.9549 | 0.9732 | 0.9553 | 81.4% | +1.1% |

**P95 (ms)**

| Case | Official | Off | Linear | +shortCircuit | fast | fast+short |
|---|---:|---:|---:|---:|---:|---:|
| short-ascii | 0.0291 | 0.0666 | 0.0323 | 0.0004 | 0.0005 | 0.0003 |
| within-8k-ascii | 0.0918 | 0.1658 | 0.0245 | 0.0006 | 0.0014 | 0.0002 |
| within-4k-emoji | 0.1390 | 0.0685 | 0.0338 | 0.0010 | 0.0191 | 0.0003 |
| large-ascii | 7.5443 | 9.0410 | 2.1073 | 1.4332 | 0.0042 | 0.0045 |
| large-cjk | 38.0620 | 20.2379 | 3.0689 | 1.7208 | 0.7394 | 1.6199 |
| large-emoji | 7.9790 | 8.6844 | 1.0568 | 1.0279 | 1.3991 | 0.9477 |
| large-mixed | 14.3650 | 14.7255 | 2.8287 | 2.1648 | 2.1780 | 2.9268 |
| many-blocks | 7.2400 | 6.9218 | 1.5754 | 1.7001 | 2.0659 | 2.1303 |

Reading these numbers:

- `off` tracks `official` closely in every case, which is the expected cost of delegating to `super`.
- `shortCircuit` is a **within-budget fast path**: the three short cases drop ~99% below linear because no text is scanned at all. Over-budget cases pay only a few `.length` reads; the −1.7% to +4.6% spread is noise, and the official baseline itself moved 20%+ between the 0.3.0 and 0.4.0 runs.
- `fastLength` is workload-specific: very large gains on long ASCII/CJK without surrogate pairs, no stable gain on emoji/mixed/multi-block. `within-4k-emoji` shows the probe path still running a full scan (0.0173) while `fast+short` skips it entirely (0.0002).
- P95 and max are noisy (official `large-cjk` P95 38.1 ms). 60 samples per variant is a small sample; these are single-process, single-machine numbers and are **not** a model task, end-to-end latency, token usage, memory, or success-rate measurement. The pruner only runs when compaction conditions are met, so no overall task speedup is implied.

## Algorithm-local benchmark: `pruneSession`

`benchmark/session-compare.js`, same Node, **new in 0.4.0**. 8 warmups, 40 alternating samples per variant. A fresh `Session` is built from a fixed event seed for each sample **outside the timed region**, because `pruneSession` appends events and mutates session state; session construction therefore costs the same for every variant and is never attributed to the pruner. Every variant's `PruneResult` is asserted equal to the official one before timing. Full data and a per-variant scan audit are in [`benchmark/session-last-run.json`](benchmark/session-last-run.json).

Variants: `official`; `off`; `linear` (0.2.0 path); `+short` (0.3.0 path); `+cache` (0.4.0 default, `sessionMetrics: true`); `fast+cache` (adds the default-off experimental `fastLength`).

**P50 (ms)**

| Case | Official | Off | Linear (0.2.0) | +short (0.3.0) | +cache (0.4.0) | fast+cache | Cache vs 0.3.0 |
|---|---:|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0404 | 0.0417 | 0.0126 | 0.0015 | 0.0015 | 0.0015 | +2.8% |
| mixed-budget | 7.1048 | 7.3431 | 1.1667 | 1.1635 | 0.5921 | 0.0544 | +49.1% |
| single-large-ascii | 6.7831 | 7.0582 | 1.1020 | 1.0990 | 0.5601 | 0.0449 | +49.0% |
| single-large-cjk | 7.0510 | 5.7798 | 1.1643 | 1.1810 | 0.5721 | 0.2570 | +51.6% |
| single-large-emoji | 3.7391 | 3.8749 | 1.0292 | 1.0109 | 0.5244 | 0.5109 | +48.1% |
| single-large-mixed | 7.5499 | 6.3150 | 1.8438 | 1.7520 | 0.8780 | 0.8738 | +49.9% |
| multi-block | 3.9738 | 3.9462 | 1.3874 | 1.3925 | 0.7239 | 0.7251 | +48.0% |
| ten-results | 11.7470 | 12.3609 | 2.8572 | 2.7870 | 1.5008 | 1.2160 | +46.2% |

**P95 (ms)**

| Case | Official | Off | Linear | +short | +cache | fast+cache |
|---|---:|---:|---:|---:|---:|---:|
| within-budget | 0.0616 | 0.0642 | 0.0513 | 0.0039 | 0.0022 | 0.0047 |
| mixed-budget | 11.0852 | 15.1856 | 2.7391 | 2.9465 | 1.9366 | 0.1253 |
| single-large-ascii | 7.8219 | 9.5808 | 1.4754 | 1.5181 | 0.9015 | 0.0640 |
| single-large-cjk | 31.6940 | 31.0057 | 2.3581 | 3.0141 | 1.1737 | 0.4629 |
| single-large-emoji | 10.0967 | 10.4679 | 2.2113 | 1.7476 | 0.7853 | 2.0435 |
| single-large-mixed | 12.9070 | 14.4543 | 4.2287 | 3.8584 | 2.3152 | 2.0308 |
| multi-block | 4.9693 | 4.9577 | 2.0672 | 2.2556 | 1.6398 | 1.1600 |
| ten-results | 16.5988 | 17.6397 | 4.5935 | 3.3322 | 3.0495 | 2.1188 |

**Scan audit** (one untimed `pruneSession` per case; `exactScans` counts this plugin's full-text scan, `_measureExact`. The official / `off` variants scan through upstream `measureContent`'s `Array.from`, which this counter does not see.)

| Case | Official `measureContent` calls | 0.3.0 calls / exact scans | 0.4.0 calls / exact scans |
|---|---:|---:|---:|
| within-budget | 2 | 0 / 0 | 0 / 0 |
| one large result | 4 | 3 / 3 | 3 / 0 |
| ten-results | 40 | 30 / 30 | 30 / 0 |

Reading these numbers:

- `+cache` is **46.2–51.6% below the 0.3.0 path** on P50 for every over-budget case, and 81.8–91.9% below official. P95 improvement is 8.5–61.1% but is noisy on this machine.
- The audit explains why: each over-budget result goes from three extra full-text scans to **zero**; ten results go from 30 to zero. The single remaining scan of the original content is the `analyze` pass inside `pruneContent`.
- `within-budget` is unchanged at 0.0015 ms. The +2.8% / +43% "gain" is microsecond-scale timer noise; the audit shows no cache and no exact scan in either version.
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
- `shortCircuit` and `sessionMetrics` have **no Web button**. All three derived presets inherit the provider defaults (`true` / `true`); a `--patch` overlay can turn either off per row. No preset id changed in 0.3.0 or 0.4.0, so existing sessions keep resolving.
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
dsh plugin --profile YOUR_WEB_PROFILE add github:Harzva/dsh-leet-accelerator#v0.4.0
# ...or pin the exact commit SHA instead of the tag

# Or a released tarball
dsh plugin --profile YOUR_WEB_PROFILE add ./dsh-leet-accelerator-0.4.0.tgz

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
npm test                    # 26 tests: sixteen switch combinations, Unicode edges,
                            # session receipts/replay, cache invalidation, client unit tests
npm run benchmark           # rewrites benchmark/last-run.json (pruneContent, 8 x 6)
npm run benchmark:session   # rewrites benchmark/session-last-run.json (pruneSession, 8 x 6)
node research/candidate-round2.mjs      # shortCircuit shipped; reuseMeasure research-only
node research/host-preset-replay.mjs     # replay real Host preset rows against the current provider
```

`test/parity.test.js` compares all sixteen combinations against the official `0.2.2-rc.1` implementation: threshold boundaries, 300 seeded random multi-block Unicode cases, isolated surrogates, ZWJ sequences, odd head/tail budgets, invalid config, the `shortCircuit` UTF-16/code-point boundary, derived-`charsAfter` exactness over 250 randomized pruned shapes, cache disposal / zero-cost within-budget sessions, and full `pruneSession` numeric receipts, events and replay for both single- and multi-result sessions. `test/metrics-cache.test.js` covers safe hits and every mutation that must invalidate an entry. `test/web-presets.test.js` covers preset derivation plus client-side slot/state-machine unit tests with a fake React — those are **unit tests**, not browser or session-scope proof.

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
- 0.3.0 and 0.4.0 did not repeat the real-Chrome button / wire checks, because webserver startup hangs in this sandbox. The Web layer is byte-identical to `v0.2.0`; see [VERIFICATION.md](VERIFICATION.md).

## License

MIT. Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), MIT, Copyright (c) 2026 DeepSeek. The upstream copyright and permission notice are retained in [LICENSE](LICENSE).
