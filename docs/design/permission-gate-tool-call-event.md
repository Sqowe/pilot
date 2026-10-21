# Permission Gate on pi's `tool_call` Event — Design

**Created:** 2026-10-20
**Status:** **Phase 0 implemented 2026-10-20** (committed in `3fcab2f8`); §2.5 implemented
2026-10-21, not committed yet. Phase 1 — proposed, not started; no code until it is approved.
**Security classification:** **High.** The gate decides whether an LLM-driven agent may run a
tool on the user's machine; phase 0 changes what pi loads into the main process.
**Author:** AI-assisted design session
**Baseline:** pi 1.3.0 (`@earendil-works/pi-coding-agent` in this repo's `node_modules`).
Every pi line cited below is from that copy.
**Origin:** the 0.87.1 → 1.3.0 uplift,
[`pi-sdk-130-uplift-and-adoption-plan.md`](./pi-sdk-130-uplift-and-adoption-plan.md) §5 and §6.4,
item **P**. Supersedes TECHNICAL_DEBTS #13 ("Simplify `beforeToolCall` hook").

---

## 1. Why

### 1.1 How the gate works today

`installPermissionHook` (`src/main/claude/agent-runner.ts`, from line 1589) reaches into
`(piSession as any).agent`, captures pi's own `agent.beforeToolCall`, and replaces it with a
gate that, in order:

1. blocks repeated reads of the same file (`ReadLoopGuard`, always on);
2. asks `decidePermissionDetailed(sessionId, toolName, input)` — rules, trusted
   directories, MCP tool policy;
3. on `deny` blocks; on `ask` blocks in autonomous mode, otherwise opens the permission
   dialog over IPC, counting open dialogs in `permissionWaitState` so the inactivity timer
   pauses, and fails closed on any malformed or failed answer;
4. on allow, calls the captured hook — pi's, which emits the `tool_call` extension event.

`before-tool-call-hook.ts` detects which hook shape the agent has and **throws** when it
finds none, so a pi change cannot silently remove the gate (13 tests,
`tests/before-tool-call-hook.test.ts`). The gate function itself has no unit test.

### 1.2 What is wrong with it

- **It is a reach-around** into a private object — the last one `AI_MAIN_PROCESS.md` §1
  allows. Its survival depends on pi installing `agent.beforeToolCall` exactly once, in the
  session constructor (`dist/core/agent-session.js:204`, `:322`).
- **Calls made by tools bypass it (new in pi 0.99.0).** A tool can call other tools through
  `ctx.executeTool()`. Those nested calls run `this._beforeToolCall(context, parentId)`
  directly (`agent-session.js:405`, inside `_executeNestedToolCall`, `:388-416`), never
  `agent.beforeToolCall`. Nothing in this app makes nested calls today — `MCPManager`'s
  tools and `MemoryExtension`'s do not use `ctx.executeTool` — but any such tool, or pi's
  codemode or tool_search, would run tools with no permission check at all.
- **Arguments can change after the check.** pi's contract is "to modify arguments, mutate
  `event.input` in place" (`dist/core/extensions/types.d.ts:1089-1091`). Today the gate
  checks the arguments first and only then hands them to pi's hook, whose extension
  handlers may still rewrite them. Harmless while no extension loads — which is not the
  case (§2).

The public replacement is a `tool_call` handler: pi emits it for top-level **and** nested
calls (`agent-session.js:327-347`; `parentToolCallId` set on nested ones).

## 2. Phase 0 — lock down what the resource loader loads (prerequisite)

### 2.1 Finding

The runner builds `DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths,
appendSystemPrompt, noContextFiles: true })` with no `settingsManager`
(`agent-runner.ts:3306-3320`). pi then creates a file-backed one,
`SettingsManager.create(cwd, agentDir)` (`resource-loader.js:247`), whose project trust
defaults to **on**: `projectTrusted = options.projectTrusted ?? true`
(`settings-manager.js:238`). With trust on, for the **workspace the user opened**, pi:

- loads `<workspace>/.pi/extensions/*` into the Electron main process
  (`package-manager.js:2036`) — arbitrary code, before any permission prompt;
- reads `<workspace>/.pi/settings.json`; a `packages` entry that is not installed is
  installed with npm (`package-manager.js:1014`, `resolve()` is called without an
  `onMissing` callback) and its extensions loaded;
- uses `<workspace>/.pi/SYSTEM.md` as the base system prompt and
  `<workspace>/.pi/APPEND_SYSTEM.md` as an appendix (`resource-loader.js:944-965`);
- adds skills from `<workspace>/.pi/skills` and from `.agents/skills` in the workspace and
  its parent folders — outside the app's own skill list, so the per-session "disabled
  skills" filter does not apply to them.

**Verified** on 0.87.1 and 1.3.0 with a probe: a scratch workspace with
`.pi/extensions/probe.ts` (writes a marker file) and `.pi/skills/probe-skill/SKILL.md`,
loaded with the runner's options. The extension's code ran and the skill was listed. The npm
path was read in the source, not run.

### 2.2 Fix

Give the loader an in-memory, untrusted settings manager and turn off discovered extensions
and discovered skills.
**As built:** `src/main/claude/pi-resource-loader.ts` (`piResourceLoaderOptions`,
`createPiResourceLoader`), called from the runner where it used to construct the loader:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: PiSettingsManager.inMemory({}, { projectTrusted: false }),
  noExtensions: true,
  noSkills: true, // added 2026-10-21, §2.4
  additionalSkillPaths,
  appendSystemPrompt,
  noContextFiles: true,
  // phase 1 adds: extensionFactories: [permissionGate] — inline factories still load
});
```

`SettingsManagerCreateOptions.projectTrusted` is public (`settings-manager.d.ts:24-26`).
`src/tests/claude/pi-resource-loader-boundary.test.ts` builds a fixture workspace (an
extension that leaves a marker, a settings file with a package, SYSTEM.md, APPEND_SYSTEM.md,
`.pi/skills`, `.agents/skills`) plus a user-level extension in the agent folder, and checks:
pi's defaults do load the fixture (so the test cannot pass for no reason); the app's loader
runs no extension, takes neither prompt file nor workspace skill, and still loads a skill the
app passes. `PI_OFFLINE=1` is set so a regression cannot reach npm. Removing either option
fails one of the tests (checked by removing each in turn).

### 2.3 What changes for users

| Before                                                                  | After                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workspace `.pi/extensions` run in the main process                      | Not loaded                                                                                                                     |
| Workspace `.pi/settings.json` `packages` installed and loaded           | Not read                                                                                                                       |
| Workspace `.pi/SYSTEM.md` / `APPEND_SYSTEM.md` change the prompt        | Not read                                                                                                                       |
| Workspace `.pi/skills`, ancestor `.agents/skills` added                 | Not added — the app's own project skills (`<workspace>/.skills`, `<workspace>/skills`, `skills-manager.ts:434`) are unaffected |
| `<userData>/claude/settings.json`, `<userData>/claude/extensions/` read | Not read (neither exists today)                                                                                                |
| `~/.agents/skills` (the user's home) added                              | Not added since 2026-10-21 (§2.4)                                                                                              |
| Skills disabled for a session or by a workspace profile still loaded    | Not loaded since 2026-10-21 (§2.4)                                                                                             |

This is a pre-existing hole, independent of the gate move. It can ship on its own, first.

### 2.4 Skills pi found on its own — `noSkills` (2026-10-21)

Two more folders reached every session past the app's skill settings, both found by pi
itself (user-level, not trust-gated — `package-manager.js:2056-2064`):

- **`<agentDir>/skills`** — which here is the runtime skills dir `<userData>/claude/skills`,
  the set Conflict Resolution produces. The app filtered skills disabled for a session (or
  by a workspace profile) out of the paths it passes, but pi read the same folder again,
  unfiltered, and loaded them anyway. Probe: the app passed only `kept`, pi loaded `kept`
  and `session-disabled`. The profiles design (`archive/skill-workspace-profiles.md` §6.1)
  noted pi reads `agentDir` but filtered only the extra paths.
- **`~/.agents/skills`** — the user's home folder shared with other agent tools. Not a
  source of the app's skill system, so Conflict Resolution, global and session disables, and
  pinning never saw it. On the author's machine 11 of its 12 skills were the same files the
  app already links through `~/.claude/skills` (pi drops a second copy of the same file);
  `product-wiki` reached sessions only this way. A skill disabled in the app but also
  present here was loaded from here.

Fix: `noSkills: true` — pi loads only `additionalSkillPaths` (`resource-loader.js:424-426`).
That list is built by `assembleSkillPaths` (`src/main/claude/skill-paths.ts`): the runtime
dir first, because pi keeps the first skill of a name (`skills.js:327-345`) and that dir
holds the copy Conflict Resolution chose; then the raw built-in / configured folders and
plugin folders. The session filter now follows symlinks — `Dirent.isDirectory()` is false for
a link, and the runtime dir is mostly links, so the old filter dropped every linked skill;
it went unnoticed only because pi re-read the folder itself.

Tests: `src/tests/claude/skill-paths.test.ts` (order, de-duplication, the symlink case,
prefixed IDs) and three more cases in the boundary test (a stand-in HOME's
`~/.agents/skills` and an `agentDir/skills`-only skill are not loaded; the chosen copy wins a
name clash). Removing `noSkills`, or putting the runtime dir after the raw folders, fails a
test (checked).

### 2.5 Skills disabled in the settings — filtered at assembly (2026-10-21)

Open question 4 (§6) — a globally disabled built-in still loading — turned out to have more
routes than the raw built-in folder, all probe-verified on 1.3.0:

- the raw built-in folder, and the configured folder when a custom skills path is set, are
  passed whole after the runtime dir (`legacySkillPaths`): runtime dir with `docx`, built-in
  folder with `docx` and `pdf` → pi loads both;
- `SkillsManager.importUserSkills` (`skills-manager.ts`, run by every `listSkills()`, e.g.
  opening Settings → Skills) links every `~/.claude/skills` entry into the runtime dir again
  with no disable or conflict check; removing a link and listing once more brings it back.
  The storage watcher does not notice: its signature counts real directories only;
- `removeRuntimeSkillEntry` refuses to delete a real directory of a non-built-in skill — a
  user skill copied because linking failed stays and loads;
- `skillsSignature` was the folder list, unchanged when a link left a folder, so a cached
  session kept a disabled skill until the app restarted.

Passing only the runtime dir (the first proposal) closes none of the last three, and loses
what the raw folders cover: a built-in whose link and copy failed (the copy error is not
caught, and `_skillsSetupDone` is already set), skills put into the configured folder since
the last sync, and symlinked entries there, which the runner's sync skips
(`Dirent.isDirectory()` is false for a link). Chosen instead (variant B, approved
2026-10-21): `assembleSkillPaths` takes `globallyDisabled` (`skillConflictConfig.disabledSkills`)
and drops those names from every folder, like session disables, and always expands folders
into their entries (sorted; dot entries and `node_modules` skipped and top-level `.md` files
kept, as pi's own walk does), so the list — the signature — changes with the set.

Tests: the global-disable case in `skill-paths.test.ts` and in the boundary test (a raw
folder unfiltered does load the disabled skill; filtered it does not), the dot-entry case,
and a signature case. Checked one breakage at a time against the whole suite: dropping the
global filter, returning the bare folders when nothing is disabled, not skipping dot
entries, and not following symlinks each fail tests (3, 5, 1 and 6). The runner passing
`[]` instead of the settings' list survives — no test builds a `ClaudeAgentRunner`; the
manual pass checks it in the `Skill paths for pi ResourceLoader` log line.

## 3. Phase 1 — the gate as an inline extension

### 3.1 Shape

New module `src/main/claude/permission-gate-extension.ts`:

```ts
export function createPermissionGateExtension(deps: {
  sessionId: string;
  cwdRef: { value: string };
  requestPermission?: RequestPermission;
  // plus the state the gate touches today: permissionWaitState, activity-timer hooks,
  // currentRunId — passed in, not reached through the runner
}): InlineExtension {
  return {
    name: 'sqowe-permission-gate',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', async (event, ctx) => decide(event, ctx));
    },
  };
}
```

`decide` is today's gate body with the inputs renamed — `toolCall.name` → `event.toolName`,
`args` → `event.input`, `toolCall.id` → `event.toolCallId` — and it returns the same
`{ block, reason }` (`ToolCallEventResult`, `types.d.ts:1089`). `event.parentToolCallId`
goes into the log line and the permission dialog, so the user can see a call came from
another tool. No delegation step is needed: pi runs the remaining handlers itself, and with
phase 0 there are none.

### 3.2 Registration and fail-closed check

- The factory is built before `createAgentSession` (it needs only `sessionId` and a `cwdRef`
  created earlier than today) and passed in `extensionFactories`.
- pi builds the extension runner in the session constructor from the loader's extensions
  (`agent-session.js:2954`); `bindExtensions()` is not needed for `tool_call`.
- `_beforeToolCall` returns `undefined` — **allow** — when no `tool_call` handler exists
  (`agent-session.js:329-331`). So right after `createAgentSession` the runner must check
  `piSession.extensionRunner.hasHandlers('tool_call')` (public, `extensions/runner.d.ts:151`)
  and that `resourceLoader.getExtensions().errors` holds nothing for the gate; otherwise
  dispose the session and throw — the same "refuse to start" as today.
- A handler that throws blocks the call: pi rethrows (`agent-session.js:341-346`) and the
  agent loop turns it into an error result without running the tool
  (`pi-agent-core/dist/agent-loop.js:490-535`). Explicit fail-closed returns stay anyway.

### 3.3 What stays the same

- Handlers are awaited in order and the first `block` wins (`extensions/runner.js:957-972`),
  inside the same `beforeToolCall` slot the gate uses now — so the async permission dialog
  waits exactly where it waits today, and the known renderer-desync note in
  `AI_MAIN_PROCESS.md` §1 still applies.
- `ctx.signal` is the run's abort signal (`types.d.ts:239-240`) if a wait ever needs it.
- The bash wrappers (default timeout, sudo) are tool wrappers, not part of the gate; they
  do not move.

### 3.4 What is removed

`installPermissionHook`'s agent access, `before-tool-call-hook.ts` and its 13 tests, the
"one reach-around remains" paragraph in `AI_MAIN_PROCESS.md` §1, TECHNICAL_DEBTS #13.

## 4. Tests

- **Unit:** `decide` — read-loop block, rule deny, autonomous block, ask → allow /
  allow_always / deny / deny_with_suggestion, malformed and failed answers fail closed,
  wait counting with a stale `runId`. (Today none of this is tested directly.)
- **Session-level, no network:** a real `createAgentSession` on pi-ai's faux provider
  (`registerFauxProvider` from `/compat`; scripted turns with `fauxToolCall`, `setResponses`,
  `pi-ai/dist/providers/faux.d.ts`). A scripted `bash` call must reach `requestPermission`
  and not run on deny. A test tool that calls `ctx.executeTool('bash', …)` must reach the
  gate with `parentToolCallId` set — this is the case today's gate misses. Whether the faux
  provider plugs into `ModelRuntime` cleanly is to be proven first.
- **Phase 0 regression:** the probe above as a test — a fixture workspace with
  `.pi/extensions/` and `.pi/skills/`; the loader built by the runner must list only the
  gate and run nothing from the workspace.
- **Fail-closed:** a loader whose gate factory throws must make session creation throw.

## 5. Rollout

1. **Phase 0** — loader lock-down + its regression test. **Done 2026-10-20.**
2. **Phase 1** — gate moves to `tool_call`; the reach-around and `before-tool-call-hook.ts`
   go. Its own change.
3. **Then** — and only then — items that make nested calls possible (`tool_search` with
   deferred MCP tools, codemode) can be considered.

Manual pass for each phase: permission prompt and each answer, a denied rule, autonomous
mode, the read-loop block, an MCP tool with a policy, sudo, stop during an open dialog.

## 6. Open questions

1. ~~**`~/.agents/skills`.**~~ Resolved 2026-10-21: no longer loaded (§2.4). To use one of
   its skills in the app, link it into `~/.claude/skills`, which the app manages.
2. **Workspace `.agents/skills` / `.pi/skills`.** Does anyone rely on pi picking these up?
   If so, add them to the app's own project skill sources rather than re-enabling trust.
3. ~~**Phase 0 alone** changes which skills load — confirm that is acceptable.~~ Accepted
   2026-10-20 together with the go-ahead for phase 0.
4. ~~**A globally disabled built-in still loads.**~~ Fixed 2026-10-21 by filtering at
   assembly (§2.5). Not fixed by it: the Power button on each skill card and the automatic
   disabling of `cowork-memory` change only an in-memory flag of `SkillsManager`, which the
   runner never reads (`skillsAdapter` is `undefined`, `session-manager.ts:212`) — being
   decided separately.
