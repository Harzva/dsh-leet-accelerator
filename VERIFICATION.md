# Verification record

This file records what was **actually** checked, on which version, and what remains open. It deliberately separates local unit tests, a real Web Host, real browser interaction, and session-scope composition. Nothing here is a real-model result.

## 1. Environment and isolation

- Verified a real APFS volume with the required UUID and well over the required 10 GiB of free space. Volume identifiers are intentionally not recorded in this public document.
- All builds, dependency caches, temp files and test profiles stayed inside this task's own directory on that volume. The user's real `DSH_HOME` was never written, and the global `TMPDIR` was never changed (only per-command overrides).
- Node `v24.16.0`, darwin/arm64. DSH `0.2.2-rc.1`, upstream source at commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- Separate isolated `DSH_HOME`s for the Web Host and for the clean-install checks. None is part of the repository.
- The plugin directory was not a Git repository; existing work was preserved as an initial commit before any edits. No upstream DeepSeek Harness repository is used as the plugin's remote.
- No credentials were read, printed, copied or committed. Local tokens, evidence directory, logs and private paths are not in the repository.

## 2. Official-specification checks

Read both the checked-out docs (at the pinned commit) and the current `master` copies on GitHub; they agree.

- `docs/user/develop/basic/publish.md`: `dsh.bundle.patch` is required for a layer to activate; `engines.dsh` should be a SemVer range; dsh packages shared with the Host belong in both `peerDependencies` and `devDependencies`; layer order is bundle → profile → home → `--patch`, and a patch replaces a row's whole `config`; Git installs fetch sources, so TypeScript packages need a `prepare` script plus the user's `pnpm allowBuilds` allowlist, while npm/tarball installs of prebuilt code need neither.
- `docs/subsystems/client-modules.md` + `packages/client/modules/src/client/manifest.ts`: `dsh.client` requires `platform: 'web'`, optional `inject`/`external` string arrays and optional `immediately`; the Host resolves the package's `./client` export and serves it as a browser bundle.
- `docs/user/guide/plugin-market.md`: **DSH ships no index source.** Discover reads a third-party `index.json` the user adds. Format `1`; `title` is required and must contain `en` when localized; each plugin needs `name` and `versions[]`; each version needs exact SemVer `version`, `publishTimestamp` (Unix seconds) and `source` (`{"type":"npm"}` or `{"type":"git","url":https,"commit":40-hex-sha,"path"?}`); optional `engines.dsh`; icons are inline `data:` URLs (SVG/PNG/JPEG/WebP, ≤32 KiB) or URLs, with cross-origin absolute icons requiring `https:`. For Git sources the reference generator lists versions at `vX.Y.Z`, `X.Y.Z`, `<name>@X.Y.Z` tags plus the default branch; for npm it lists non-deprecated, non-private versions declaring `dsh.bundle`.
- **Market status: not listed in any concrete plugin index.** A GitHub `dsh-plugin` topic only aids discovery; it does not register a plugin with any DSH market. No third-party index rules are presented as official rules.
- A concrete third-party index under the same GitHub account, `Harzva/dsh-plugin-registry` (`registry/index.json`, `schemaVersion: 1`, one per-plugin JSON entry with `source.commit`/`source.tag`, `release.tarball`/`sha256` and `status.state`), was inspected read-only. It lists one plugin and does **not** include `dsh-leet-accelerator` (code search returned 0 hits). That repository's schema is its own convention, not an official DSH rule; no submission was made, because it is a separate repository with its own review process.

`package.json` was checked against these: name/version, `main`, `exports` (`.`, `./web-presets`, `./client`, `./cordis.patch.yml`, `./icon.svg`, `./package.json`), `files`, `engines.dsh = ">=0.2.2-rc.1 <0.3.0"`, `engines.node`, `dsh.bundle.patch = "./cordis.patch.yml"`, `dsh.client.platform/inject`, peer + dev dependencies, `icon.svg`, and the actual packed file list. `LICENSE` retains the upstream DeepSeek MIT notice and copyright.

