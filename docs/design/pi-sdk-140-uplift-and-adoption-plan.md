# Pi SDK 1.3.0 → 1.4.0 — Uplift Report

**Created:** 2026-10-23
**Status:** **Uplift implemented** — `package.json` pins 1.4.0, the lock file is updated,
the gates are green. Not committed, not built, not released.
**Author:** AI-assisted session
**Baseline before:** 1.3.0 · **after:** 1.4.0 — `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` pinned exactly in `package.json`; `pi-agent-core`,
`pi-tui`, `pi-codemode`, `pi-mcp` and `pi-telemetry` resolve to 1.4.0 transitively.
App version 1.3.3 → **1.4.0**.
**Related:** [`pi-sdk-130-uplift-and-adoption-plan.md`](./pi-sdk-130-uplift-and-adoption-plan.md)
— the previous uplift; [`permission-gate-tool-call-event.md`](./permission-gate-tool-call-event.md)
— the gate's move to pi's public `tool_call` event, still open.

---

## 1. Summary

pi **1.4.0** was published 2026-10-21. One release, and **no pi SDK call in this app had
to change** — the uplift is source-free. What it brought is **catalog content**: the model
lists pi ships are static snapshots, and the OpenRouter snapshot in 1.3.0 predated the
models OpenRouter published in mid-October.

The uplift was driven by a concrete symptom: a model that exists on OpenRouter
(`deepseek/deepseek-v4.1-flash-1017`) could not be picked in Settings → Model Sets.

| #   | Change the uplift needed                             | Why                                                        |
| --- | ---------------------------------------------------- | ---------------------------------------------------------- |
| R1  | Pin `pi-ai` and `pi-coding-agent` to 1.4.0           | The snapshot behind every provider's model list (§3)       |
| R2  | Versions and citations in rule files, tests and docs | Pin text, line numbers, "last checked against" stamps (§6) |

Gates on the result: `npm run typecheck` clean; the full vitest suite **265 files / 4139
tests** passing; `npm run lint` 0 errors (warnings unchanged, none in a line this work
touched).

## 2. How it was checked

- **Source:** only the project's own copy — 1.4.0 installed from registry.npmjs.org into
  `node_modules/@earendil-works/` — plus the published 1.4.0 tarball (`npm pack`) for the
  diff against 1.3.0. Never a locally installed `pi` CLI, whose copy and version are the
  user's (rule in `CLAUDE.md` and `AI_MAIN_PROCESS.md` §13).
- **Read:** `pi-coding-agent/CHANGELOG.md` of 1.4.0; the `.d.ts` surface of every symbol the
  app imports; the `dist/` code behind each behavioural claim below; the model snapshot
  `pi-ai/dist/providers/data/*.json` of both versions; the live OpenRouter model list
  (`GET https://openrouter.ai/api/v1/models`) for the gap between snapshot and reality.
- **Run:** a scratch clone of the repo with 1.4.0 installed (typecheck, full test suite),
  then the project itself; a dump of `getProviders()` / `getModels()` from both versions.

## 3. What changed in pi 1.4.0, against this app

### 3.1 The model catalog — the reason for the uplift

pi's model lists are **static JSON snapshots** built into the package
(`pi-ai/dist/providers/data/<provider>.json`), not a live query. The app reads them through
`getModels(provider)` — `src/main/config/provider-catalog-native.ts:236` fills every
builtin provider's `modelOptions` from the registry, and `src/renderer/hooks/useModelSetForm.ts:136`
turns those into the picker's list. A model published on OpenRouter after the snapshot was
generated is therefore invisible until pi ships a new snapshot.

| OpenRouter model list | Count |
| --------------------- | ----- |
| pi-ai 1.3.0 snapshot  | 396   |
| pi-ai 1.4.0 snapshot  | 401   |
| Live OpenRouter API   | 468   |

