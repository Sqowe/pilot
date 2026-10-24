<!-- sources: src/renderer/components/settings/SettingsBashCommands.tsx, src/shared/bash-restrictions/ (settings.ts defaults, engine.ts), src/shared/path-permissions/, BASH_COMMAND_RESTRICTIONS.md, src/main/config/config-store.ts (AppConfig) -->

# Bash command restrictions

## What it is / when to use it

Every shell command the agent wants to run passes through a **trust/deny engine** before it
executes. You maintain a **trust list** of safe patterns (which run automatically) and a
**denylist** of dangerous ones (which always prompt, even if something trusted would match).
Everything else prompts for your approval. This keeps the agent fast on routine work without
letting it run something destructive unseen.

A third list, **trusted directories**, says where the agent may write without asking — for
shell commands and for the file-writing tools alike.

Reach for this when: you want common commands to stop nagging you for approval, you want
to guarantee certain commands always require a yes, or you want the agent to work freely
inside the project but ask before it writes anywhere else.

## How to use it

1. Open **Settings → Bash Commands**.
2. **Trusted commands** — prefix patterns. A trailing `*` is a wildcard, e.g.
   `ls *`, `git status*`, `npm run *`. Matching commands run without prompting.
   The shipped value is `*`, which matches every command.
3. **Denied commands** — patterns that always force a prompt, e.g. `rm`, `sudo`,
   `git push`, `--force`. A deny hit wins even over a trust match. A fresh
   install already ships a list of the usual destructive ones.
4. **Trusted directories** — the directories the agent may write to without being
   asked, one per line. A write inside them runs; a write anywhere else asks.
   This covers the `write` and `edit` tools and the places a shell command
   visibly writes (`>`, `>>`, `tee`). A fresh install ships `./` (the session's
   workspace), `/tmp` and `~/tmp`. Empty the field to turn the check off.
5. **Permission timeout** — set how long an approval dialog waits before auto-denying
   (default **300s**; set to **0** for no timeout / wait forever).

The approval dialog says why it appeared — a denied word, a command that is not on the trust
list, or a write outside the trusted directories.

> **Not a sandbox.** Trusted directories check the writes that can be read from the command
> itself. What a program writes on its own (`python3 script.py`) cannot be seen. Your home
> directory and the file-system root are not accepted as entries.

<!-- derived:diagram source=src/shared/bash-restrictions/engine.ts -->

```mermaid
flowchart TD
  A["Agent runs a command"] --> B{"Matches denylist?"}
  B -->|"yes"| C["Always prompt"]
  B -->|"no"| D{"Matches trust list?"}
  D -->|"yes"| W{"Visibly writes outside trusted directories?"}
  W -->|"no, or list empty"| E["Auto-allow"]
  W -->|"yes"| C
  D -->|"no"| C
  C --> F{"You respond in time?"}
  F -->|"Allow"| G["Run"]
  F -->|"Deny / timeout"| H["Block"]
```

<!-- /derived -->

![Bash Commands settings](../assets/bash-restrictions-settings.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/bash-restrictions-settings.png

## Commands & settings

| Action                | How to run                                         |
| --------------------- | -------------------------------------------------- |
| Add trusted pattern   | Settings → Bash Commands → **Trusted commands**    |
| Add denied substring  | Settings → Bash Commands → **Denied commands**     |
| Add trusted directory | Settings → Bash Commands → **Trusted directories** |
| Set approval timeout  | Settings → Bash Commands → **Permission timeout**  |

| Setting                    | Default                         | What it does                                                 |
| -------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `bashTrustedCommands`      | `*`                             | Prefix patterns (with `*` wildcard) auto-approved.           |
| `bashDenylist`             | 52 destructive-command patterns | Patterns that always force a prompt.                         |
| `trustedDirectories`       | `./`, `/tmp`, `~/tmp`           | Directories the agent may write to without being asked.      |
| `permissionTimeoutSeconds` | `300`                           | Seconds before an approval auto-denies (`0` = wait forever). |

A fresh install starts with those values; an existing install keeps the lists it already
has. The shipped trust list is `*`, so the denylist and the trusted directories are what
decide whether a command asks — the denylist covers destructive commands, the directories
cover where the agent may write.

The same engine powers the standalone `pi` CLI restriction add-on, so behavior is consistent.
Full pattern syntax and edge cases are in `BASH_COMMAND_RESTRICTIONS.md`.

**Related guide:** approvals in general — see [Approvals & safety](permissions-and-safety.md).

---

[← All docs](../index.md)