All six export specifiers resolve correctly from an installed profile, including `dsh-leet-accelerator/client`.

## 3. Local tests and benchmarks

`npm test` → **17 passing, 0 failing**.

- `test/parity.test.js`: all four `enabled × fastLength` combinations compared with the official `0.2.2-rc.1` implementation; threshold boundaries; 300 seeded random multi-block Unicode cases; isolated high/low surrogates in separate blocks; surrogate pairs at the front/end of a block; ZWJ sequences, combining marks, BOM, NUL; odd head/tail budgets; invalid configs; and complete `pruneSession` parity (shadow-price event, replacement metadata, source seqs, repeated prune, replay, derived messages). A dedicated test calls `ToolResultPruner.prototype.measureContent/pruneContent` directly on an `enabled:false` instance to show the off branch delegates to the official algorithm.
- `test/web-presets.test.js`: preset derivation, fail-closed behavior, rollback on collision, lifecycle wording, and **client-side unit tests** with a fake React and fake slot registry (state machine, envelope handling, dependency, disabled states, keyboard/ARIA attributes, failure text). These are unit tests, not browser or session-scope proof.
- `test/control.test.js`: local overlay writer.
- `npm run benchmark` → `benchmark/last-run.json`: six input classes × four variants, 12 warmups, 60 alternating samples each, P50/P95/min/max. Results and the noisy-P95 caveat are in `README.md` / `README.zh.md`.

## 4. Real Web Host (isolated, DSH 0.2.2-rc.1)

Started with an isolated `DSH_HOME` and the `dsh-web-app` profile, on a loopback port. One non-required `schedule` entry failed to activate because the host environment's file-broker shim returned `EPIPE`; the Web Host itself started and served the UI. This is an environment artifact, not a plugin failure.

Verified over HTTP:

- The page's `window.__DSH_BOOT__` graph contains a real `dsh-leet-accelerator` client entry with its `client.js` combo URL, revision, `inject` list and batch membership. The `./client` export and `dsh.client` declaration are therefore actually consumed by the Host, not just present in `package.json`.
- `GET /plugins/??dsh-leet-accelerator/client.js&rev=…` returns 200 and the real browser bundle bytes.
- `POST /api/agentPresets/list` shows `standard`, `ptc`, `minimal`, `cordis` **unchanged**, plus the three derived presets with their descriptions.
- `POST /api/agentPresets/read` returns each derived preset's full composition. In the `compaction` group (`isolate: { compaction: true, toolResultPruner: true }`), the `tool-result-pruner` row is:
  - `leet-comparison-off` → `@deepseek-ai/dsh-compaction-tool-result-pruner` (official),
  - `leet-comparison-linear` → `dsh-leet-accelerator`, `enabled: true`, `fastLength: false`,
  - `leet-comparison-fast` → `dsh-leet-accelerator`, `enabled: true`, `fastLength: true`.

  This is the **session's isolated preset scope**, not the top-level bundle layer and not `--dump-config`.
- Instantiating those three Host-read compositions locally gives `ToolResultPruner` / `LeetAccelerator(enabled=true, fastLength=false)` / `LeetAccelerator(enabled=true, fastLength=true)` respectively; all three `pruneContent` outputs are byte-identical to the official implementation on a long mixed-Unicode tool result. The off state therefore runs the official algorithm.

**Boundary of this check:** the `toolResultPruner` instance was not read from inside a running session process. A real model session could not be started (see §7), so the evidence chain is: real `select` calls → Host-registered preset compositions → instantiated provider classes and outputs. That is stronger than a bundle-config check but is not a runtime probe inside a live agent.

## 5. Real browser interaction (Chrome, real Web Host)

Driven with a real Chrome browser against the isolated Host. No mocks, no simulated React.

