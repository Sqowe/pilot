<!-- sources: src/main/index.ts (Menu.buildFromTemplate, tray, dock), src/renderer/components/Sidebar.tsx, src/renderer/components/ChatView.tsx, src/renderer/components/SettingsPanel.tsx, src/renderer/i18n/locales/en.json -->

# Commands

Sqowe Pilot is a desktop app, not a command palette. These are the user-facing actions and
shortcuts — the native menu, the tray, keyboard shortcuts, and the key in-app actions.

## Keyboard shortcuts

| Shortcut         | Action                                              |
| ---------------- | --------------------------------------------------- |
| `Ctrl`/`Cmd`+`K` | [Search conversations](../features/search.md)       |
| `Ctrl`/`Cmd`+`,` | Open **Settings** (macOS app menu)                  |
| `Ctrl`/`Cmd`+`A` | Toggle message **selection mode** (in the composer) |
| `Shift`+`Enter`  | Newline in the composer (Enter sends)               |
| `Esc`            | Close search overlay / dialogs                      |

## Native app menu (macOS)

The macOS application menu exposes standard items plus a Preferences entry:

| Menu       | Items                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- |
| **App**    | About · **Preferences…** (`CmdOrCtrl+,`) · Services · Hide / Hide Others / Unhide · Quit |
| **Edit**   | Undo · Redo · Cut · Copy · Paste · Select All                                            |
| **View**   | Toggle Full Screen · Zoom In / Out / Reset                                               |
| **Window** | Minimize · Close · Bring All to Front                                                    |

> ⚠️ TODO (human): confirm the Windows menu bar / accelerator set (the macOS template is code-confirmed; Windows may differ).

## Tray / dock

| Action                        | What it does                               |
| ----------------------------- | ------------------------------------------ |
| **Show / Hide Window** (tray) | Toggle the main window without quitting.   |
| Dock menu                     | Quick actions when the app is in the dock. |

## Key in-app actions

| Action                    | Where                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| New session               | Sidebar → **New session**                                                          |
| Stop a run                | Composer → **Stop**                                                                |
| Toggle theme              | Sidebar / titlebar → theme toggle (Light / Dark / System)                          |
| Open Settings             | Sidebar → ⚙️ **Settings**                                                          |
| Change workspace folder   | [Context Panel](../features/workspaces.md) → **Change directory**                  |
| Pin/unpin a skill         | [Context Panel](../features/skill-pinning-and-profiles.md) → ★                     |
| Toggle an MCP server      | [Context Panel](../features/mcp-connectors.md) → Enable/Disable for session        |
| Export chat               | Message menu → **Export full chat** / **Export selected…** (`md` / `docx` / `pdf`) |
| Run a schedule now        | [Settings → Schedules](../features/scheduling.md) → **Run now**                    |
| Start/stop remote service | [Settings → Remote](../features/remote-control.md) → **Start service**             |

---

[← All docs](../index.md)
