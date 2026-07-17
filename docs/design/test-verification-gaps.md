# Test Verification Gaps — npm 12 install-script gate & untested credential ref-counting

**Created:** 2026-07-17
**Status:** Draft — problem analysis + proposed fixes; no code changed yet
**Author:** AI-assisted session (surfaced during the pi SDK 0.80.3 → 0.80.10 uplift)
**Scope:** Two independent gaps that both weaken our ability to verify changes. Neither is
caused by the uplift; the uplift is what made them visible and made the second one urgent.

---

## 1. Overview

Two unrelated problems, filed together because both block trustworthy verification:

| #   | Problem                                                       | Severity                     | Effort |
| --- | ------------------------------------------------------------- | ---------------------------- | ------ |
| §2  | `npm install` and `npm test` are broken under npm 12          | **High** — blocks `npm test` | S–M    |
| §3  | Credential ref-counting (anti-clobber) has zero test coverage | **High** — security-relevant | S      |

**Verified baseline:** npm 12.0.1, Node v24.17.0 (ABI 137), Electron 41.3.0 (ABI 145).

---

## 2. `npm install` / `npm test` broken under npm 12

### 2.1 Symptoms

```
$ npm install
npm error code EUNKNOWNCONFIG
npm error Unknown cli flags:
npm error   - --runtime
npm error   - --target
npm error   - --disturl

$ npm test
Error: The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 145.
This version of Node.js requires NODE_MODULE_VERSION 137.

Test Files  6 failed | 204 passed (210)
      Tests  50 failed | 2868 passed (2918)
```

Failing files: `src/tests/memory/memory-service.test.ts`,
`memory-eval-harness.test.ts`, `memory-smoke-harness.test.ts`.

**Confirmed pre-existing**, not uplift fallout: stashing the uplift and running at HEAD on
0.80.3 reproduces the identical ABI error. The failures are a native-module ABI mismatch,
which a TypeScript-level SDK migration cannot cause.

### 2.2 Root causes — two independent npm 12 changes

**Cause A — unknown CLI flags are now hard errors.** The `rebuild` script passes
node-gyp options as npm CLI flags:

```jsonc
"rebuild": "node -e \"... execSync('npm rebuild better-sqlite3 --runtime=electron --target='+v+' --disturl=https://electronjs.org/headers') ...\""
```

npm 12 rejects `--runtime`, `--target`, and `--disturl` with `EUNKNOWNCONFIG` instead of
passing them through. This makes `postinstall` (`download-node.js && npm run rebuild`) and
`posttest` (`npm run rebuild`) fail outright.

**Cause B — install scripts are gated behind `allowScripts`.** npm 12 blocks dependency
install/postinstall scripts unless explicitly approved. Eleven packages are currently
blocked:

```
@google/genai@1.52.0            (preinstall)
@turbodocx/html-to-docx@1.22.0  (postinstall)
better-sqlite3@12.8.0           (install: node-gyp rebuild)   <- native build
electron@41.3.0                 (postinstall: node install.js) <- downloads Electron binary
electron-winstaller@5.4.0       (install)
esbuild@0.27.2                  (postinstall: node install.js) <- downloads esbuild binary
fsevents@2.3.3                  (install)
ngrok@5.0.0-beta.2              (postinstall)
onnxruntime-node@1.24.3         (postinstall) <- local embeddings (§4.6)
protobufjs@7.6.1                (postinstall)
sharp@0.34.5                    (install)
```

This is why `npm rebuild better-sqlite3` silently no-ops: its `install: node-gyp rebuild`
script never runs, so nothing recompiles and the stale Electron-ABI binary survives.

Cause B is the more dangerous of the two because it **fails quietly**. Today the tree still
works only because `node_modules` holds binaries fetched by an older npm. **A clean
`rm -rf node_modules && npm install` on npm 12 would leave Electron, esbuild, sharp, and
onnxruntime-node without their binaries.** This is latent, not hypothetical.

### 2.3 Why the ABI ends up wrong

The intended dance is:

- `pretest`: `npm rebuild better-sqlite3` → Node ABI (137), so vitest can load it
- `posttest`: `npm run rebuild` → Electron ABI (145), so the app can load it

Under npm 12, `pretest` no-ops (Cause B) and `posttest` errors (Cause A). The binary is
stranded at whichever ABI it last had — Electron's 145 — and every vitest run that touches
SQLite fails.

### 2.4 Proposed fix

