<!-- sources: src/renderer/components/WelcomeView.tsx, src/renderer/components/WorkspacePicker.tsx, src/renderer/components/ContextPanel.tsx, src/main/config/config-store.ts (AppConfig), docs/design/workspace-instructions-priority-discovery.md, docs/design/archive/stale-workspace-config-cleanup.md -->

# Workspaces & files

## What it is / when to use it

A **workspace** is the folder the agent is allowed to work in. Everything it reads and writes
stays inside that folder — this is the first and most important safety boundary. You can
switch folders mid-session, open files in your file manager, and give the agent project-
specific instructions that only apply inside a given folder.

## How to use it

1. On the **Welcome screen**, click **Select Working Folder** and pick a directory. (You
   can't start a chat until a folder is chosen.)
2. To switch folders later, open the **Context Panel** and click **Change directory**.
3. From the Context Panel you can also **Copy path** or **Open in file manager** for any
   artifact the agent created.

![Context panel: working directory and artifacts](../assets/workspaces-context-panel.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/workspaces-context-panel.png

### Workspace instructions

You can drop an instructions file in your project folder and the agent will read it as extra
guidance for that workspace only. Under **Settings → General → Workspace instructions file**,
turn auto-loading on, choose which filenames to look for, and set their priority order (the
first file that exists wins). This is the lighter alternative to fully
[customizing the system prompt](system-prompt.md).

### Stale-config cleanup

If you uninstall a skill or remove an MCP server, references can linger in your project's
shared config files (`.cowork/skills-profile.json`, `.cowork/mcp-servers.json`). When you
open such a workspace, Sqowe Pilot offers a one-click **Review & Clean Up** modal to remove
the stale entries — harmless at runtime, but kept tidy for teammates who share the folder via
git.

## Commands & settings

| Action                | How to run                                               |
| --------------------- | -------------------------------------------------------- |
| Select working folder | Welcome screen → **Select Working Folder**               |
| Change directory      | Context Panel → **Change directory**                     |
| Open in file manager  | Context Panel → artifact menu → **Open in file manager** |
| Clean up stale config | Workspace notification → **Review & Clean Up**           |

| Setting                    | Default      | What it does                                             |
| -------------------------- | ------------ | -------------------------------------------------------- |
| `defaultWorkdir`           | _(empty)_    | Folder pre-selected on the Welcome screen.               |
| `systemPromptFileEnabled`  | on           | Auto-load a workspace instructions file when one exists. |
| `systemPromptFilePriority` | ordered list | Which filenames to look for, in priority order.          |

**Related guides:** shared workspace config for [Skills](skill-pinning-and-profiles.md) and
[Connectors](mcp-connectors.md) lives in the same `.cowork/` folder.

---

[← All docs](../index.md)