- Buttons render as `线性裁剪：关` / `快速计数（实验）：关`, with `aria-pressed`, `aria-describedby`, a labelled group and a `role="status"` live region. Screenshot checked: both buttons are legible and unobstructed; the status text is small but readable. Zero page errors and zero console errors.
- On `standard` both are disabled with the reason "先在预设菜单选择 Leet 比较预设，再调整算法".
- The real preset menu lists all three derived presets. Selecting `Leet 优化关闭` unlocks the linear button, keeps fast-count disabled (dependency), and shows "当前使用官方裁剪算法".
- Clicking linear → `线性裁剪：开`, `aria-pressed=true`, fast-count unlocks. Clicking fast → both on, with the experimental/emoji-regression warning. Clicking linear again → both off, fast-count disabled again.
- Keyboard: focusing the linear button and pressing `Enter` performs the same toggle.
- Reload/restart: state is read back from the session's `agentPreset` projection, not from a client-only flag.
- Connection failure: with `POST /api/agentPresets/select` aborted, the status region reports the fetch failure and the button returns to an enabled, non-busy state; no silent "success".
- Real wire captured: `select` sends `{ agentId, agentPreset }` and returns `{ ok: true, value: "<preset id>" }`, matching the client code.
- A first pass exposed a real defect: the client's `inject` array lacked `'remote'`, so the real ClientContext threw `cannot get property "remote" without inject` and no selection happened. Unit tests with a fake context did not catch it; the real browser did. Fixed, covered by an explicit test assertion, and the full flow re-run successfully.

**Not verified in a live session:** switching on an already-started session. Creating one requires a model request, which is blocked (§7). The restriction is enforced upstream (`agent-preset/locked`, "This session has already started") and on the client (`session.blank`), and the disabled/started state is covered by client unit tests. No claim of instant switching on running sessions is made.

## 6. Clean-install check (final tarball)

- `npm pack` produced `dsh-leet-accelerator-0.2.0.tgz`. Its exact file count, size and SHA-1 are recorded in the GitHub release notes rather than here: this document is itself inside the archive, so a checksum written into it would be stale the moment the archive is rebuilt. Contents contain no `node_modules`, credentials, private home, logs, control state files, chat data or evidence directory. `VERIFICATION.md` is included in `files` and in the tarball.
- Installed that exact tarball with `dsh plugin --profile <clean profile> add <tarball>` into a **fresh, empty** `DSH_HOME`. It initialized the profile, added the dependency, and appended the bundle to `dsh.profile.bundles`. No `prepare` script and no `allowBuilds` allowlist were needed, confirming the pure-JS no-build path. The profile's `pnpm-workspace.yaml` / `.npmrc` pinned `storeDir` to this task's own cache directory **before** installation, and `.modules.yaml` confirms that store was used.
- All six export specifiers resolve from the installed profile (`.`, `./web-presets`, `./client`, `./cordis.patch.yml`, `./icon.svg`, `./package.json`).
- `--dump-config` shows the `dsh-leet-accelerator` layer with `enabled: true`, the official `tool-result-pruner` row disabled in that scope, and the `leet-web-presets` row.
- A `--patch` runtime probe inserted a service that resolves `ctx.toolResultPruner` inside the clean profile. Output: `LEET_PROBE service=LeetAccelerator enabled=true output=5159`. So the installed package really loads, the injected pruning service is our implementation, `enabled` is true, and `pruneContent` returned a 5159-character result. `leet-web-presets` stays pending for `agentPresets` in a base-only profile, as expected; Web presets only activate in a web-app profile.
- `dsh plugin --profile <clean profile> remove dsh-leet-accelerator` succeeded. Afterwards the dependency is gone from `package.json`, the bundle is gone from `dsh.profile.bundles`, `node_modules/dsh-leet-accelerator` is removed, `dsh-leet-accelerator` no longer appears in `--dump-config`, and the official `@deepseek-ai/dsh-compaction-tool-result-pruner` row is **enabled again** (no `disabled: true`). Uninstall restores the official algorithm.
- The installed `src/*.js`, `cordis.patch.yml` and `icon.svg` were compared byte-for-byte with the repository sources used by the Web Host in §4–§5; they are identical.
- An earlier uninstall attempt failed because the test profile's `pnpm-workspace.yaml` `storeDir` was changed **after** installation; `.modules.yaml` still recorded the old store, so `pnpm remove` refused with `If you want to use the new store location, reinstall your dependencies with "pnpm install"`. This was a test-harness configuration error, not a plugin defect. It was fixed by creating a new profile with `storeDir` set before installation and re-running the whole add → dump-config → runtime probe → remove cycle. Do not change `storeDir` between install and remove.
- Two more install sources were checked the same way: the GitHub tag `github:Harzva/dsh-leet-accelerator#v0.2.0` and the tarball downloaded from the public Release URL. Both installed with no build permission, produced byte-identical sources, passed the same runtime probe, and uninstalled cleanly. The downloaded asset's SHA-1 matches the locally verified artifact.
- A Web Host backed by a **tarball-installed** profile was later started successfully in the same isolated (already initialized) `DSH_HOME`, as a fresh profile with the `@deepseek-ai/dsh-web-app` bundle. Real Chrome re-ran the full flow there: `standard` disables both buttons; `leet-comparison-off` unlocks linear only; linear on unlocks fast; fast on shows the experimental warning; turning linear off disables fast again; keyboard toggle, reload/restart state read-back and five real `agentPresets/select` calls all behaved as expected, with zero page/console errors. Host `agentPresets/read` again showed the official provider for `leet-comparison-off` and `dsh-leet-accelerator` with `enabled:true` / `fastLength:false` or `true` for the other two. That profile then uninstalled cleanly.
- A brand-new `DSH_HOME` combined with a first-time web-app profile still hangs in this sandbox (the process creates its anonymous id, credentials and storages but never binds the loopback port). Starting web-app for the first time therefore needs an already initialized isolated home here; this is an environment artifact, not a plugin failure. Earlier in the workflow, §4–§5 used a linked-checkout Host whose sources are byte-identical to the packed tarball.

