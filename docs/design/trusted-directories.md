# Trusted Directories (Write Zone) — Design & Implementation Plan

**Status:** Implemented 2026-10-03 (phases 1–8). Where the build differs from this design,
§15 says how and why. Not yet done by hand: the `pi -e` checklist in the extension README, and
copying the rebuilt extension into `~/.pi/agent/extensions/`.
**Date:** 2026-10-03
**Owner:** @obodnikov
**Security classification:** **High.** This changes a gate that decides what an LLM-driven agent
may do on the user's machine.
**Supersedes in part:** [file-tool-path-permissions.md](file-tool-path-permissions.md) — see §12.
**Related:** [BASH_COMMAND_RESTRICTIONS.md](../../BASH_COMMAND_RESTRICTIONS.md),
[pi-extensions/bash-restrictions/README.md](../../pi-extensions/bash-restrictions/README.md),
[archive/pi-bash-restrictions-extension.md](archive/pi-bash-restrictions-extension.md),
[native-project-trust-alignment.md](native-project-trust-alignment.md),
`node_modules/@earendil-works/pi-coding-agent/docs/{security,extensions,usage}.md`

---

## 1. Summary

One new setting, `trustedDirectories`, lists the directories the agent may write to without
being asked. Four changes hang off it, shared by the Electron app and the standalone `pi`
extension:

1. **The bash engine learns to read multi-line commands and here-documents.** Today any line
   break outside quotes forces a prompt. This change is unconditional (not tied to the setting).
2. **Bash: visible write targets are checked.** An output redirection or a `tee` operand that
   lands outside the listed directories asks.
3. **`write` / `edit` tools are checked.** A target outside the list asks; a target inside does
   not.
4. **The prompt says why it appeared.**

It is **not a sandbox**. It checks what can be read from a command's text and from a tool's
`path` argument. What a program writes on its own is invisible to it (§11).

---

## 2. Findings that led here (verified 2026-10-03)

### 2.1 The prompt that started the discussion

A command of the shape `cd <project> && python3 - <<'PY' … PY` prompted in a project whose
config was `"trusted": ["*"]`. The cause was the line break, not any file protection:

- A line break outside quotes returns "unsupported syntax"
  ([engine.ts:278](../../src/shared/bash-restrictions/engine.ts#L278)), which the decision
  turns into `ask` ([engine.ts:364-366](../../src/shared/bash-restrictions/engine.ts#L364-L366)).
- The dialog shows only the command, with control characters replaced by spaces
  ([extension.ts:86-90](../../pi-extensions/bash-restrictions/extension.ts#L86-L90),
  [extension.ts:183-187](../../pi-extensions/bash-restrictions/extension.ts#L183-L187)) — so the
  line breaks, and therefore the reason, are not visible to the user.

### 2.2 What the engine decides today

Results of calling `decideBashPermission` from
[engine.ts](../../src/shared/bash-restrictions/engine.ts) directly:

| Command                                                         | Lists                        | Result |
| --------------------------------------------------------------- | ---------------------------- | ------ |
| `python3 - <<'PY'` + body + `PY` (here-document)                | trusted `*`                  | ask    |
| same code as `python3 -c '…'`, line breaks inside single quotes | trusted `*`                  | allow  |
| `cd /tmp ; ls -la`                                              | trusted `*`                  | allow  |
| the same two commands separated by a line break                 | trusted `*`                  | ask    |
| `cat > notes.txt <<EOF` + body + `EOF`                          | trusted `*`                  | ask    |
| `grep foo <<< "some text"` (here-string, one line)              | trusted `*`                  | allow  |
| `echo x > /etc/hosts`                                           | trusted `*`                  | allow  |
| `echo "export X=1" >> ~/.zshrc`                                 | trusted `echo *`, `cat *`, … | allow  |
| `cd /etc && echo x > hosts`                                     | trusted `cd *`, `echo *`, …  | allow  |
| `bash -c 'rm -rf ~/Documents'`                                  | trusted `*`, denied `rm`     | ask    |
| `python3 -c 'print("abc".find("b"))'`                           | trusted `*`, denied `find`   | ask    |
| same                                                            | trusted `*`, denied `find /` | allow  |
| `find / -name x`                                                | trusted `*`, denied `find /` | ask    |
| `find . -name x`, `find /Users/me -name x`                      | trusted `*`, denied `find /` | allow  |

Two conclusions:

- **The multi-line prompt adds no protection.** The same code written on one line already
  passes the same checks.
- **Where output goes is not checked at all.** The engine's only redirection-related code tells
  `2>&1` apart from the background `&`
  ([engine.ts:230-236](../../src/shared/bash-restrictions/engine.ts#L230-L236)).

### 2.3 File tools

- `pi` has no permission prompts of its own: it "intentionally does not include … permission
  popups" (`docs/usage.md:309`). In `pi`, `write` and `edit` run unasked today.
- The app asks on every `write` and `edit` by default
  ([permission-rules-store.ts:39-48](../../src/main/config/permission-rules-store.ts#L39-L48)).
- Neither host checks a file tool's path against the workspace
  ([pi-sdk-085-feature-adoption-plan.md §7.1.1](archive/pi-sdk-085-feature-adoption-plan.md)).

So a bash-only write check would leave `write` as an open door next to it in `pi`.

### 2.4 pi's project trust is a different mechanism

`docs/security.md`: project trust "controls whether pi loads project-local settings, resources,
packages, and extensions. It is not a sandbox and it does not restrict what the model can ask
tools to do." The same file states pi has no built-in sandbox.

This design uses project trust exactly where the extension already uses it — as the condition
for reading the project config file
([extension.ts:258-262](../../pi-extensions/bash-restrictions/extension.ts#L258-L262),
[config.ts:241](../../pi-extensions/bash-restrictions/config.ts#L241)). It does **not** read or
write `~/.pi/agent/trust.json`; the reasons are in the 2026-09-09 note at the top of
[native-project-trust-alignment.md](native-project-trust-alignment.md).

### 2.5 How others handle the same problem

| Tool                             | Approach                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                      | Checks redirect targets (`>`, `>>`, `2>`) and `tee` destinations against its working directories; treats line breaks as command separators; does not treat here-documents as file targets. Describes the whole mechanism as "a permission gate, not a sandbox". |
| Codex                            | Writable area = working directory + `/tmp` + `$TMPDIR` + `writable_roots`, enforced by the operating system.                                                                                                                                                    |
| pi `examples/extensions/sandbox` | `"allowWrite": [".", "/tmp"]`, enforced by the operating system through `@anthropic-ai/sandbox-runtime`.                                                                                                                                                        |

Sources: Claude Code — <https://code.claude.com/docs/en/permissions> (sections "Redirections" and
"Compound commands") and <https://code.claude.com/docs/en/agent-sdk/secure-deployment>; Codex —
<https://learn.chatgpt.com/docs/config-file/config-sample> (`[sandbox_workspace_write]`); pi —
`node_modules/@earendil-works/pi-coding-agent/examples/extensions/sandbox/index.ts`.

The list format chosen here (`["./", "/tmp"]`) is deliberately the same shape, so it can feed
operating-system enforcement later without a second setting.

---

## 3. Decisions (locked 2026-10-03 by @obodnikov)

| #   | Decision                      | Resolution                                                                                                                                                                       |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Meaning of the list for bash  | It **only restricts** where an already-trusted command may visibly write. It never turns an untrusted command into a trusted one.                                                |
| D2  | Project config file           | May add only directories **inside the project**. Directories outside it (`/tmp`, …) come from the global file only.                                                              |
| D3  | `denied` and here-documents   | `denied` patterns are matched against here-document bodies, **always**.                                                                                                          |
| D4  | One list, one module          | Bash and the file tools share one directory list and one path module. This document replaces the config model of [file-tool-path-permissions.md](file-tool-path-permissions.md). |
| D5  | First version covers writes   | Bash visible write targets, `write`, `edit`. Reading (`read`, `grep`, `find`, `ls`, `glob`, `cat …`) is out of scope.                                                            |
| D6  | Hosts                         | `pi` extension and Electron app in the same piece of work.                                                                                                                       |
| D7  | Where the setting lives       | Key `trustedDirectories` in the existing bash-restrictions settings (`.pi/bash-restrictions.json`, `~/.pi/agent/bash-restrictions.json`, and the app's settings).                |
| D8  | Opt-in                        | Empty or absent list → the write checks are off and decisions are what they are today (apart from change 1 in §1, which is unconditional).                                       |
| D9  | List set, command lists empty | The bash write check still runs, on every command. A command the scanner cannot read asks; a command with no visible outside write behaves as it does today.                     |
| D10 | The gate's own config files   | A write to the project or the global `bash-restrictions.json` **always asks**, whatever the list says — through `write`, `edit`, or a visible bash target.                       |
| D11 | App settings placement        | A third field in the existing Bash Commands panel, with a note that the list also governs `write` and `edit`.                                                                    |
| D12 | Over-broad entries            | An entry that resolves to the file-system root or to the home directory itself is not accepted. The setting stays on: with no accepted entry left, every write asks.             |

**Why D1 and the file tools differ.** A `write` call is fully described by its path, so "inside
a trusted directory" is a complete answer. A bash command can do anything; the directory it
runs in says nothing about what it does. Hence: for file tools the list decides; for bash it
only adds a condition on top of the command lists.

**D3 in practice.** Without it, `bash <<'EOF'` + `rm -rf ~/Documents` + `EOF` would pass with
`trusted: ["*"]` once line breaks stop prompting, although the one-line form
`bash -c 'rm -rf ~/Documents'` asks today (§2.2). The cost is prompts when script text contains
a denied word, e.g. `.find(` with `find` in `denied`. That cost exists today for one-line
`python3 -c`. Narrower entries avoid it: `find /` still catches `find / -name x` but not
`.find(` (§2.2).

---

## 4. Behaviour

### 4.1 The setting

```jsonc
// ~/.pi/agent/bash-restrictions.json   (global)
{
  "trusted": ["ls *", "cat *"],
  "denied": ["rm", "sudo"],
  "trustedDirectories": ["./", "/tmp"],
}

// <project>/.pi/bash-restrictions.json  (project, read only when the project is trusted)
{
  "trusted": ["*"],
  "denied": ["brew", "install"],
  "trustedDirectories": ["./build-cache"],  // inside the project: accepted
}
```

| Entry form                 | Resolved against                |
| -------------------------- | ------------------------------- |
| relative (`./`, `out/tmp`) | the session's working directory |
| `~`, `~/x`                 | the user's home directory       |
| absolute                   | as written                      |

Every entry is then resolved to its real path (symbolic links followed).

**Merge (pi extension):** global ∪ project, after dropping project entries that resolve outside
the project directory (D2). The project file is still skipped entirely for an untrusted project
([config.ts:241](../../pi-extensions/bash-restrictions/config.ts#L241), unchanged).

**App:** one list in the app settings; relative entries resolve against the session's workspace
(`sessionCwdMap`,
[permission-rules-store.ts:69](../../src/main/config/permission-rules-store.ts#L69)).

**Entries that are not accepted.** Two kinds are dropped: a project-file entry that resolves
outside the project (D2), and any entry that resolves to the file-system root or to the home
directory itself (D12) — which also covers `./` when the session runs in the home directory.
Dropping never switches the setting off: if the list as written was non-empty, the checks stay
on, and with no accepted entry left every write asks. Dropped entries are reported once per
session (pi: a warning at session start; app: a note under the field).

**Always ask (D10).** A target whose real path is the project config file or the global one
(`resolveProjectConfigPath` / `resolveGlobalConfigPath`,
[config.ts:197-210](../../pi-extensions/bash-restrictions/config.ts#L197-L210)) asks even when
it lies inside a trusted directory. Otherwise the agent could rewrite
`<project>/.pi/bash-restrictions.json` unasked and loosen the gate at the next reload. The app
applies the same rule to its own settings file; take that path from the store instance
([config-store.ts:935-936](../../src/main/config/config-store.ts#L935-L936)) rather than
hard-coding it.

### 4.2 Decision order — bash

1. The command lists decide as today (with §5 applied). `ask` stays `ask`.
2. If the result is `allow` — or `null` because both lists are empty (D9) — and
   `trustedDirectories` is non-empty, the write-target check (§6) runs:
   - the command cannot be read (only reachable when both lists are empty, since otherwise
     step 1 already asked) → `ask`;
   - a target outside the list, one that cannot be determined, or one of the gate's own config
     files (D10) → `ask`;
   - otherwise the result of step 1 stands.

The list can therefore only add prompts for bash; it never removes one (D1).

### 4.3 Decision order — `write` and `edit`

Path = the tool's `path` argument (`dist/core/tools/write.d.ts`, `edit.d.ts` in pi 0.85.1),
resolved as in §7.

| Host | Inside                                                                           | Outside or undeterminable                                       |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| pi   | no prompt (as today)                                                             | `ask` dialog; blocked when there is no UI                       |
| App  | `allow`, unless the user's own rule for that tool is `deny` — then `deny` stands | `ask`, evaluated **before** the session's "Allow always" memory |

The app branch sits next to the bash branch in `decidePermission`
([permission-rules-store.ts:245-250](../../src/main/config/permission-rules-store.ts#L245-L250)),
ahead of the session memory lookup
([permission-rules-store.ts:281-282](../../src/main/config/permission-rules-store.ts#L281-L282)),
for the reason given in the comment above the bash branch: one "Allow always" click must not
cover writes outside the list. In unattended sessions an `ask` is already turned into a block
([agent-runner.ts:1652-1674](../../src/main/claude/agent-runner.ts#L1652-L1674)), so an outside
write there is blocked, not silently allowed.

A session with no known working directory cannot resolve relative entries → `ask`. A target
that is one of the gate's own config files counts as outside (D10).

### 4.4 Expected results (design intent, not yet measured)

With `trusted: ["*"]` and `trustedDirectories: ["./", "/tmp"]`:

| Action                                          | Today (pi) | After                                   |
| ----------------------------------------------- | ---------- | --------------------------------------- |
| `cd <project> && python3 - <<'PY' … PY`         | ask        | allow, if the body has no denied word   |
| `echo x > ./out.txt`, `echo x > /tmp/a.txt`     | allow      | allow                                   |
| `echo x >> ~/.zshrc`                            | allow      | ask                                     |
| `cd /etc && echo x > hosts`                     | allow      | ask                                     |
| `make \| tee /var/log/build.log`                | allow      | ask                                     |
| `echo x > "$OUT/file"`                          | allow      | ask (target cannot be determined)       |
| `write` to `<project>/src/a.ts`                 | no prompt  | no prompt                               |
| `write` to `~/.zshrc`                           | no prompt  | ask                                     |
| `python3 script.py` that writes anywhere itself | allow      | allow — not visible from the text (§11) |

### 4.5 The prompt names its reason

The engine gains a variant that returns a reason alongside the decision; the existing
`decideBashPermission` signature stays as it is, so current callers are unaffected. Reasons:
denied pattern (which), sub-command not trusted (which), syntax that cannot be read (which),
write outside the trusted directories (path), write target that cannot be determined (word).

The `pi` dialog adds the reason as its second line. In the app the reason travels with the
permission request as a structured value (`src/shared/permission-reason.ts`) and is worded in
the renderer, so it is localized (§15).

---

## 5. Reading multi-line commands

Why this is safe: every multi-line form below has a one-line form that already passes the same
checks (§2.2). The prompt it removes is a formality, provided the rules are implemented exactly
and anything unclear still asks.

**R1 — line break as separator.** A line break outside quotes that is not backslash-escaped
separates commands exactly like `;`. Any carriage return still asks, including `\r\n`.

**R2 — here-documents** (`<<` and `<<-`; the here-string `<<<` already passes and is untouched):

- The body is the lines after the operator's line, up to the first line equal to the delimiter
  (for `<<-`, after removing leading tabs). The rest of the operator's line still belongs to the
  command — `cat <<EOF > out.txt` has a redirect to check.
- Delimiter quoted or escaped (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) → the body is literal text.
- Delimiter unquoted → the shell expands the body, so a backtick or `$(` in it asks — the same
  rule the engine applies inside double quotes
  ([engine.ts:250-261](../../src/shared/bash-restrictions/engine.ts#L250-L261)).
- No terminating line → ask. More than one here-document on a line → ask (first version).
- The body stays part of its sub-command's text, so `denied` is matched against it (D3).
  Operators inside the body do not split the command.

**R3 — comments.** A comment ends at the line break, but a quote character inside it would
otherwise open a "quoted" region that swallows the following lines and hides their redirects:

```bash
# don't worry
echo x >> ~/.zshrc   # it's fine
```

Rules for the first version:

- A line whose first non-blank character is `#`, starting right after a separator line break,
  is dropped. This does not apply after a backslash-continued line, inside quotes, or inside a
  here-document body.
- A line break while `${`, `$((` or `((` is still open → ask.
- Any other `#` that begins a word in a multi-line command → ask. In a one-line command `#`
  keeps today's treatment as ordinary text: nothing after it runs, so misreading it cannot hide
  an executed command.

**R4 — one scanner.** Today two separate hand-written scanners read the command:
`splitBashSubCommands`
([engine.ts:41-104](../../src/shared/bash-restrictions/engine.ts#L41-L104)) and
`containsUnsupportedShellSyntax`
([engine.ts:215-328](../../src/shared/bash-restrictions/engine.ts#L215-L328)). Adding
here-documents, comments and target extraction to each separately invites them to disagree, and
a disagreement between what the check reads and what the shell runs is the whole class of
bypass. Replace them with a single pass that yields sub-commands, their words, their
redirections and their here-documents; keep both exported names as thin wrappers so the
existing suites keep their meaning.

**The property to hold:** text the shell executes must never be classified as inert. Inert
regions are exactly: single-quoted strings, bodies of quoted-delimiter here-documents, and
dropped comment lines. Where one of those ends is the security-critical part of the scanner.

**No parsing library.** The extension bundle marks every npm package external
([build-pi-extension.mjs:39](../../scripts/build-pi-extension.mjs#L39)), so a dependency of the
engine would be missing where `pi` loads the extension; and the engine has no dependencies
today.

---

## 6. Finding visible write targets

A pure function over the scanner's output; no file-system access.

**T1 — output redirections.** `>`, `>>`, `&>`, `&>>`, `N>`, `N>>`, `<>`, and `>&word` /
`N>&word` when `word` is neither a number nor `-` (that form writes a file; the current
`isRedirectionAmp` treats every `>&` as descriptor duplication, which is right for the syntax
guard but must not make the extractor skip the target). Not targets: `N>&M`, `N>&-`,
`/dev/null`, `/dev/stdout`, `/dev/stderr`.

**T2 — `tee`.** In a sub-command containing the word `tee` (or a path ending in `/tee`), every
following non-option word is a target. Over-reporting (`echo tee /etc/x`) only adds a prompt.

**T3 — directory changes.** `cd <word>` standing as a whole sub-command joined by `&&`, `;` or a
line break moves the base for later relative targets; `cd` with no operand moves it to the home
directory. Any other shape — `cd -`, `pushd`/`popd`, `cd` inside a pipeline or after `||`, an
operand that cannot be determined — makes later relative targets undeterminable. Absolute
targets are unaffected.

**T4 — words.** Quotes are removed. `~` and `~/…` → home; `$HOME` and `${HOME}` → home; `$PWD`
→ the current base. A word containing any other `$`, a backtick, `~user`, or a pattern or brace
character (`*`, `?`, `[`, `{`) is undeterminable.

**T5 — result.** No targets → nothing to object to. Any target outside → `ask`, naming the
first. Any undeterminable target → `ask`.

**Not covered** (stays under `denied` only): path operands of `cp`, `mv`, `rm`, `mkdir`,
`touch`, `ln`, `sed -i`, `sort -o`, `dd of=`, `curl -o`, `git -C`, and anything a program writes
by itself.

---

## 7. Path resolution (shared module)

New module `src/shared/path-permissions/`, under the same constraint
[AI_MAIN_PROCESS.md §12](../../AI_MAIN_PROCESS.md) sets for `bash-restrictions/`:
Node-standalone, no electron, no pi-ai, no app config. It is **not** renderer-safe (it uses
`node:fs`); no renderer code may import it. `src/shared/` currently contains no `node:` imports
at all, so §12's table needs a new row.

- **Containment.** `isPathWithinRoot(targetPath, rootPath, caseInsensitive)` and
  `normalizePathForContainment` move here from
  [path-containment.ts](../../src/main/tools/path-containment.ts); the old file re-exports
  them, so its ten importers under `src/main/` are untouched. The Lima and WSL agents carry
  their own copies and are left alone.
- **Tool paths must be resolved the way pi resolves them.** pi's `write` and `edit` call
  `resolveToCwd(path, ctx?.cwd || cwd)` (`dist/core/tools/write.js:32`, `edit.js:95`), which is
  `resolvePath` from `dist/utils/paths.js` with unicode-space normalisation and `@`-prefix
  stripping, plus: Git Bash / MSYS / Cygwin / WSL drive paths converted on Windows, `~` and `~/`
  expanded, `file://` URLs accepted, then `path.resolve`. pi does not export this
  (`dist/index.d.ts`), so it is mirrored. If the check resolved the string differently from the
  tool, it would approve one path while the tool wrote another. A test pins the mirror; it must
  be re-checked on every pi upgrade, like the thinking-level clamp.
- **Real paths.** The target may not exist yet: resolve the real path of its longest existing
  ancestor, then append the rest. Roots are resolved the same way. On macOS `/tmp` is a link to
  `/private/tmp`; without resolving both sides a `/tmp` entry never matches.
- **Case.** Compare case-insensitively on Windows and macOS. Whether `realpath` returns on-disk
  case on macOS is to be verified in Phase 1.

---

## 8. Files

| Area         | File                                                                                                                                                      | Change                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shared       | `src/shared/path-permissions/{containment,resolve,zone,index}.ts`                                                                                         | new                                                                                                                                     |
| Shared       | [path-containment.ts](../../src/main/tools/path-containment.ts)                                                                                           | becomes a re-export                                                                                                                     |
| Shared       | [engine.ts](../../src/shared/bash-restrictions/engine.ts)                                                                                                 | single scanner; R1–R3; decision-with-reason                                                                                             |
| Shared       | `src/shared/bash-restrictions/write-targets.ts`                                                                                                           | new (§6)                                                                                                                                |
| Shared       | [settings.ts](../../src/shared/bash-restrictions/settings.ts)                                                                                             | `trustedDirectories` field + normaliser (the parity rule at lines 10-13)                                                                |
| pi extension | [config.ts](../../pi-extensions/bash-restrictions/config.ts)                                                                                              | read the key from both files; D2 filter; merge                                                                                          |
| pi extension | [extension.ts](../../pi-extensions/bash-restrictions/extension.ts)                                                                                        | pass `ctx.cwd`; handle `write` / `edit` `tool_call`; tool-agnostic dialog with reason                                                   |
| App (main)   | [config-store.ts](../../src/main/config/config-store.ts) (191-195, 416-418, 1560-1561, 2062)                                                              | new persisted field                                                                                                                     |
| App (main)   | [main/index.ts](../../src/main/index.ts) (1020, 5286-5305)                                                                                                | hydrate at start; accept in `settings.update`                                                                                           |
| App (main)   | [permission-rules-store.ts](../../src/main/config/permission-rules-store.ts)                                                                              | list state + setter; bash branch passes the session directory; new `write` / `edit` branch                                              |
| App (UI)     | [types/index.ts](../../src/renderer/types/index.ts), [store/index.ts](../../src/renderer/store/index.ts), [useIPC.ts](../../src/renderer/hooks/useIPC.ts) | new field alongside `bashTrustedCommands` / `bashDenylist`                                                                              |
| App (UI)     | [SettingsBashCommands.tsx](../../src/renderer/components/settings/SettingsBashCommands.tsx)                                                               | third textarea (D11)                                                                                                                    |
| App (UI)     | `src/renderer/i18n/locales/{en,zh,ru,hu}.json`                                                                                                            | new strings; `bashCommands.safetyNote` no longer lists line breaks                                                                      |
| Docs         | [BASH_COMMAND_RESTRICTIONS.md](../../BASH_COMMAND_RESTRICTIONS.md), extension README, `docs/wiki/features/bash-restrictions.md`                           | new behaviour; the "always asks" table loses the line-break row                                                                         |
| Docs         | [ARCHITECTURE.md](../../ARCHITECTURE.md) §4.4, §4.7; [AI_MAIN_PROCESS.md](../../AI_MAIN_PROCESS.md) §7, §12                                               | matching order; new shared module. ARCHITECTURE.md:481 also still names the bundle `bash-restrictions.mjs`; the build emits a directory |

`scripts/build-pi-extension.mjs` should need no change: relative imports from `src/shared/` are
bundled and `node:*` is external. The existing bundle test confirms it.

---

## 9. Phases — unit tests in every phase

Each phase ends with `npm run typecheck` and `npm test` green.

1. **Shared path module.** Containment relocation with re-export; resolver; zone classifier.
   Tests: inside / outside / boundary / `..`; link pointing outside; target that does not exist
   yet; `/tmp` on macOS; the pi-resolution mirror; existing `path-containment` tests unchanged.
2. **Engine — multi-line reading.** Single scanner; R1–R3. Tests: every row of §2.2; the
   adversarial set in §10. The tests that pin "line break → ask" are changed deliberately:
   [bash-command-control.test.ts:201](../../tests/bash-command-control.test.ts#L201),
   [bash-restrictions-engine.test.ts:182](../../tests/bash-restrictions-engine.test.ts#L182) and
   line 492.
3. **Engine — write targets and setting.** `write-targets.ts`; `trustedDirectories` normaliser;
   decision-with-reason. Tests: T1–T5 one by one; §4.4 rows; list empty → results identical to
   Phase 2; list set with both command lists empty (D9); over-broad entries and the "all
   entries dropped → everything asks" case (D12).
4. **File-tool decision.** One shared function for `write` / `edit`. Tests: inside, outside,
   relative, `~`, link, no working directory; the gate's own config files, also reached
   through a link (D10).
5. **pi extension.** Config merge with the D2 filter; untrusted project; `write` / `edit`
   handling; dialog reason; headless block; warning for dropped entries. Tests extend the four
   `pi-bash-extension-*` suites.
6. **App, main process.** Store, hydration, `settings.update`, both branches in
   `decidePermission`, precedence against session memory and against a `deny` rule. Decide here
   whether the reason reaches the app dialog (§4.5).
7. **App, UI.** Textarea, four locales, renderer store round-trip.
8. **End to end and documents.** Real temporary directories with a link escaping them, through
   config → engine → dialog for both hosts; documents in §8; rebuild the extension and reinstall
   it (the copy `pi` actually runs lives in `~/.pi/agent/extensions/` and is replaced by hand).

---

## 10. Review checklist

Invariants — a change that breaks any of these is rejected:

- For bash, the list never turns a lists-`ask` into `allow` (D1).
- `denied` still wins, including inside here-document bodies (D3).
- Anything that cannot be read asks: unterminated here-document, unclosed quote, undeterminable
  target word, unresolvable path, unknown working directory.
- An untrusted project's file is not read; a trusted project's file cannot add an outside
  directory (D2).
- In the app, an outside-write `ask` is decided before session "Allow always" memory, in the
  main process, never in the renderer.
- With no UI, `ask` blocks (`pi` headless; app unattended sessions).
- With `trustedDirectories` empty, decisions equal those of the engine after Phase 2.
- A list that was written non-empty never behaves as "off", even if every entry was dropped
  (D12); a dropped entry never widens the zone.
- A write to the gate's own config files asks even inside a trusted directory (D10).
- The extension stays out of the Electron main bundle; the shared modules import neither
  electron nor pi-ai.

Adversarial tests the scanner must pass (each must end in `ask`):

- comment containing a quote character, followed by a line with an outside redirect (§5, R3);
- backslash-continued line followed by a line starting with `#` and then `; rm -rf x`;
- `${x:-` + line break + `#foo}; rm -rf y`;
- here-document with unquoted delimiter whose body contains `$(…)`;
- here-document whose terminator is missing or indented without `<<-`;
- `cmd >& /etc/x` and `cmd 2>& /etc/x`;
- `cd /etc && echo x > hosts`; `cd "$D" && echo x > f`;
- a link inside the project pointing outside, written through with `write` and with `>`.

---

## 11. Risks and limits

- **It is not a sandbox.** A program's own writes are invisible (`python3 script.py`,
  `npm run …`, `git …`). Only operating-system enforcement closes that; the list's format was
  chosen so it can drive it later (§2.5).
- **Target created by the same command.** `ln -s /etc x && echo a > x/hosts` — at check time `x`
  does not exist, so the path resolves inside. Known limit of checking before running.
- **Path operands of ordinary commands** are not examined (§6).
- **D10 covers two files, not the config directory.** A program can still rewrite
  `bash-restrictions.json` invisibly (`sed -i`, a script), and other files under `.pi/` —
  `settings.json`, `extensions/` — are pi's own trust surface, not protected by this rule.
- **Mirror drift.** pi may change how it resolves tool paths; the pinned test and the upgrade
  re-check are the guard (§7).
- **Windows.** Bash there is Git Bash by default (`docs/windows.md`); target words may be
  `/c/…`, `C:/…` or `C:\…`. Forms that are not recognised must end in `ask`, never in "inside".
  pi's optional `powershell` tool is not gated by this extension at all — unchanged, but worth
  stating.
- **App sandbox execution.** The WSL / Lima path is off by default
  ([ARCHITECTURE.md:343](../../ARCHITECTURE.md)) and uses `/workspace/…` paths
  ([workspace-path.ts:11-15](../../src/shared/workspace-path.ts#L11-L15)). This design assumes
  host paths; revisit if sandbox execution is switched on.
- **MCP tools** that write files are outside this check; they stay under the MCP permission
  policy.
- **More prompts in one place:** a trailing `# comment` inside a multi-line command asks (R3).
- **Fewer prompts in another:** multi-line commands stop asking for anyone with a broad
  `trusted` list. Intended, and equivalent one-line forms already pass (§2.2) — but it is a
  visible change and belongs in the release notes.

---

## 12. Relationship to file-tool-path-permissions.md

| From that document                                                                                  | Here                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Shared `src/shared/path-permissions/` with relocated containment                                    | kept (§7)                                                                                            |
| Tool-agnostic dialog (`presentAsk`)                                                                 | kept, plus the reason line (§4.5)                                                                    |
| Project file honoured only for trusted projects; `ctx.cwd`; `CONFIG_DIR_NAME`                       | kept                                                                                                 |
| Decision ahead of session memory and generic rules                                                  | kept for outside → `ask`; inside → `allow` now yields to a user `deny` rule (§4.3)                   |
| Separate `path-permissions.json`; `enabled`, `includeTempDir`, `extraAllowedRoots`, `outsideAction` | replaced by one key, `trustedDirectories`; non-empty = on; `/tmp` listed explicitly; outside = `ask` |
| Gated tools: `read`, `write`, `edit`, `grep`, `find`, `ls`, `glob`                                  | first version: `write`, `edit` only (D5); the read family is deferred                                |
| "Confining bash writes" listed as a non-goal                                                        | now in scope (§6)                                                                                    |
| Separate `SettingsFilePermissions.tsx` panel                                                        | not needed for one list (D11)                                                                        |

Two references in that document have drifted and should not be copied: `isPathWithinRoot`'s
third parameter is `caseInsensitive`, not `isWindows`
([path-containment.ts:11-15](../../src/main/tools/path-containment.ts#L11-L15)); the
real-path-then-recheck pattern in `workspace-system-prompt.ts` is at lines 168-171, not 93-103.

---

## 13. Open items

None. The one item left open by the design — whether the reason reaches the app's permission
dialog — was settled during Phase 6: it does (§15).

---

## 14. Non-goals

- Operating-system enforcement (a real sandbox).
- Checking reads, in bash or in file tools.
- Checking path operands of `cp`, `mv`, `rm` and similar.
- Reading, writing or mirroring pi's `trust.json`; any part of the
  [native-project-trust-alignment.md](native-project-trust-alignment.md) epic.
- Gating pi's `powershell` tool or the user's own `!` commands.

---

## 15. As built — differences from the design

Everything above was implemented as written except the points below. Each is either stricter
than the design or fills in something the design left open.

**Reading commands (§5)**

- **Carriage return.** Any `\r` outside quotes asks, including `\r\n` — not only a lone one.
  The shell does not split on it.
- **`>|` is not treated as a redirection.** The previous reader split it at the `|`, so the
  piece after it had to be trusted on its own. Recognising `>|` would have let
  `echo x >| /etc/passwd` through a list that trusts only `echo *`. It stays split; with the
  zone on, the redirection has no target and asks.
- **Comment rule, two cases the design did not spell out.** A comment on the _first_ line is
  dropped like any other full-line comment when more lines follow. A trailing comment on the
  _last_ line is ordinary text, as in a one-line command — nothing after it runs.
- **Parentheses end a word.** Needed so that `(( 1 ))# …` is recognised as a comment start.
- **Two existing holes closed.** Bash treats `$((…))` / `((…))` as arithmetic only when it
  closes with `))`; otherwise `$((cmd) | other)` is a command substitution and
  `((cmd); other)` a subshell, and `cmd` runs. The previous guard accepted both as
  arithmetic. Both now ask. Also now asking: `cmd >1&`, where the background `&` was taken
  for part of a redirection.
- **`$'…'` and `$"…"` ask.** Found in review after the first build: the scanner read
  `echo x > $'/etc/hosts'` as a write to a file named `$/etc/hosts` inside the project, while
  the shell writes `/etc/hosts`. An escaped quote inside `$'…'` would also shift the quote
  boundaries for the rest of the command. The scanner now reports both forms as unsupported
  outside double quotes (inside them they are not special). This is the rule for the whole
  reader: a form of quoting or expansion it does not fully understand is refused, never
  guessed — the write check must not name a path the shell will not use.
- **No loosening, measured.** The rewritten reader was compared with the previous one on
  about 155,000 generated one-line commands: no command that asked before is allowed now. The
  cases that are stricter are the ones in the bullet above plus one-line `<<` without a body.
  The shapes found along the way are pinned in `tests/bash-restrictions-multiline.test.ts`.

**Write targets (§6)**

- **A `cd` joined by `;` or a line break is not assumed to have worked.** Only `&&`
  guarantees it. After any other join the shell may be in the old directory or the new one,
  so a relative target must be inside under _both_: `cd sub ; echo x > ../a.txt` asks,
  `cd sub && echo x > ../a.txt` does not.
- **What makes the directory unknown.** The word `cd`, `pushd` or `popd` anywhere except the
  plain `cd [dir]` form (so also inside a function body or an `if`); `eval`, `source` or `.`
  as the command; a command name that comes from a variable.
- **`~`, `$HOME`, `$PWD` are not trusted blindly.** If the command mentions `HOME`, `PWD`,
  `OLDPWD` or `CDPATH` as a bare name (it may assign them), those expansions become
  undeterminable. A relative `cd` is unknown when `CDPATH` is set in the environment.
- **Windows.** A target or `cd` operand that starts with `/` and is not a drive form (`/c/…`)
  is undeterminable: Git Bash maps `/tmp`, `/etc` and the like in ways the check cannot
  reproduce.
- `tee` is matched as a word anywhere in the sub-command (so `sudo tee`, `/usr/bin/tee`).

**Module boundary**

- `src/shared/bash-restrictions/index.ts` stays free of file-system imports. The bash
  write-zone check (`write-zone.ts`) resolves real paths, so it is imported by its own path
  in the main process and the `pi` extension, not through the barrel.

**Directories (§4.1)**

- **D12 is slightly broader:** an entry that _contains_ the home directory (`/Users`) is
  rejected too, not only the home directory itself.
- In the `pi` loader, `settings.trustedDirectories` holds the global file's entries only; the
  project file's entries are returned separately and both go to `buildWriteZone`, which
  applies D2 on real paths. A caller that reads only the settings object therefore sees the
  narrower list, never an unfiltered union.

**App (§4.3, §4.5)**

- **The reason is shown in the app dialog, localized.** `decidePermissionDetailed()` returns
  the action and a structured reason; the hook passes it through `requestPermission` to the
  renderer, where `PermissionDialog` words it from `permission.reasons.*` in en / zh / ru /
  hu. The technical detail inside a reason (a path, a pattern, the name of a syntax) is not
  translated.
- **Not part of the renderer's start-up push.** Main loads `trustedDirectories` from its own
  persisted config at start. The renderer's bootstrap `settings.update` deliberately does not
  include it, so a stale renderer state cannot overwrite the persisted list; edits reach main
  through `updateSettings()` like any other key.
- **Protected file in the app** is the settings store's own file (`configStore.getPath()`),
  registered at start with `setProtectedWriteFiles`.

**Still by hand**

- The `pi -e` checklist in the extension README has not been run against a live `pi`.
- The extension `pi` actually loads is the copy in `~/.pi/agent/extensions/`; it has to be
  rebuilt (`npm run build:pi-extension`) and copied there for any of this to take effect in
  `pi`.
