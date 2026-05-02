# Bash Command Restrictions

Open Cowork gates every bash command the agent tries to run through a
small decision engine so you can decide which commands auto-run and
which require explicit approval. This document describes exactly how
that engine works, how to configure it, and the edge cases that caused
people the most confusion in practice.

---

## Quick summary

| You see                                                          | What's happening                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command ran without a prompt (green check)                       | Every sub-command matched a **Trusted** pattern.                                                                                                                                                   |
| "Permission Required" dialog appeared                            | At least one sub-command was not trusted, or a denylist match fired, or the command used shell syntax we can't safely parse.                                                                       |
| You configured the lists but the dialog still appears constantly | Most common cause: the command uses `\|` and not every piped step is trusted. Second most common: you expected `*` in the denylist to be a wildcard, but in the denylist it's a literal character. |

---

## Where to configure

Settings → **Bash Commands**.

Two textareas, one pattern per line:

- **Trusted commands** — prefix patterns with `*` as a wildcard. Matching commands run without a prompt.
- **Denylist (force approval)** — substring patterns. Matching commands always prompt, even if they also match the trusted list.

When either list has any entry, **authoritative mode** is on. The two
lists become the complete bash policy; the default "ask for bash" rule
is not consulted. When both are empty, bash commands fall through to
the default permission rule.

---

## The decision, step by step

For each bash command the agent requests, the engine runs these checks
in order. The first check that produces a decision wins.

1. **Lists opt-in gate.** If both lists are empty, the engine returns
   "no opinion" and the default rule handles it. Stop.
2. **Unsupported shell syntax guard.** If the command contains any
   construct that the simple parser can't safely evaluate, the engine
   returns "ask". This fails closed: unknown shape → manual approval.
   (Details below.)
3. **Split into sub-commands** on unquoted `&&`, `||`, `;`, `|`. Each
   piece is evaluated independently.
4. **Denylist check** on each sub-command. Substring match,
   case-insensitive. If any sub contains a denylist entry → "ask".
   The denylist always wins; a trusted sub with a denylist substring
   still asks.
5. **Trust check** on each sub-command. Prefix match with `*` as
   wildcard, case-insensitive. If every sub matches some trusted
   pattern and none matched the denylist → "allow". Otherwise → "ask".

If the agent session had an earlier "Allow always" click for the bash
tool, the bash list engine runs **before** that memory, so your
denylist still applies in the same session.

---

## Pattern semantics

Same `*` glyph, different meanings in the two lists:

### Trusted commands: prefix with wildcard