## 7. Real model task — blocked, no comparison exists

The single real request previously attempted returned **HTTP 402 / `QUOTA: Insufficient Balance`**, exit code 1. No tool executed, no pruner fired, and there is no before/after comparison. No further request was sent, to avoid consuming quota, and no mock is presented as a real result.

What is needed: restore balance on the **DeepSeek API model entry used by this profile** (the `llm-deepseek` provider reads the key from `DEEPSEEK_API_KEY`). Once usable, the pending work is: for each actually-enabled optimization, alternating on/off runs with a fixed task, input, model, permissions and environment; record pruner invocation evidence, correctness, model/tool call counts, token usage (unknown if the provider omits it), algorithm-local time and end-to-end time; report sample size, median, P95 and variance; and report honestly if overall time does not improve or an input class regresses.

Consequences: `fastLength` remains an **experimental, default-off candidate** with no real-task evidence, and neither optimization has an end-to-end task speedup claim.

## 8. Open items and known risks

- No real-model before/after comparison (§7).
- No runtime probe of `toolResultPruner` inside a live session; no real already-started session was exercised (§4, §5).
- Clean-profile runtime-load probe and `dsh plugin remove` uninstall are now complete and passed (§6); the earlier pnpm `storeDir` mismatch is a resolved test-harness issue, not a plugin defect.
- Starting web-app for the first time in a brand-new `DSH_HOME` hangs in this sandbox; using an already initialized isolated home works (§6). Web buttons/restart/session scope have now also been repeated on a tarball-installed Host.
- `fastLength` regresses on emoji-heavy and multi-block local inputs (-5.5% to -12.3% P50 vs linear).
- Derived preset ids can break historical session recovery after uninstall; documented in both READMEs and in the preset descriptions. Switch affected sessions back to `standard` before uninstalling.
- Only DSH `0.2.2-rc.1` was verified; other versions inside the declared `>=0.2.2-rc.1 <0.3.0` range are untested.
- Local P95 is noisy (one official large-mixed sample reached 179.9 ms); 60 samples per variant is a small sample.
- The top-level bundle patch does not control Web sessions' isolated compaction groups.
- The Host's `schedule` entry failed to activate in this environment due to the file-broker shim; unrelated to the plugin but worth noting when reproducing.
- Not listed in any concrete DSH plugin market index.