**Step 1 — approve install scripts (Cause B).** Use npm's own command, then commit the
result so every developer and CI get an identical, reviewed list:

```bash
npm install-scripts approve better-sqlite3 electron esbuild fsevents onnxruntime-node sharp protobufjs
```

This writes an `allowScripts` map to `package.json`, e.g.:

```jsonc
"allowScripts": {
  "better-sqlite3@12.8.0": true,
  "electron@41.3.0": true
}
```

Treat approval as a **supply-chain security decision**, not a formality — this gate exists
to stop arbitrary code execution on install. Approve only packages that genuinely need a
native build or binary download, and review on each bump. Candidates to leave denied
unless proven necessary: `@google/genai` (a no-op `echo`), `@turbodocx/html-to-docx`,
`ngrok`, `electron-winstaller` (build-host only).

> ⚠️ **npm 12 bug:** `npm install-scripts approve --dry-run` **still writes** to
> `package.json`. Do not trust `--dry-run` here; check `git diff` afterwards.

Note the `--allow-scripts-pin` flag controls whether entries are written pinned
(`pkg@version`) or unpinned. Pinned entries are safer (a version bump requires
re-approval) but require re-approval on every bump — pick one deliberately and document it.

**Step 2 — stop passing node-gyp options as npm CLI flags (Cause A).** Two options:

- **Option A (minimal).** Pass them as `npm_config_*` environment variables, which npm
  still honors:

  ```jsonc
  "rebuild": "node -e \"const {execSync}=require('node:child_process'); const v=require('electron/package.json').version; execSync('npm rebuild better-sqlite3',{stdio:'inherit',env:{...process.env,npm_config_runtime:'electron',npm_config_target:v,npm_config_disturl:'https://electronjs.org/headers'}})\""
  ```

  Smallest diff, no new dependency, keeps the existing shape.

- **Option B (canonical, recommended).** Use `@electron/rebuild`, the official tool, which
  already understands Electron's ABI and headers:

  ```jsonc
  "rebuild": "electron-rebuild -f -w better-sqlite3"
  ```

  Adds a devDependency but removes the hand-rolled version/disturl plumbing and is
  maintained alongside `electron-builder` (already a devDependency at `^26.14.0`).

**Recommendation: Option B**, falling back to Option A if adding the devDependency is
unwelcome. Option A preserves a fragile pattern that has now broken once already.

**Step 3 — pin the toolchain.** The break arrived with an npm major upgrade, silently.
Add an `engines.npm` range and record the npm version in §6 of `ARCHITECTURE.md` so the
next jump is a deliberate migration rather than a surprise.

### 2.5 Verification

1. `rm -rf node_modules && npm install` completes with no `EUNKNOWNCONFIG` and no blocked
   scripts for approved packages.
2. `npm test` passes all 210 files (the 50 SQLite failures clear).
3. `npm run dev` launches — better-sqlite3 loads under Electron ABI 145.
4. Confirm the pre/post ABI flip still round-trips: `npm test` then `npm run dev`, twice.

### 2.6 Risks

- **Low** for Step 2 (mechanical, verifiable).
- **Security-relevant** for Step 1: approving install scripts re-enables arbitrary code
  execution at install time for those packages. This is the pre-npm-12 status quo, so it
  restores rather than weakens the previous posture — but it should be an explicit,
  reviewed decision, and the approved list is worth re-reviewing on dependency bumps.

---

## 3. Credential ref-counting has zero test coverage

### 3.1 What the mechanism does

`agent-runner.ts` injects per-run API keys into the shared `ModelRuntime` and removes them
in `finally`. Because runtime keys live on one process-wide runtime shared by every
concurrent session, a naive remove would yank a key out from under another in-flight
session. A ref-count per provider key prevents that: set increments, release decrements,
and the key is only removed at zero.

This is the **cross-session credential clobber guard**. If it regresses, one chat's
credentials can vanish mid-run, or a key can outlive its run and leak into a later one.

### 3.2 The gap

The module exports three helpers _solely_ for testing:

```ts
export const _testOnly_runtimeKeyRefCounts;
export function _testOnly_trackRuntimeKeys(...)
export function _testOnly_releaseRuntimeKeys(...)
```

**Nothing imports them.** `grep -rn "_testOnly_trackRuntimeKeys\|_testOnly_releaseRuntimeKeys\|_testOnly_runtimeKeyRefCounts" src/`
returns only the definitions in `agent-runner.ts`. The test seam was built and never used,
so the invariant has never been asserted.

