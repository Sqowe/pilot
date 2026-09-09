# Pi SDK 0.83–0.85 Feature Adoption — Design & Implementation Plan

**Created:** 2026-09-08
**Status:** **Uplift landed (0.85.1).** Adoption backlog consolidated and re-scoped —
not started.
**Author:** AI-assisted design session
**Baseline today:** **0.85.1** — `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` are both pinned there
([`package.json:84-85`](../../package.json#L84)). `pi-agent-core` and `pi-tui` resolve
to 0.85.1 transitively; `typebox` resolves to 1.3.7.
**Supersedes:** [`archive/pi-sdk-080-feature-adoption-plan.md`](./archive/pi-sdk-080-feature-adoption-plan.md)
and [`archive/pi-sdk-082-feature-adoption-plan.md`](./archive/pi-sdk-082-feature-adoption-plan.md).
Both are archived; everything still worth doing was carried into §5 and §6 below, and
§10 records what was dropped and why.
**Source of capabilities:** the pi CHANGELOG entries for 0.82.1 → 0.85.1, each claim
re-verified against the installed 0.85.1 type declarations under
`node_modules/@earendil-works/`, not the changelog prose alone.

> **Why one document instead of three.** The 0.80 plan was finished apart from three
> stragglers; the 0.82 plan was never started, and three of its four items were
> overtaken by what shipped in 0.83–0.85. Keeping them as separate live documents meant
> three places to look and two of them misleading. This document is the single live
> adoption backlog. The two predecessors move to `archive/` as as-built history, which
> is the same treatment `thinking-level-per-model.md` got when it shipped.

---

## 1. Overview

The 0.82.0 → 0.85.1 uplift covers nine releases. The uplift itself is done and green
(§3). What remains is adoption: deciding which of the newly available surfaces this app
should consume, plus the backlog inherited from the two predecessor plans.

Guiding principles, unchanged from both predecessors and consistent with
[`ARCHITECTURE.md`](../../ARCHITECTURE.md):

- **Consume, never fork.** Every item is a pure consumer of a public SDK surface.
- **SDK-only, never the `pi` CLI's workflow** (`ARCHITECTURE.md` §4.1).
- **Additive and reversible.** Each item is independently shippable.
- **Security changes require explicit confirmation.** Item E (§7.1) touches path
  containment and Item S (§4) touches what a model-invoked command can see. Neither may be
  closed by making a check pass.

### Prioritization summary

| Item  | Feature                                               | Origin           | Effort | Risk         | Recommended    |
| ----- | ----------------------------------------------------- | ---------------- | ------ | ------------ | -------------- |
| **S** | Settle the bash session-variable exposure policy      | 0.82 Item C      | S      | Low          | Yes            |
| **A** | Session usage totals — now a read, not an accumulator | 0.82 Item A      | S      | Low          | Yes            |
| **B** | Compaction failure and retry narration                | 0.82 Item B      | S      | Low          | Yes            |
| **E** | `ctx.cwd` honoured by built-in tools                  | 0.85.0 fix       | S      | **Security** | Yes — verify   |
| **F** | Edit-diff rendering in the transcript                 | 0.80 §4.1 item 3 | M      | Low          | Yes            |
| **G** | Waiting-on-a-human as a distinct state                | 0.84.4           | S      | Low          | Diagnose first |
| **D** | Constrained (strict-schema) tool sampling             | 0.82 Item D      | M      | Medium       | Investigate    |
| **H** | Provider-scoped `env` overrides                       | 0.80 §5.3        | S      | Low          | Opportunistic  |
| **I** | RPC extension-UI typed surface                        | 0.80 §5.2        | S      | Low          | Opportunistic  |

Recommended sequencing: **A** and **B** first — both collapsed to small by what 0.84
shipped, and both are visible improvements. Then **E** as a verification pass, since it is
the one remaining item touching a security boundary. Then **S**, which is a short
consistency decision plus a regression test, and **F**. **G** needs a diagnosis before it
is scheduled at all (§7.2); **D** is an investigation. **H** and **I** are cleanups to fold
into whatever work next touches those files.

---

## 2. Dependency & baseline

Nothing here is blocked. The uplift landed first, exactly as the 0.82 plan required, and
every surface below exists in the installed 0.85.1 tree.

- **Go to 0.85.1, never 0.85.0.** 0.85.0 unintentionally published internal experimental
  code and dependencies, which broke SDK imports; 0.85.1 is the fix for precisely that
  (`#9132`). There is no reason to pin 0.85.0.
- **One packaging change to know about.** 0.85.1 no longer exports the `./package.json`
  subpath, so `require('@earendil-works/pi-coding-agent/package.json')` now throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing in `src/` does this, but scripts and
  diagnostics that read the SDK version that way need to read the file directly instead.

---

## 3. The uplift — as built (2026-09-08)

**Change:** `package.json:84-85`, both packages `0.82.0` → `0.85.1`, followed by
`npm install` and `npm run rebuild` (better-sqlite3 against Electron's ABI).

**Verification:**

| Check               | Result                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck` | Clean, no errors                                                                  |
| `npm test`          | **3141 tests passed across 222 files**                                            |
| Resolved versions   | `pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui` all 0.85.1; `typebox` 1.3.7 |

### 3.1 Breaking-change audit

Nine releases in the gap, with two releases carrying breaking changes. None of them
reach this codebase. The audit is recorded here because the reasoning is not obvious
from the changelog and will be needed again at the next uplift.

**0.84.0 — `message_update` emits only deltas.** This was the one with real potential to
break the app. The changelog says the cumulative `message` and
`assistantMessageEvent.partial` fields were removed to stop quadratic output growth. This
app depends on `partial` at
[`agent-runner.ts:3792`](../../src/main/claude/agent-runner.ts#L3792), where it reads the
tool name and tool call id out of a `toolcall_start` event. Had that field gone away, tool
cards would have rendered as `unknown` and been assigned a random id that never matched
the later completion event, leaving spinners running forever.

It does not apply. The removal happens only in `toJsonEvent()`, the function that
serializes events for the JSON and RPC stdout protocols
(`pi-coding-agent/dist/modes/json-event.d.ts:5-19` — a `WithoutPartial<T>` mapped type
that also re-adds `id` and `toolName` for the wire format). The in-process
`MessageUpdateEvent` still carries both `message` and the full `assistantMessageEvent`
(`dist/core/extensions/types.d.ts:596-601`), and pi-ai's `toolcall_start` variant still
declares `partial: AssistantMessage` (`pi-ai/dist/types.d.ts:442-445`). This app
subscribes in-process through `piSession.subscribe()`
([`agent-runner.ts:3727`](../../src/main/claude/agent-runner.ts#L3727)) and never crosses
that serialization boundary.

> **Consequence for later.** If this app ever moves its event consumption to the RPC
> transport, this becomes a real migration: `partial` will be gone and the replacement is
> the `id` and `toolName` fields that `toJsonEvent` adds to `toolcall_start`.

The rest of the audit:

| Breaking change                                                                       | Why it does not apply here                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.83.0 — TypeBox 1.3.7 removes `Type.Base`, `Type.Promise`, `Value.Mutate` and others | Only `Type.Unsafe`, `Object`, `Union`, `Literal`, `String`, `Integer`, `Optional` are used, all still supported; `typebox: ^1.1.38` already resolved to 1.3.7                                                                                                           |
| 0.84.0 — `ModelRuntime.setRuntimeApiKey()` options argument changed                   | Signature is `(providerId, apiKey, options?)` (`dist/core/model-runtime.d.ts:82`); called with two arguments at [`agent-runner.ts:71`](../../src/main/claude/agent-runner.ts#L71) and [`claude-sdk-one-shot.ts:236`](../../src/main/claude/claude-sdk-one-shot.ts#L236) |
| 0.84.0 — `getApiKeyAndHeaders()` returns nullable header values                       | Not used anywhere in `src/`                                                                                                                                                                                                                                             |
| 0.84.0 — `ModelRegistry.refresh()` signature change                                   | Not used                                                                                                                                                                                                                                                                |
| 0.84.0 — `ModelsStreamTransforms` renamed                                             | Not used                                                                                                                                                                                                                                                                |
| 0.84.0 — pi-agent-core v4 lane-based session rewrite                                  | `pi-agent-core` is not imported; one comment references it                                                                                                                                                                                                              |
| 0.84.3 — `GoogleThinkingLevel` renamed                                                | Not used                                                                                                                                                                                                                                                                |

A clean typecheck and a full green test run are consistent with this reading, though
neither would have caught a runtime-only field removal — which is why the `partial`
question was settled by reading pi's declarations rather than by trusting the build.

---

## 4. Item S — Bash session-variable exposure policy

> Carried from 0.82 Item C, with all three of its open questions now answered against the
> installed 0.85.1 tree **and against how this app actually builds its session**. The
> answer to the third question changes the item's severity: the variable that made it a
> security question is never set here.

### 4.1 What pi does

Since 0.82.0 the built-in bash tool assembles the child environment in
`resolveSpawnContext` (`dist/core/tools/bash.js:119-140`):

```js
const env = { ...getShellEnv() };
delete env.PI_SESSION_ID;
delete env.PI_SESSION_FILE;
delete env.PI_PROVIDER;
delete env.PI_MODEL;
delete env.PI_REASONING_LEVEL;
if (exposeSessionEnvironment && ctx) {
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile; // conditional
  if (model) {
    env.PI_PROVIDER = model.provider;
    env.PI_MODEL = model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
}
const baseContext = { command, cwd, env };
return spawnHook ? spawnHook(baseContext) : baseContext;
```

Three properties matter. The five names are **deleted from the inherited environment
first**, so they cannot be spoofed by setting them in the parent shell. `spawnHook` runs
**last**, over the finished set. And `PI_SESSION_FILE` is set **only if the session
manager reports a file**.

`exposeSessionEnvironment` defaults to true (`dist/core/tools/bash.d.ts:64-65`), and this
app passes no options to `createCodingTools(effectiveCwd)`
([`agent-runner.ts:3194`](../../src/main/claude/agent-runner.ts#L3194)), so the default
applies. `ToolsOptions.bash` is the only way to change it
(`dist/core/tools/index.d.ts:25-34, 40`).

### 4.2 `PI_SESSION_FILE` is never set in this app

The app creates its pi session in exactly one place
([`agent-runner.ts:3384-3394`](../../src/main/claude/agent-runner.ts#L3384)) and passes
`PiSessionManager.inMemory()`. In pi that is
`new SessionManager(cwd, "", undefined, false, ...)`
(`dist/core/session-manager.js:1254-1256`) — no session file, no persistence. The
constructor only sets a file when one is given (`dist/core/session-manager.js:605-612`),
and `getSessionFile()` returns that field unchanged (`dist/core/session-manager.js:736-738`).

So `sessionFile` is always undefined, the conditional never fires, and the transcript path
is never handed to a bash command.

**`inMemory()` is not incidental — it is the SDK-only boundary applied to sessions.**
Persisting through pi would write to `~/.pi/agent/sessions/--<encoded cwd>--`
(`dist/core/session-manager.js:242-247`), which is the very directory the `pi` CLI reads
and writes. Conversations held in this app would appear in `pi`'s own session list for the
same working directory, and vice versa. `ARCHITECTURE.md` §4.1 forbids exactly that: the
app "must never adopt that agent's user-level configuration, catalogs, or network
behavior", because doing so would "make app behavior depend on whether the user also
happens to run `pi` locally" (`ARCHITECTURE.md:153-158`).

The version dimension makes it worse than a tidiness problem. The SDK pinned here and the
user's installed `pi` CLI are independent and **will normally be different versions** — the
two happening to match at 0.85.1 on 2026-09-09 is the exception. Session files are versioned
(v1 → v2 → v3) and older ones are rewritten to the current version when loaded
(`docs/session-format.md:19-27`), so a shared directory would have whichever side is newer
migrating the other's files in place, with no way back for the older one.

There is also no reason to want it. The app already owns conversation history: sessions,
messages and trace steps live in its own SQLite database at `<userData>/data/cowork.db`
([`database.ts:232-234`](../../src/main/db/database.ts#L232), schema at `:255-291`), with
memory in `<userData>/memory` ([`index.ts:1062`](../../src/main/index.ts#L1062)) and its own
export paths in [`src/main/chat/`](../../src/main/chat/). Switching to pi's session files
would add nothing and mix two products' histories in one directory.

> **Correction (2026-09-09).** An earlier revision of this plan stated that a
> model-invoked bash command could already read the absolute path to the conversation
> transcript, and ranked this item as required security work. That was wrong: it was
> reasoned from the capability's documentation rather than from how this app instantiates
> the session. The exposure does not exist here.

**The conclusion rests on one unannotated call.** `inMemory()` is the third instance of the
SDK-only rule, alongside `modelsPath: null` and `allowModelNetwork: false` — but those two
are named in the `ARCHITECTURE.md` §4.1 table and enforced visibly in
[`shared-auth.ts:18-22`](../../src/main/claude/shared-auth.ts#L18), whereas the session
choice appears nowhere in the architecture document and carries no comment at the call
site. Anyone changing it would see a lone `inMemory()` and no reason not to. §4.5 closes
that gap.

### 4.3 What is actually exposed

Four variables reach agent bash commands: `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL`. No filesystem path among them. The residual surface is that a
model-authored command learns which model is running it and at what reasoning level.

One detail worth recording, because it is not obvious from the settings: when the exposure
is on, pi appends a line to the **system prompt** (`dist/core/tools/bash.js:30-33`, wired
in at `bash.js:152`):

> "You can inspect PI\_\* environment variables for current model and session details."

So the model is actively told the variables are there. The text originates in the library,
not in this app's own prompt assembly, and it is tied to the same flag — turning the
exposure off removes the line too.

### 4.4 The two execution paths disagree

Ordinary commands go through pi's bash tool and receive the four variables. Commands
carrying `sudo` are re-spawned by the app itself —
`spawn(shell, shellArgs, { stdio, cwd: effectiveCwd })` at
[`agent-runner.ts:1893-1896`](../../src/main/claude/agent-runner.ts#L1893), with no `env`
option — so they inherit the main-process environment and see none of them.

The same command therefore observes a different environment depending on whether it
contains `sudo`. Not a security hole, but an inconsistency nobody chose.

The sandbox does not change this picture: `createCodingTools` is called without custom
`operations`, so pi's local shell execution is used, and isolation is achieved by syncing
files and rewriting paths rather than by substituting the executor.

### 4.5 Proposed change

The item is no longer urgent, and is now a consistency decision rather than a security
one. Three options:

1. **Leave it as is** — record the decision and its reasoning, since the reasoning depends
   on `inMemory()` rather than on anything self-evident.
2. **Turn the exposure off** — `createCodingTools(cwd, { bash: { exposeSessionEnvironment: false } })`.
   This also removes the system-prompt line, since both hang off the same flag.
3. **Align the sudo path** by adding the same four variables to its `spawn` call.

**Recommended: option 1, plus making the session choice explicit.** Not as insurance
against a likely product decision — there is none, per §4.2 — but because the SDK-only
boundary is documented for two cases and silent for the third. Three small pieces:

1. **Name it in `ARCHITECTURE.md` §4.1**, as a row beside `modelsPath: null` and
   `allowModelNetwork: false`, since it is the same rule applied to sessions.
2. **Comment the call site** at [`agent-runner.ts:3394`](../../src/main/claude/agent-runner.ts#L3394),
   so the reason is visible where the change would be made.
3. **Add a regression test** asserting the session manager reports no session file. This is
   the part that actually holds: it fails if the boundary is crossed, whereas prose only
   helps someone who reads it first. It also happens to pin `PI_SESSION_FILE` shut, which
   is why this item can otherwise be left alone.

> **Done (2026-09-09).** All three shipped: the `ARCHITECTURE.md` §4.1 paragraph, the
> comment at the call site, and
> [`sdk-only-session-isolation.test.ts`](../../src/tests/claude/sdk-only-session-isolation.test.ts).
> The test asserts both halves independently — that the SDK's `inMemory()` still means "no
> file" (an uplift could change that) and that the runner still asks for it — and was
> verified to fail when the construction is swapped for a file-backed one. It is the first
> test covering any of the three SDK-only cases; `modelsPath: null` and
> `allowModelNetwork: false` are still documented but unpinned, which is worth closing the
> same way.

If the exposure is ever wanted narrower rather than off, a single variable **can** be
masked: `spawnHook` receives and returns `{ command, cwd, env }`
(`dist/core/tools/bash.d.ts:51-56`) and runs after injection, so `delete env.PI_SESSION_FILE`
inside it is sufficient. The 0.82 plan's fallback — suppress everything and re-inject the
safe subset by hand — is not needed.

### 4.6 Effort / risk

S. Risk Low. The sandbox-reachability audit the 0.82 plan called for is **moot**: there is
no path to reach.

---

## 5. Carried forward from the 0.82 plan

### 5.1 Item A — Session usage totals · **collapsed to a read**

The 0.82 plan split this into A1 (capture compaction usage by hand) and A2 (build a
per-session accumulator in the main process, sized Medium). Its open question was whether
`SessionManager` already exposes totals, making A2 a read rather than a
re-implementation.

**It does.** `AgentSession.getSessionStats(): SessionStats` exists, and its own
documentation settles the point — _"Aggregates over ALL session entries (including history
that was compacted away), so token/cost totals reflect what was actually billed across the
session"_ (`dist/core/agent-session.d.ts:636-641`). `SessionStats` carries
`tokens: { input, output, cacheRead, cacheWrite, total }` and `cost`
(`dist/core/agent-session.d.ts:173-191`). There is also
`getUsageCostBreakdown(entries)`, which groups attributable assistant usage by model and
everything else into a separate bucket (`dist/core/usage-totals.d.ts`).

That deletes most of the item. Because the aggregate already spans compaction and
branch-summary entries — the usage that 0.81.0 started persisting — **A1 is unnecessary
too**: the compaction summary's cost is already inside the total. Manually threading
`event.result?.usage` through `normalizeTokenUsage` would risk double-counting it.

**Revised change:** call `getSessionStats()` and surface the result. The remaining
question is a product one — where a running spend readout belongs, given the ContextPanel
shows current context fill rather than cumulative spend — not an engineering one.

**Effort:** S. **Risk:** Low. Read-only.

### 5.2 Item B — Compaction failure and retry narration · **wider than designed**

The 0.82 plan proposed narrating the three `summarization_retry_*` events from 0.81.1 in
the existing compaction trace step, so a retrying summary stops looking stalled.

That still holds, and 0.84.3 added a strictly better companion:
`session_compact_failed`, which reports why a compaction failed rather than only that it
retried (`dist/core/extensions/types.d.ts:465-476`) — `reason` (`manual` / `threshold` /
`overflow`), `errorMessage`, `aborted`, `willRetry`, and `fromExtension`.

**Revised change:** implement the original three retry cases, and add
`session_compact_failed` so a compaction that ultimately fails says so in the trace
instead of leaving a step that never resolves. The `willRetry` flag distinguishes "failed
and giving up" from "failed and recovering", which is exactly the distinction the trace
UI needs.

The switch this extends has no `default:` case and no exhaustiveness assertion, so these
events already arrive and are already ignored safely — nothing is broken today, and
nothing is shown either.

**Effort:** S. **Risk:** Low — additive text on an additive event stream.

### 5.3 Item D — Constrained tool sampling · **now testable against an upstream implementation**

Unchanged in substance: `Tool.constrainedSampling?: false | ConstrainedSamplingConfig`
(`pi-ai/dist/types.d.ts:383-388`) would be added to the tool definitions built in
`buildMcpCustomTools` ([`agent-runner.ts:451-484`](../../src/main/claude/agent-runner.ts#L451)),
where third-party MCP `inputSchema`s are wrapped verbatim with `Type.Unsafe`.

The correctness caveat also stands: third-party MCP schemas are frequently not written to
be strict, and `strict: "prefer"` is the only defensible default.

**What changed:** 0.84.2 shipped experimental strict JSON-schema constrained sampling for
pi's own `read`, `bash`, `edit` and `write` tools under `PI_EXPERIMENTAL=1`. There is now
a working upstream implementation to observe before touching this app's MCP wrapper —
which is a considerably cheaper first step than the 0.82 plan's "enable it on a couple of
tools and see". Also relevant: 0.83.0's TypeBox 1.3.7 upgrade specifically fixed compiled
validation of nullable array tool arguments, a category of schema this would otherwise
have stumbled over.

**Effort:** M, nearly all of it investigation. **Risk:** Medium until tested.

---

## 6. Carried forward from the 0.80 plan

### 6.1 Item F — Edit-diff rendering

The one substantive leftover. The SDK exports `generateDiffString`,
`generateUnifiedPatch` and `EditDiffResult`, so the app can render what an `edit`
actually changed **without adding a diff library**.

Today there is no diff rendering at all:
[`toolHelpers.tsx`](../../src/renderer/components/message/toolHelpers.tsx) maps `edit` to
a pencil icon and the label `Edit <path>`, and
[`ToolUseBlock.tsx:197-198`](../../src/renderer/components/message/ToolUseBlock.tsx#L197-L198)
renders the tool input into a `<pre>` as raw `JSON.stringify(block.input, null, 2)`. The
user sees escaped `old_string` / `new_string` blobs.

The 0.80 plan already corrected its own framing here: this is a readability **feature**,
not a cleanup swap, so it adds code rather than removing it. **Effort:** M. **Risk:** Low.

### 6.2 Item H — Provider-scoped `env` overrides

`ModelRuntime.getAuth()` accepts `ModelRuntimeAuthOverrides` — `{ apiKey?, env? }` — so
provider-scoped `env` is a parameter on a call the app already makes rather than something
to plumb by hand. The `httpProxy` half of the original §5.3 shipped in `bdcd8ff5`; this is
what was left.

The other remnant, verifying that Mistral prompt-cache cost accounting flows into the
cache-hit display, **is dropped**: the display it was meant to flow into ("CH") was itself
removed as buggy and low-value. There is no target left to verify against.

**Effort:** S. **Risk:** Low. Fold into the next change that touches auth config.

### 6.3 Item I — RPC extension-UI typed surface

Types-only. The IPC/RPC bridge and
[`agent-runtime-extension.ts`](../../src/main/extensions/agent-runtime-extension.ts) use
this app's own interfaces where they mirror pi's extension-UI protocol; adopting the
exported types reduces drift. **Effort:** S. **Risk:** Low. Opportunistic.

---

## 7. New in 0.83–0.85 worth adopting

### 7.1 Item E — `ctx.cwd` now honoured by the built-in tools · verify

0.85.0 fixed the `bash`, `edit`, `find`, `grep`, `ls`, `read` and `write` tools ignoring
`ctx.cwd` (`#8627`). Path containment is a security boundary in this app, and this app
threads a working directory through a `cwdRef` that is updated at the start of each
`run()` ([`agent-runner.ts:1601-1615`](../../src/main/claude/agent-runner.ts#L1601)).

A behavioural fix in which directory the built-in tools resolve paths against is exactly
the kind of change that can silently shift what a containment check is checking. The work
here is a verification pass, not a feature: confirm the app's `cwd` handling still means
what it did before, and that the fix does not widen the reachable path set under either
sandbox.

**Effort:** S. **Risk:** Security-relevant — worth doing early despite the small size.

### 7.2 Item G — Waiting on a human as a distinct state · diagnose first

0.84.4 added `ui_prompt_start` and `ui_prompt_end` so a host can tell real agent work
apart from time spent waiting on a person
(`dist/core/extensions/types.d.ts:563-577`), carrying `reason: "ui_prompt"`, a `kind` of
`select` / `confirm` / `input` / `editor` / `custom`, and an optional `title`. They are
emitted by a wrapper around `ctx.ui` (`dist/core/extensions/runner.js:273-308`) that
tracks nesting depth in `uiPromptDepth` and fires only on the outermost prompt.

**They will not fire for this app's permission dialog.** They cover extension `ctx.ui`
prompts, whereas this app's gate replaces `agent.beforeToolCall` with its own
`BeforeToolCallHook` and prompts over its own IPC channel
([`agent-runner.ts:1579-1618`](../../src/main/claude/agent-runner.ts#L1579)). pi has no
knowledge of that wait.

**But half of this item is already built.** The app already tracks how many permission
dialogs are open, in `permissionWaitState`
([`agent-runner.ts:656`](../../src/main/claude/agent-runner.ts#L656)) — structured much
like pi's: a `count` incremented on entry
([`agent-runner.ts:1695-1701`](../../src/main/claude/agent-runner.ts#L1695)) and cleared
only when it returns to zero
([`agent-runner.ts:1773-1782`](../../src/main/claude/agent-runner.ts#L1773)), with a
`runId` guard so a stale dialog resolving after a restart becomes a no-op. Parallel tool
calls are handled.

So the app knows precisely when a wait on a human starts and ends. What it does not do is
tell the renderer: there is no `sendToRenderer` call anywhere between entry and exit. The
state feeds exactly one consumer — suppressing the inactivity timer so the agent is not
aborted while someone is deciding
([`agent-runner.ts:3700-3706`](../../src/main/claude/agent-runner.ts#L3700)).

That makes the change small: emit two events from the transitions that already exist.

**The diagnosis has to come first, though.** The known-limitation comment
([`agent-runner.ts:1574-1577`](../../src/main/claude/agent-runner.ts#L1574)) records a
symptom — the renderer misses UI update events and a loading spinner may not clear — but
not a cause, and the cause is not established anywhere in the code. What is visible is
that the global `isLoading` flag is cleared only on a `session.status` other than
`running`, or on an error ([`useIPC.ts:165-170`](../../src/renderer/hooks/useIPC.ts#L165),
[`useIPC.ts:359`](../../src/renderer/hooks/useIPC.ts#L359)) — which suggests the stuck
indicator is a per-tool trace card left in `running` rather than the global flag. That is
a hypothesis, not a finding.

Reproduce it and identify which indicator sticks before scheduling the work. If the cause
is that the renderer does not know about the pause, two events close it. If it is
something else — a trace card never receiving its resolution when permission is denied,
say — the events will not help and the fix belongs elsewhere. There is no urgency: the
timer already has a working workaround.

**Effort:** S once diagnosed. **Risk:** Low.

### 7.3 Smaller items, no action proposed yet

- **PowerShell tool (0.84.3).** An optional native `powershell` tool, configurable through
  `defaultTools` and the SDK, with `PowerShellToolOptions` sharing `operations`,
  `exposeSessionEnvironment` and `spawnHook` with bash
  (`dist/core/tools/powershell.d.ts:11`). Windows is a target platform, so this is worth a
  look — but note it inherits the §4 exposure question, and any adoption must go through
  the same bash trust and denylist gating rather than around it.
- **Anthropic gateway bearer auth (0.82.1).** `ANTHROPIC_AUTH_TOKEN` authenticates against
  Anthropic-compatible gateways that require `Authorization: Bearer`, and covers
  compaction and branch summaries too. Directly relevant to the kiro-gateway setup
  documented in [`docs/guides/kiro-gateway-enterprise-setup.md`](../guides/kiro-gateway-enterprise-setup.md).
- **RPC `clear_queue` (0.84.4).** Retrieves and removes queued steering and follow-up
  messages. Only useful if this app grows a queue surface.
- **Terminating blocked tool calls (0.84.1).** An extension `tool_call` handler can stop
  an all-terminating batch without another model round-trip, via `terminate?: boolean`
  (`dist/core/extensions/types.d.ts:824-826`). Adjacent to the deny path in
  [`before-tool-call-hook.ts`](../../src/main/claude/before-tool-call-hook.ts), but this
  app gates through `beforeToolCall` rather than extension handlers, so it is an alignment
  option and not a migration.
- **`SessionManager.inMemory()` restoration (0.85.0)** and **persistent Claude thinking
  effort (0.85.0)**. Noted; no current need.

---

## 8. Cross-cutting testing & rollout

- **The uplift is already landed and green** (§3). Items below are independently
  shippable on top of it.
- **Recommended order:** S → A → B → E → F, with G and D as investigations and H and I
  folded into adjacent work.
- **Unit-testable without a live provider:** B (synthesize `summarization_retry_*` and
  `session_compact_failed` events against the existing agent-runner event tests) and A
  (stub `getSessionStats()`).
- **Needs a manual check:** S — run `printf '%s\n' "$PI_MODEL" "$PI_SESSION_FILE"` from an
  agent bash call under each sandbox, on both the ordinary and the sudo path. E — confirm
  path containment under a relative `cwd`.
- **Needs a live model call:** D. It cannot be meaningfully unit-tested.
- **Security review required for:** S and E. Neither may be closed by making a check pass;
  if containment turns out weaker than believed, that is the finding.

---

## 9. Non-goals

Unchanged from the predecessor plans, and still accurate:

- **Reading or writing pi session files ourselves.** The app stays a `SessionManager`
  consumer and never parses session JSONL. Item A reinforces this — `getSessionStats()` is
  the supported way to read totals.
- **pi's terminal `/login` OAuth flows.** Reusing the underlying pi-ai OAuth in this app's
  GUI is a separate investigation, not part of an adoption pass.
- **The CLI's user config, catalogs, or terminal UI** (`ARCHITECTURE.md` §4.1).
- **llama.cpp management, Qwen/Kimi subscription providers, grammar-based constrained
  sampling.** Grammar variants remain irrelevant to this app's tools.
- **Fullscreen TUI, Mermaid/LaTeX terminal rendering, transcript search, scrollbars,
  keybindings.** A large share of 0.84–0.85 is terminal UI for the `pi` CLI. This app has
  its own renderer and consumes none of it.

---

## 10. What was dropped, and why

Recorded so these are not rediscovered and re-proposed at the next uplift.

| Dropped                                               | Reason                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0.82 Item A1 — capture compaction usage by hand       | `getSessionStats()` already aggregates it; doing it manually would double-count (§5.1)               |
| 0.80 §5.3 — Mistral prompt-cache accounting check     | Its verification target, the "CH" cache-hit display, was itself removed as buggy and low-value       |
| 0.82 Item C — "expose four, suppress one" via forking | Unnecessary: a `spawnHook` can mask a single variable (§4.2)                                         |
| 0.80 §4.1 items 1–2 — `CONFIG_DIR_NAME` hardening     | Shipped 2026-07-18                                                                                   |
| 0.80 §3.1 — compaction transparency                   | Shipped                                                                                              |
| 0.80 §3.2 — prompt-cache hit visibility               | Deliberately removed 2026-07-17                                                                      |
| 0.80 §5.4 — thinking-level surface                    | Shipped 2026-07-20; design in [`thinking-level-per-model.md`](./archive/thinking-level-per-model.md) |

### Still live elsewhere, not folded in here

Two designs were extracted from the 0.80 plan into their own documents and remain
independent — they are **not** superseded by this plan:

- [`native-project-trust-alignment.md`](./native-project-trust-alignment.md) — Phase 0,
  not started. A security epic spanning five trust surfaces. Note that Item E (§7.1)
  touches the same boundary and should be sequenced with an eye to it.
- [`model-reasoning-override.md`](./model-reasoning-override.md) — Design, not started.

---

## 11. Open decisions

1. **Item S exposure policy.** Keep the four session variables visible to agent bash
   commands, or turn the exposure off? Low stakes either way — `PI_SESSION_FILE` is never
   set here (§4.2). The decision worth making explicitly is whether to add the regression
   test that would catch the day this stops being true (§4.5).
2. **Where a session spend readout belongs**, now that `getSessionStats()` makes the data
   a read rather than a build (§5.1). A product question, not an engineering one.
3. **What actually sticks in Item G.** Which indicator fails to clear during a permission
   wait — the global loading flag or a per-tool trace card? Until that is reproduced, the
   choice between emitting wait events and fixing it renderer-side cannot be made (§7.2).
4. **Item D scope:** does `strict: "prefer"` hold up against real third-party MCP schemas,
   and is observing pi's own `PI_EXPERIMENTAL=1` implementation enough to decide without
   enabling it here?