## 9. Round-2 candidate study (research only, not shipped in 0.2.0)

After the 0.2.0 release, two further algorithm candidates were measured with `research/candidate-round2.mjs` (results in `research/candidate-round2-results.json`). Every variant was checked byte-for-byte against the official `pruneContent`, and `pruneSession` results plus derived messages were checked against the shipping implementation. Node v24.16.0 / darwin/arm64, 10 warmups, 60 alternating samples, P50 milliseconds.

| Case | Shipping | +shortCircuit | +reuseMeasure | +both |
|---|---:|---:|---:|---:|
| `pruneContent` within 1k | 0.0026 | 0.0003 (**90.3%**) | 0.0026 | 0.0003 |
| `pruneContent` within 8k ASCII | 0.0137 | 0.0002 (**98.5%**) | 0.0136 | 0.0002 |
| `pruneContent` within 8k emoji | 0.0118 | 0.0002 (**98.6%**) | 0.0118 | 0.0002 |
| `pruneContent` over 300k | 0.7109 | 0.7129 (-0.3%) | 0.7126 | 0.7065 |
| `pruneSession` one short result | 0.0678 | 0.0666 | 0.0700 | 0.0708 |
| `pruneSession` one large result | 1.2620 | 1.2305 | 0.7070 (**44.0%**) | 0.7137 |
| `pruneSession` 8 mixed results | 1.6417 | 1.5862 | 0.9788 (**40.4%**) | 0.9934 |

- **shortCircuit (upper-bound pruning):** the number of Unicode code points is never greater than the UTF-16 length, so if the sum of `text.length` over text blocks is at most `thresholdChars`, the content is definitely within budget and `pruneContent` can return `null` without scanning any text. Semantics are identical with no immutability assumption, and large over-budget inputs show no measurable regression (only a few extra `.length` reads). This is the more attractive candidate because most tool results are within budget.
- **reuseMeasure (session-scoped measurement reuse):** upstream `pruneSession` measures the same content array twice (once as `pruneContent`'s total, once as `charsBefore`). A `WeakMap` local to one `pruneSession` call, keyed by array identity, can return the value already computed. It helps large sessions but adds a small cost to short ones (-3.3% P50) and **depends on the content array not being mutated inside the call stack**. That precondition is a real design constraint, not a formality.
- Combining both is not additive on short sessions (-4.6% P50) and sometimes has worse P95 than `reuseMeasure` alone.

**Status: neither candidate is in the shipped `src/index.js`, in any preset, in any Web button, or in the 0.2.0 tarball.** They are research results, not adopted optimizations, so no independent switch, Web control or release claim exists for them yet. They also carry no real-model evidence (§7). P95 is noisy on this machine and 60 samples is a small sample.

## 10. Reproducible commands

```sh
# From the plugin directory
npm ci
npm test
npm run benchmark          # rewrites benchmark/last-run.json
node research/candidate-round2.mjs   # research-only candidates, not shipped
npm pack                   # produces the reviewed tarball

# Clean install into an isolated DSH_HOME (pnpm must be on PATH).
# Pin storeDir in the profile's pnpm-workspace.yaml BEFORE add; do not change
# it until after remove, otherwise pnpm refuses to remove with a store mismatch.
dsh plugin --profile clean-web add ./dsh-leet-accelerator-0.2.0.tgz
dsh --profile clean-web --dump-config
dsh --profile clean-web --patch /path/to/probe.patch.yml   # runtime-load probe
dsh plugin --profile clean-web remove dsh-leet-accelerator

# Real Web Host (isolated DSH_HOME, loopback only)
dsh --profile YOUR_WEB_PROFILE --port 3188 --no-open
# then open the printed URL in Chrome and select a Leet comparison preset
```

Browser checks used a local Chrome plus `playwright-core`; scripts were kept outside the repository and are not part of the published package. No token, credential or private path is recorded here.