### 3.3 Why it is now urgent

The 0.80.3 → 0.80.10 uplift changed this code's concurrency semantics:

- `setRuntimeApiKey` / `removeRuntimeApiKey` became **async** (`Promise<void>`), so
  `_trackRuntimeKeys` / `_releaseRuntimeKeys` are now async and **interleavable**. What was
  a synchronous, atomic critical section now has suspension points.
- The ref-count increment was deliberately **moved before** the awaited write. Async writes
  open a window in which a concurrent release could observe a zero count for a key another
  run is mid-claim and delete it. Incrementing first closes that window; callers record
  keys before calling, so a throw still releases them in `finally`.
- Key storage moved from a **process-global** `AuthStorage.runtimeOverrides` map to a
  **per-instance** `ModelRuntime`. Correctness now depends on the `shared-auth.ts`
  singleton actually being a singleton — a second `ModelRuntime` silently breaks the
  guarantee with no type error.

That last point is the sharpest: singleton-ness went from incidental to load-bearing, and
nothing enforces or detects it.

### 3.4 Proposed tests

New file `src/tests/claude/runtime-key-refcount.test.ts`, using a fake `ModelRuntime`
(`{ setRuntimeApiKey, removeRuntimeApiKey }` as async spies) and resetting
`_testOnly_runtimeKeyRefCounts` between cases:

1. **Set then release removes the key.** One run: track `['anthropic']`, release →
   `removeRuntimeApiKey('anthropic')` called once, ref-count map empty.
2. **Concurrent runs do not clobber.** Two runs track `['anthropic']`; run A releases →
   `removeRuntimeApiKey` **not** called (B still holds it). B releases → now called once.
   _This is the core anti-clobber assertion._
3. **Interleaved async track/release.** Start A's `_trackRuntimeKeys` and B's
   `_releaseRuntimeKeys` without awaiting in order; assert A's key survives. Directly
   covers the increment-before-await ordering.
4. **Multi-key runs ref-count independently.** Track `['openrouter','anthropic']`, release
   a subset, assert only the released key is removed.
5. **Release is resilient.** `removeRuntimeApiKey` rejects for one key → remaining keys are
   still processed and the error is logged, not thrown (matches the `finally` contract).
6. **Unbalanced release is safe.** Releasing a never-tracked key does not throw and does
   not drive the count negative.
7. **(Optional) Singleton guard.** Assert `getSharedModelRuntime()` returns the same
   promise across concurrent calls — locks the §3.3 assumption. Add a rejection case
   asserting the memo clears so the next caller retries.

**Effort:** Small — pure functions, fake runtime, no SDK or DB needed. Notably these tests
run **without SQLite**, so they pass even while §2 is unfixed.

### 3.5 Risk of not doing it

The ref-count logic is exercised on **every agent run with an API key**, is
security-relevant, has just had its concurrency model changed, and is asserted by nothing.
A regression would surface as intermittent, hard-to-reproduce auth failures in
multi-session use — the worst possible failure mode to debug from a bug report.

---

## 4. Sequencing

1. **§3 tests first.** Small, self-contained, unblocked by §2, and they lock an invariant
   that just changed. Highest value per unit of effort.
2. **§2 Step 2** (rebuild script) — mechanical, restores `npm test`.
3. **§2 Step 1** (allowScripts) — needs a security-minded review of the approve list.
4. **§2 Step 3** (pin npm) — prevents recurrence.

§2 and §3 are independent and can proceed in either order or in parallel.

---

## 5. Open questions

1. **`@electron/rebuild` vs env vars** (§2.4 Step 2) — add the devDependency, or keep the
   hand-rolled script with `npm_config_*`?
2. **Approve list** (§2.4 Step 1) — which of the 11 blocked packages genuinely need install
   scripts? `ngrok`, `@google/genai`, and `@turbodocx/html-to-docx` look deniable; needs
   confirmation per package.
3. **Pinned vs unpinned `allowScripts`** — pinned is safer but adds re-approval friction on
   every bump.
4. **CI coverage** — does CI run `npm install` on npm 12 today? If so it may already be
   silently degraded, or pinned to an older npm that masks the problem.
5. **Singleton enforcement** (§3.4 item 7) — is a test sufficient, or should
   `shared-auth.ts` actively detect a second `ModelRuntime` construction?