`deepseek/deepseek-v4.1-flash-1017` is in the 1.4.0 snapshot ("DeepSeek: DeepSeek V4.1
Flash 1017", thinking levels `off, low, high, max` — from the snapshot's own
`thinkingLevelMap`, so the levels are the model's, not a guess) and was absent from 1.3.0.

**The uplift does not close this gap for good** — the live list is still 67 models ahead of
the snapshot. The picker will lag behind OpenRouter's catalogue until the next pi release.
See §7 for what that means for the next model the user wants.

### 3.2 Breaking changes, against this app

| Change (1.4.0)                                                                                                                                   | Reaches the app?    | Why                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateSummary()` ignores its `reserveTokens` argument; summaries use the model's output limit                                                 | **Yes (behaviour)** | The compaction trigger is unchanged, so `compaction-budget.ts` still governs _when_ compaction starts; its comment now records the change (§6) |
| Provider attribution headers moved into pi-ai's client identity; `before_provider_headers` no longer sees the OpenRouter/NVIDIA/OpenCode headers | No                  | The app registers no pi extension that hooks provider headers; the gate lives in the main process                                              |
| pi-ai gained a telemetry layer (`observeModelRequest`, `AI_TELEMETRY_SCHEMA`)                                                                    | No (checked)        | It defaults to a NOOP adapter (`pi-ai/dist/telemetry.js:105`) and `createAgentSession` wires none — nothing leaves the machine                 |
| Default GitHub Copilot model → `gpt-6.1-sol`; NVIDIA → `nemotron-3.5-super-vl-120b-a12b`; Xiaomi → `mimo-v2.6-pro`                               | No                  | Defaults are read from the catalog at runtime (`credential-dialog-view.ts:171`), not hardcoded                                                 |
| `openai-codex` no longer offers `gpt-5.5` / `gpt-5.3-codex-spark`                                                                                | No                  | Catalog content only                                                                                                                           |
| `MiniMax-M3.1-Flash` added to `minimax` / `minimax-cn` (levels low…max)                                                                          | Benefit             | More models in the native provider's picker                                                                                                    |
| `models.classify()` accepts images for classifier models                                                                                         | No                  | The app does not use codemode                                                                                                                  |
| Rex terminal support (OSC 8, truecolor, inline images)                                                                                           | No                  | CLI/TUI only                                                                                                                                   |

### 3.3 Fixes in 1.4.0 that reach us

- **Whitespace-only tool output no longer fails OpenAI/Google requests with a 400** — our
  `bash` tool can return a bare `\r\n`.
- **pi's `grep` tool now runs `rg --no-config`** — before, a `RIPGREP_CONFIG_PATH` in the
  environment silently turned regex searches into literal ones.
- **A session that recovered from a response cut off at the output limit no longer breaks**
  (the truncated tool call was dropped but its results were kept).
- **Codemode scripts queue instead of failing when both workers are busy** — the app does
  not use codemode, but the runner's MCP tools are unaffected either way.

### 3.4 Changes that needed no adaptation

- **The provider list is identical** — 41 ids in both versions, same order. `EXCLUDED_NATIVE`
  is unchanged; `azure` and `typesafe` stay excluded.
- **The SDK-only boundary is byte-identical** — `core/session-manager.d.ts`,
  `core/settings-manager.d.ts` and `core/resource-loader.d.ts` in 1.4.0 are unchanged from
  1.3.0. `SessionManager.inMemory()`, `SettingsManager.inMemory()` and the loader's
  `noExtensions` / `noSkills` / `projectTrusted: false` options are all still there.
- **The clamp algorithm is identical** — `getSupportedThinkingLevels()` and
  `clampThinkingLevel()` in `pi-ai/dist/models.js` are unchanged (they only moved: `:680`
  → `:693`, `:692` → `:705`), and `EXTENDED_THINKING_LEVELS` still reads
  `['off','minimal','low','medium','high','xhigh','max']`. The app's reimplementation in
  `src/shared/thinking-levels.ts` therefore stays equivalent; only its "verified against"
  stamp moved.
- **pi-ai's own pins are unchanged** — `@anthropic-ai/sdk` 0.129.0 and `openai` 7.19.0, the
  versions the app already pins, so the bundled pi-ai still loads the app's copies
  (`src/tests/bundled-externals-versions.test.ts`).
- **photon-node stays at 0.3.4**, so `photon_rs_bg.wasm` is still where the main build
  expects it (`src/tests/photon-wasm.test.ts`).
- **Neither pi package has an install script**, so `package.json`'s version-keyed
  `allowScripts` block needs no entry for them.

## 4. Boundaries re-asserted

Per `AI_MAIN_PROCESS.md` §1 and §13, every uplift re-asserts these. Each was checked
against the installed 1.4.0, and each has a test that fails if it breaks:

| Boundary                                                                                                                           | Where                                   | Verified by                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createAgentSession` runs on `SessionManager.inMemory()` and `SettingsManager.inMemory()` — the app owns history, pi owns no files | `src/main/claude/agent-runner.ts:3141`  | `src/tests/claude/sdk-only-session-isolation.test.ts`                                          |
| The resource loader stays locked down: `noExtensions`, `noSkills`, `projectTrusted: false` — the app's skill list is the only one  | `src/main/claude/pi-resource-loader.ts` | `src/tests/claude/pi-resource-loader-boundary.test.ts`, `src/tests/claude/skill-paths.test.ts` |
| The permission gate keeps its fail-closed reach-around (`agent.beforeToolCall`)                                                    | `src/main/claude/permission-gate.ts`    | `src/tests/claude/permission-gate-session.test.ts` (real session, faux provider)               |
| The renderer never imports pi-ai — the clamp is reimplemented, not shared                                                          | `src/shared/thinking-levels.ts`         | `tests/api-model-presets-guard.test.ts` and the thinking-level tests                           |
| pi-ai's `openai` / `@anthropic-ai/sdk` pins decide the app's                                                                       | `package.json`                          | `src/tests/bundled-externals-versions.test.ts`                                                 |
| pi's own files it loads relative to itself                                                                                         | `scripts/photon-wasm.js`                | `src/tests/photon-wasm.test.ts`                                                                |

All six are green on 1.4.0.

## 5. The question that started this

> "In the model list I pick when configuring Model Sets for OpenRouter, I cannot choose
> `deepseek/deepseek-v4.1-flash-1017`, although it exists on OpenRouter. How is this list
> formed at all?"

The chain, all read out of the source:

1. `src/main/config/provider-catalog-native.ts:236` — `enrichBuiltinEntries()` calls
   `getModels(piProvider)` from pi-ai for every builtin provider and stores the result in
   `modelOptions`.
2. `src/main/index.ts:1917` — the catalog reaches the renderer over IPC
   (`config.getProviderCatalog`), memoised for the session.
3. `src/renderer/hooks/useModelSetForm.ts:136` — the picker's list is that
   `modelOptions`; if the catalog has not loaded, it falls back to the hand-written preset
   in `src/shared/api-model-presets.ts:61` (12 OpenRouter models).
4. `getModels('openrouter')` reads the **snapshot** in the pi-ai package — never the live
   OpenRouter API.

So the list is a snapshot, and the snapshot was 6 days stale. The app _does_ fetch the live
OpenRouter list, but only to look up the context window of an already-picked model
(`src/main/config/openrouter-api.ts`, used by `agent-runner.ts:2231`).

Two consequences for a model that is not in the snapshot:

- **The builtin cloud providers cannot be typed into.** Their catalog entry sets
  `manualModelToggle: false` (`src/shared/provider-catalog.ts:90`), so the model id can
  only be picked, never entered. The refresh button next to the model field is a no-op
  outside Ollama (`src/renderer/hooks/useApiConnectivity.ts:211`).
- **A typed model gets no reasoning levels.** Thinking capabilities are resolved from the
  model _string_ (`src/main/claude/pi-model-resolution.ts:634`): a model in the registry
  gets its own `thinkingLevelMap`; a model that is not gets a synthetic one whose
  `reasoning` flag comes from the `REASONING_MODEL_PATTERN` heuristic
  (`pi-model-resolution.ts:67`) or is borrowed from a registry entry with the same id.
  `deepseek-v4.1-flash-1017` matches neither in 1.3.0 — so the picker would have shown it
  as "no thinking support", and the runner would have run it without reasoning, in perfect
  agreement with the UI and wrong with the model.

After the uplift the model is a registry entry with its own levels (`off, low, high, max`),
so both the picker and the runner see the truth.

## 6. What changed in the project

| File                                       | Change                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                             | `pi-ai` and `pi-coding-agent` → 1.4.0; app version 1.3.3 → 1.4.0                                                                                              |
| `package-lock.json`                        | regenerated for the pi packages (`pi-ai`, `pi-coding-agent`, `pi-agent-core`, `pi-codemode`, `pi-telemetry`)                                                  |
| `AI_MAIN_PROCESS.md`                       | pin 1.3.0 → 1.4.0; the uplift history now names 1.4.0 and what it brought; "last checked against pi 1.4.0"                                                    |
| `CLAUDE.md`                                | pin 1.3.0 → 1.4.0                                                                                                                                             |
| `docs/dependency-tiers.json` / `.md`       | installed versions and uplift records for both packages                                                                                                       |
| `src/shared/thinking-levels.ts`            | the "verified against" stamp: `models.js:692-710 (1.3.0)` → `:693-723 (1.4.0)` — same algorithm, new line numbers                                             |
| `src/main/claude/compaction-budget.ts`     | the module header now records that since pi 1.4.0 `reserveTokens` only decides _when_ compaction starts; the reserve is still needed for the request after it |
| `tests/provider-setups-vs-catalog.test.ts` | "Last checked against pi-ai 1.4.0 (2026-10-23)" — the tables did not change, the test passes unchanged                                                        |

**No source change was needed**: typecheck is clean without touching a line of application
code.

## 7. Found on the way

### 7.1 A curated pick the catalogue no longer has

`claude-3-7-sonnet-latest` is in the app's hand-written Anthropic lists
(`src/shared/api-model-presets.ts` — `API_PROVIDER_PRESETS.anthropic.models` and
`PI_AI_CURATED_PRESETS.anthropic.pick`) but **not in pi's Anthropic catalogue** — and it
was not in 1.3.0 either, so this is not a regression from the uplift. pi's Anthropic
catalogue in 1.4.0 holds 17 models, none of them a 3.7.

Which list the user actually sees depends on the path:

| Path                                                       | Anthropic list                                                                      | `claude-3-7-sonnet-latest` |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| Before the catalogue arrives (first render of every start) | the hand-written list → **8 models** (`src/renderer/hooks/api-config-shared.ts:39`) | **offered**                |
| Normal — the catalogue arrived                             | pi's catalogue, **17 models** (`src/renderer/hooks/useModelSetForm.ts:142`)         | absent                     |
| pi-ai could not be loaded in the main process              | the hand-written list → **8 models**                                                | **offered**                |

So in the normal path the stale entry costs nothing — the picker shows pi's whole
Anthropic catalogue, and the curated list is only the placeholder shown before the
catalogue arrives. It does show up in that placeholder, and permanently in the degraded
path, where the app offers a model id the catalogue no longer carries: the request then
depends on Anthropic's own aliases, which pi stopped tracking. The two hand-written lists
have also drifted apart (8 entries vs 7 effective), and no test catches it —
`tests/api-model-presets-guard.test.ts` compares the two lists with each other, never
against the installed pi.

The curated list has a second job: it is what `config.getPresets` returns, and
`defaultModelFields` takes the **first** entry of it as the default model of a new set
(`src/renderer/hooks/api-config-shared.ts:389`). A stale _first_ entry would put a dead
model into every new Anthropic set — for this one it does not, because the entry sits
last.

Worth fixing, but not in this uplift: it predates the work and touches lists the guard
test cross-checks. The two-line fix (drop the entry from both lists) plus a test that
every curated pick exists in the installed pi's catalogue would close the class, not just
this entry.

### 7.2 The snapshot will fall behind again

The live OpenRouter list is 468 models against pi-ai 1.4.0's 401. The next model the user
wants may again be missing from the picker, and the same reasoning applies: the app cannot
type it in for a builtin cloud provider, and a hand-entered id on a custom endpoint would
come with no reasoning levels.

Three ways out, none of them in this uplift:

- **Keep uplifting pi.** The list only ever catches up at a release boundary.
- **Merge the live OpenRouter list into the catalog** for the OpenRouter provider. The app
  already has a cached client for that API (`src/main/config/openrouter-api.ts`); the
  catalog builder would need to fetch it and fill in names for models the snapshot does not
  know. This makes the picker current instead of current-at-release.
- **Let builtin cloud providers accept a typed model id**, the way custom endpoints already
  do. Cheap, and it makes a missing model a non-event — at the price of no thinking levels
  for a model the registry does not know.

### 7.3 A model outside the curated list opens as typed text, with no way back to the picker

The curated lists are far narrower than the catalogues they sit on: OpenRouter 12 curated
picks against 401 catalogue models, Anthropic 7 against 17.

`splitModelSelection` (`src/renderer/hooks/api-config-shared.ts:418`) decides whether a
stored model is shown as **picked** or **typed** by membership in the _preset_ list, not
in the catalogue the picker offers. A stored model outside the curated list therefore
opens the form in typed mode: a plain text input instead of the searchable combobox — and
because a builtin cloud provider's catalog entry sets `manualModelToggle: false`
(`src/shared/provider-catalog.ts:90`), the "Preset / Custom" toggle that would switch
back is not rendered at all.

Verified with a probe against the app's own functions:

```
openrouter  deepseek/deepseek-v4.1-flash-1017 → picked=false  typed=true
anthropic   claude-opus-4-7                  → picked=false  typed=true
```

Nothing is lost — the id stays in `customModel` and `finalModelOf` returns it, so the
model is saved and run correctly. What changes is the control: the user is left typing an
id instead of searching a list, with no visible way back to the list.

This reaches almost every model the user might pick: 389 of the 401 OpenRouter models and
10 of the 17 Anthropic ones open in typed mode. For `custom` providers typed mode is the
only mode and is correct by design; for a builtin with a catalogue of hundreds, a split
that reads "is this in my twelve curated picks?" reads like it was written when the preset
list _was_ the catalogue.

Not fixed here: it is a behaviour change in the form, not a consequence of the uplift, and
it deserves its own decision (widen the curated lists, or make the picked/typed split
consult the catalogue the picker actually shows).

## 8. Testing & rollout

- `npm run typecheck` — clean.
- `npx vitest run` — **265 files / 4139 tests**, all passing (same counts as 1.3.0; no test
  was changed except a comment).
- `npm run lint` — 0 errors; the warning count is unchanged from before the uplift.
- **Still open:** the manual pass on a built app (`AI_MAIN_PROCESS.md` §13 step 5) — a new
  session, tool use, session reuse, a compaction trigger, a permission prompt, stop/cancel,
  and an attached image. The build and the macOS signing are done on the user's machine.
- **Not done here:** commit and release. `package.json` and `package-lock.json` changed
  together, as the pre-commit guard requires.
