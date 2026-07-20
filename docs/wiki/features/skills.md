<!-- sources: src/renderer/components/settings/SettingsSkills.tsx, src/main/skills/skills-manager.ts, .claude/skills/, README, docs/design/archive/skill-features-implementation-plan.md -->

# Skills

## What it is / when to use it

**Skills** are ready-made workflows that teach the agent how to do a specialized task —
generate a polished PowerPoint, build a Word document, fill a PDF form, crunch an Excel
sheet. Sqowe Pilot ships with built-in skills and lets you add your own (or install them from
a folder). Skills are always available to the agent; to make sure it actually uses one, you
[pin](skill-pinning-and-profiles.md) it.

Reach for this page when: you want the agent to produce a document, you're adding a custom
skill, or you want to keep a modified skill from being overwritten on update.

## Built-in skills

| Skill           | What it does                      |
| --------------- | --------------------------------- |
| `pptx`          | Generate PowerPoint presentations |
| `docx`          | Create and process Word documents |
| `pdf`           | Handle PDFs and forms             |
| `xlsx`          | Build Excel spreadsheets          |
| `skill-creator` | Help you author your own skills   |

Built-in skills can be toggled on/off from **Settings → Skills → Built-in Skills**.

## How to use it

1. **Use a skill** — just ask the agent in plain language (e.g. "make a 5-slide deck from
   `report.docx`"). To make a skill reliable, [pin it](skill-pinning-and-profiles.md).
2. **Add a custom skill** — **Settings → Skills → Install Skill from Folder**, then pick a
   folder containing a `SKILL.md`.
3. **Protect your edits** — if you've changed a built-in skill and don't want an app update
   to overwrite it, click **Protect from updates** (creates a `.user-modified` marker), or
   toggle protection from the skill's menu.
4. **Force a refresh** — if an update is pending, **Force refresh** replaces the runtime copy
   on the next session start.

![Skills settings](../assets/skills-settings.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/skills-settings.png

### Where skills live and how they refresh

- **Skills storage directory** — set under **Settings → Skills → Skills Storage Directory**.
  Changing it migrates your installed skills to the new location.
- **Local Development PATH** — extra directories prepended to `PATH` for all child processes
  (skills, MCP servers, tools). Useful for making `uv`, `python`, or a local binary
  discoverable.
- **Auto-update** — built-in skills are content-hash versioned. On an app update, each
  skill's `SKILL.md` is hashed; only changed skills are replaced. Protected (`.user-modified`)
  skills are skipped with a warning.

## Commands & settings

| Action                  | How to run                                                |
| ----------------------- | --------------------------------------------------------- |
| Toggle a built-in skill | Settings → Skills → Built-in Skills                       |
| Install custom skill    | Settings → Skills → **Install Skill from Folder**         |
| Protect / unprotect     | Skill menu → **Protect from updates** / **Allow updates** |
| Force refresh           | Skill menu → **Force refresh**                            |
| Refresh all             | Settings → Skills → **Refresh Skills**                    |

| Setting            | Default         | What it does                              |
| ------------------ | --------------- | ----------------------------------------- |
| `globalSkillsPath` | _(app default)_ | Directory where custom skills are stored. |
| `localDevPath`     | _(empty)_       | Extra `PATH` entries for child processes. |

**Related guides:** [Pin skills & profiles](skill-pinning-and-profiles.md),
[Resolve conflicts](skill-conflicts.md), [Install plugins](plugins.md).

---

[← All docs](../index.md)
