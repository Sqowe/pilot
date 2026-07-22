<!-- sources: src/main/config/config-store.ts (AppConfig interface, defaults), src/renderer/components/SettingsPanel.tsx (tabs), src/renderer/components/settings/* -->

# Settings

Every user setting, grouped by the **Settings** tab it lives under. Settings are stored
locally in an encrypted config store and never leave your machine. Defaults are shown where
they're meaningful.

## API

| Setting             | Default              | What it does                                                       |
| ------------------- | -------------------- | ------------------------------------------------------------------ |
| `provider`          | —                    | Active API provider.                                               |
| `apiKey`            | —                    | API key for the active provider.                                   |
| `baseUrl`           | _(provider default)_ | Custom API endpoint.                                               |
| `model`             | —                    | Active model.                                                      |
| `thinkingLevel`     | model-dependent      | Reasoning effort (clamped to the model's supported levels).        |
| `activeConfigSetId` | `default`            | Active saved config set.                                           |
| `configSets`        | 1 ("default")        | Saved provider+model+key setups (max 20).                          |
| `contextWindow`     | _(model default)_    | Override context window.                                           |
| `maxTokens`         | _(model default)_    | Override max output tokens.                                        |
| `claudeCodePath`    | _(auto)_             | Claude Code CLI path override.                                     |
| `localDevPath`      | _(empty)_            | Extra `PATH` dirs for child processes (colon/semicolon-separated). |

## Sandbox (experimental)

| Setting          | Default | What it does                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------ |
| `sandboxEnabled` | off     | VM-level command isolation (WSL2 / Lima). Code-complete but stabilizing. |

## Connectors (MCP)

| Setting                            | Default        | What it does                                             |
| ---------------------------------- | -------------- | -------------------------------------------------------- |
| `mcpToolTimeoutSeconds`            | global default | Per-call MCP timeout before erroring (0 = wait forever). |
| _(per-server)_ `enabled`           | varies         | Global on/off for a server.                              |
| _(per-server)_ `defaultToolPolicy` | `ask-all`      | `ask-all` / `allow-reads` / `allow-all` / `deny-all`.    |
| _(per-server)_ `toolPermissions`   | _(empty)_      | Per-tool overrides.                                      |

## Skills

| Setting                              | Default         | What it does                                                          |
| ------------------------------------ | --------------- | --------------------------------------------------------------------- |
| `globalSkillsPath`                   | _(app default)_ | Where custom skills are stored.                                       |
| `skillConflictConfig.policy`         | `custom-wins`   | How name collisions resolve (`custom-wins` / `builtin-wins` / `ask`). |
| `skillConflictConfig.overrides`      | _(empty)_       | Per-skill source choices.                                             |
| `skillConflictConfig.disabledSkills` | _(empty)_       | Globally disabled skill IDs.                                          |

## Memory

| Setting                              | Default         | What it does                                 |
| ------------------------------------ | --------------- | -------------------------------------------- |
| `memoryEnabled`                      | on              | Master memory toggle.                        |
| `memoryRuntime.useEmbedding`         | on              | Use embeddings for semantic recall.          |
| `memoryRuntime.embedding.provider`   | `local`         | Embedding provider (`local` = offline ONNX). |
| `memoryRuntime.llm`                  | inherits active | Model for extraction/recall.                 |
| `memoryRuntime.maxNavSteps`          | 2               | Progressive-retrieval depth (0–4).           |
| `memoryRuntime.ingestionConcurrency` | 4               | Extraction parallelism.                      |
| `memoryRuntime.storageRoot`          | app data folder | Where `memory.db` and the JSON files live.   |

## Schedules

| Setting                    | Default | What it does                                                      |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| `schedulerCatchUpPolicy`   | `ask`   | Missed-window behavior (`skip` / `run-once` / `run-all` / `ask`). |
| `schedulerConflictPolicy`  | `queue` | Busy-agent behavior (`queue` / `skip-if-busy`).                   |
| `schedulerRunHistoryDepth` | `10`    | Past runs kept per task.                                          |

## Remote

| Setting                            | Default   | What it does                          |
| ---------------------------------- | --------- | ------------------------------------- |
| `defaultWorkingDirectory` (remote) | _(empty)_ | Default folder for remote commands.   |
| Auto-approve safe tools            | off       | Auto-allow safe tools in remote runs. |

## General

| Setting                    | Default      | What it does                                             |
| -------------------------- | ------------ | -------------------------------------------------------- |
| `theme`                    | system       | `light` / `dark` / `system`.                             |
| `language`                 | system       | UI language (English / 中文 / Русский / Magyar).         |
| `notificationsEnabled`     | on           | Native notifications when unfocused.                     |
| `httpProxy`                | _(empty)_    | Outbound API proxy (`http://host:port`; no credentials). |
| `systemPromptFileEnabled`  | on           | Auto-load a workspace instructions file.                 |
| `systemPromptFilePriority` | ordered list | Filenames to look for, in priority order.                |
| `enableDevLogs`            | off          | Developer logging.                                       |

## System Prompt

No persistent toggles beyond the section files themselves — each section (identity,
behavioral-rules, citations, tool-routing) can be edited, disabled, or reset to default.
Workspace overrides live in `{workspace}/.cowork/prompts/`.

## Bash Commands

| Setting                    | Default             | What it does                                                 |
| -------------------------- | ------------------- | ------------------------------------------------------------ |
| `bashTrustedCommands`      | small safe set      | Prefix patterns (with `*`) auto-approved.                    |
| `bashDenylist`             | small dangerous set | Substrings that always force a prompt.                       |
| `permissionTimeoutSeconds` | `300`               | Seconds before an approval auto-denies (`0` = wait forever). |

## Logs

| Setting         | Default | What it does                              |
| --------------- | ------- | ----------------------------------------- |
| `enableDevLogs` | off     | Enables developer log capture and export. |

## Internal / migration

| Setting               | Notes                                                  |
| --------------------- | ------------------------------------------------------ |
| `isConfigured`        | First-run flag.                                        |
| `configSchemaVersion` | Schema version for migration (internal).               |
| `orphanDismissals`    | Per-workspace stale-config dismissal state (internal). |

---

[← All docs](../index.md)