- Anchored at the start of the sub-command.
- `*` matches any sequence of characters.
- Other regex metacharacters are treated literally (`.`, `(`, `)`,
  `[`, `]`, `+`, `?`, `^`, `$`, `{`, `}`, `|`, `\`).
- Case-insensitive.

Examples:

| Pattern       | Matches                                    | Does NOT match                    |
| ------------- | ------------------------------------------ | --------------------------------- |
| `ls *`        | `ls`, `ls -la`, `ls /tmp`, `LS`            | `xls`, `my-ls`                    |
| `npm run *`   | `npm run build`, `npm run test --watch`    | `npm install`, `yarn run build`   |
| `git status`  | `git status`, `git status --short`         | `git statu`, `cd && git status`\* |
| `./configure` | `./configure`, `./configure --prefix=/opt` | `a/configure` (literal `.`)       |

\*`cd && git status` is a chain — each piece is checked separately. The
`git status` piece matches, but `cd` must also match a trusted pattern.

### Denylist: literal substring

- Any position in the sub-command.
- `*` is a **literal asterisk**, not a wildcard.
- Case-insensitive.

Examples:

| Denylist entry | Matches                                       | Common mistake                                   |
| -------------- | --------------------------------------------- | ------------------------------------------------ |
| `--force`      | `git push --force`, `rm --force foo`          | —                                                |
| `sudo`         | `sudo apt install`, `run-sudo-script.sh`      | Also matches `sudoku-cli` — substrings bite      |
| `rm `          | `rm file.txt`, `xargs rm -rf`                 | `rm` without trailing space also matches `grm`   |
| `rm *`         | **Only** commands literally containing `rm *` | Does NOT match `rm foo.txt` — the `*` is literal |

**Consequence**: if you add `rm *` to the denylist expecting it to
catch any `rm` invocation, it won't. Use `rm ` (with a trailing space)
or just `rm` if you don't care about false positives on things like
`grm`.

---

## Chains: `&&`, `||`, `;`, `|`

The engine splits chained commands on these operators (respecting
quoting) and evaluates each piece independently. The rationale is
security: `npm install && rm -rf node_modules` should never be
auto-allowed by `npm *` because the `rm -rf` part would ride along.

| Chain                | Sub-commands evaluated          |
| -------------------- | ------------------------------- |
| `ls && pwd`          | `ls`, `pwd`                     |
| `cat foo \| jq .bar` | `cat foo`, `jq .bar`            |
| `echo "a && b"`      | `echo "a && b"` (inside quotes) |
| `cmd1 ; cmd2 ; cmd3` | `cmd1`, `cmd2`, `cmd3`          |

For the whole command to auto-allow, **every** sub-command must be
trusted. A single unknown step means "ask" — even for the other steps
that would individually match.

### Practical consequence

If the agent routinely runs things like `cat file \| head -100`, you
need `head *` in your trust list even though `head` by itself is
innocuous. The engine has no idea `head` is safe; it only knows what
you told it.

---

## Shell syntax that always asks

These constructs force "ask" regardless of the lists, because the
simple parser can't prove the command doesn't smuggle something in:

| Construct            | Example                     | Why                                                           |
| -------------------- | --------------------------- | ------------------------------------------------------------- |
| Command substitution | `echo $(date)`, `cat \`x\`` | A trusted outer command could execute an untrusted inner one. |
| Process substitution | `diff <(cmd1) <(cmd2)`      | Inner commands run in a subshell.                             |
| Newline separators   | `cmd1⏎cmd2`                 | Effectively chains without `;`.                               |
| Lone background `&`  | `sleep 60 &`                | Detaches the command from our control.                        |
| Unclosed quotes      | `echo "unterminated`        | Parse is ambiguous.                                           |

Backticks and `$(...)` are scanned for **even inside double quotes**,
because bash expands them there. Single-quoted substrings are fully
inert.

---

## Shell syntax that's allowed through

These look similar to the "always ask" list but are actually safe
redirections — they duplicate or close file descriptors, they don't
chain commands or spawn subshells. The engine recognizes them and lets
the trust list decide:

| Form       | Meaning                          | Example           |
| ---------- | -------------------------------- | ----------------- |
| `N>&M`     | Duplicate fd N onto M            | `cmd 2>&1`        |
| `N>&-`     | Close fd N                       | `cmd 2>&-`        |
| `>&N`      | Short for `1>&N`                 | `printf x >&2`    |
| `&> file`  | Both stdout and stderr to file   | `cmd &> out.log`  |
| `&>> file` | Both stdout and stderr appending | `cmd &>> out.log` |

**History note:** earlier versions of the engine flagged every `&` as
the background operator, which broke common shapes like `cmd 2>&1 \|
head`. Fixed; the scanner now distinguishes redirection from
backgrounding.

---

## Worked examples

Given this configuration:

```
# Trusted
ls *
cat *
sed *
firecrawl *

# Denylist
--force
sudo
```

| Command                       | Decision | Why                                                                   |
| ----------------------------- | -------- | --------------------------------------------------------------------- |
| `ls -la`                      | allow    | Matches `ls *`. No denylist match.                                    |
| `firecrawl search "foo"`      | allow    | Matches `firecrawl *`.                                                |
| `firecrawl search "foo" 2>&1` | allow    | `2>&1` is FD redirection, not a new command. Single sub matches.      |
| `cat file \| head -100`       | ask      | `cat file` is trusted, but `head -100` is not.                        |
| `cat file \| sed 's/a/b/'`    | allow    | Both subs match (`cat *`, `sed *`).                                   |
| `sudo ls`                     | ask      | Denylist substring `sudo` matches. Denylist beats trust.              |
| `ls --force`                  | ask      | Denylist substring `--force` matches.                                 |
| `git push`                    | ask      | No trusted pattern matches. Authoritative mode → implicit ask.        |
| `echo "hello && world"`       | ask      | `echo` isn't in the trust list. (The `&&` is inside quotes; one sub.) |
| `ls && pwd`                   | ask      | Two subs. `ls` matches, `pwd` doesn't.                                |
| `ls $(rm -rf /)`              | ask      | Command substitution always asks.                                     |
| `cat <(echo hi)`              | ask      | Process substitution always asks.                                     |
| `sleep 60 &`                  | ask      | Lone `&` = background operator.                                       |
| (empty command)               | no-op    | Engine returns null, falls through.                                   |

---

## Interaction with "Allow always"

The per-tool "Allow always" button in the permission dialog stores a
session-scoped memory: "for this session, always allow tool X without
prompting." For the **bash** tool specifically, the list engine runs
_before_ that memory is consulted. This means:

- Clicking "Allow always" on a one-off bash call does **not** blanket-
  allow every future bash command in the session.
- Your denylist keeps biting for the rest of the session.
- Commands that neither match a list entry nor trip the syntax guard
  fall through to the session memory — so if you do click "Allow
  always" and then run something totally unrelated to your lists, that
  unrelated command will still auto-run until the session ends.

For non-bash tools (`write`, `edit`, `read`, etc.) "Allow always"
works as it always did: approving once short-circuits the rules for
the rest of the session.

---

## Startup and IPC details

The main process owns the authoritative cache of both lists. On app
launch, the cache is hydrated from the encrypted on-disk config before
the renderer bootstraps — so a bash call during early startup uses
your configured lists, not an empty default.

When you edit the lists in Settings, the renderer pushes the change
via `settings.update` IPC and the main process sanitizes and persists
it in one step. The two sides never diverge: there's a single
`sanitizeBashCommandList` function used by both the runtime cache and
the config store so an untrusted payload can't bypass either.

---

## Practical recipes

### "Let the agent do file inspection and searches, but not changes"

```
# Trusted
ls *
cat *
grep *
find *
head *
tail *
rg *
wc *

# Denylist
(empty)
```

### "Allow my build pipeline but block destructive ops"

```
# Trusted
npm *
git status*
git diff*
git log*

# Denylist
rm
--force
:force
git push
```

Note the bare `rm` (not `rm *`) so any `rm` invocation asks. `git push`
as a substring matches `git push`, `git push --force`, `git push
origin`, etc.

### "Research mode: firecrawl plus local JSON inspection"

```
# Trusted
firecrawl *
npx firecrawl *
cat *
jq *
head *
tail *
mkdir *

# Denylist
rm
--force
```

---

## Known limitations

- `*` in the denylist is literal, not a wildcard. (Inconsistent with
  the trust list — noted for a future UX fix.)
- The `{fd}>&N` brace form isn't recognized as redirection and still
  asks. Rare in practice; worth handling if it comes up.
- Pattern matching is case-insensitive by design. If you need
  case-sensitive blocking, you'll need to include both cases as
  separate denylist entries.

---

## Where the code lives

- Engine: `src/main/config/permission-rules-store.ts`
  (`decideBashPermission`, `splitBashSubCommands`,
  `containsUnsupportedShellSyntax`, `matchesTrustedPrefix`)
- Main-process installation of the permission gate:
  `src/main/claude/agent-runner.ts#installPermissionHook`
- Hook installer (SDK shape detection): `src/main/claude/before-tool-call-hook.ts`
- Settings UI: `src/renderer/components/settings/SettingsBashCommands.tsx`
- Persistence: `src/main/config/config-store.ts`
  (`bashTrustedCommands`, `bashDenylist` fields)
- Tests: `tests/bash-command-control.test.ts`, `tests/before-tool-call-hook.test.ts`
