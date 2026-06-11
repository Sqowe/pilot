# Plugin Archive Install + Plugin-Level Pinning

**Status:** Proposed
**Date:** 2026-06-11
**Author:** Mike Obodnikov + Kiro
**Scope:** `plugin-runtime-service.ts`, `main/index.ts`, `preload/index.ts`, `SettingsSkills.tsx`, `agent-runner.ts`, `session-manager.ts`

---

## Problem Statement

Open Cowork's plugin system currently:

1. **Only installs from the Claude marketplace** via `claude` CLI. There is no way to install a local `.plugin` archive file (zip with `.claude-plugin/plugin.json` + `skills/` structure).
2. **Exposes all plugin skills individually** with no concept of the plugin as a coherent unit. A plugin with 37 skills dumps 37 separate entries into the skills list. Users cannot "pin the plugin" — they must pin individual skills (hard cap: 10 per session).
3. **The LLM has no awareness of skill grouping.** It sees flat skill descriptions with no hint that `mom-test`, `lean-canvas`, `pvt-business-plan` etc. belong to the same bundle or that one skill is the orchestrator.

This design addresses both gaps in a single release.

---

## Part 1: Archive Installation (`installFromArchive`)

### User Story

> As a user, I want to install a `.plugin` file (zip archive) from my local filesystem so that I can use plugin bundles created by others without going through the Claude marketplace.

### Design

#### New method: `PluginRuntimeService.installFromArchive(archivePath: string)`

```typescript
async installFromArchive(archivePath: string): Promise<PluginInstallResultV2> {
  // 1. Validate file exists and is a zip
  if (!fs.existsSync(archivePath)) {
    throw new Error('Plugin archive not found');
  }

  // 2. Create temp directory
  const tempDir = path.join(os.tmpdir(), `cowork-plugin-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 3. Extract zip to temp dir
    await this.extractZip(archivePath, tempDir);

    // 4. Delegate to existing installFromDirectory
    const result = await this.installFromDirectory(tempDir);
    return result;
  } finally {
    // 5. Clean up temp dir
    await this.removePathWithRetries(tempDir);
  }
}
```

#### Zip extraction

Use Node.js built-in `child_process` to call `unzip` (macOS/Linux) or `tar` fallback. Alternatively use the already-bundled `archiver` dependency (though it's write-only). For extraction, the simplest cross-platform approach:

```typescript
private async extractZip(archivePath: string, targetDir: string): Promise<void> {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  if (process.platform === 'win32') {
    // PowerShell Expand-Archive
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${targetDir}' -Force`
    ]);
  } else {
    // macOS / Linux
    await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', targetDir]);
  }
}
```

#### IPC Handler

```typescript
// src/main/index.ts
ipcMain.handle('plugins.installFromFile', async (_event, filePath?: string) => {
  if (!pluginRuntimeService) {
    throw new Error('PluginRuntimeService not initialized');
  }

  let targetPath = filePath;

  // If no path provided, show file dialog
  if (!targetPath) {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Plugin Archives', extensions: ['plugin', 'zip'] }],
      title: 'Select Plugin Archive',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    targetPath = result.filePaths[0];
  }

  const installResult = await pluginRuntimeService.installFromArchive(targetPath);
  sessionManager?.invalidateSkillsSetup();
  return installResult;
});
```

#### Preload Bridge

```typescript
// src/preload/index.ts — inside plugins object
installFromFile: (filePath?: string): Promise<PluginInstallResultV2 | null> =>
  ipcRenderer.invoke('plugins.installFromFile', filePath),
```

#### UI (Settings → Skills tab)

Add an "Import Plugin" button next to "Browse Plugins":

```tsx
<button onClick={handleImportPlugin}>{t('skills.importPlugin')}</button>
```

Handler calls `window.electronAPI.plugins.installFromFile()` with no arguments (triggers file dialog on main process side).

### File Format Expectations

The `.plugin` file is a zip archive containing:

```
<root>/
├── .claude-plugin/
│   └── plugin.json        # { name, version, description, author, keywords }
├── skills/
│   ├── skill-a/
│   │   └── SKILL.md
│   ├── skill-b/
│   │   ├── SKILL.md
│   │   ├── references/
│   │   └── scripts/
│   └── ...
├── agents/                # optional
├── hooks/                 # optional
├── .mcp.json              # optional
└── README.md              # optional
```

The `installFromDirectory` method already handles all of this correctly. We only need to add the unzip step before it.

---

## Part 2: Plugin-Level Pinning

### User Story

> As a user, I want to pin an entire plugin for my session so that the LLM knows to use it as a toolbox, without me manually pinning 10+ individual skills.

### Design Overview

```
┌────────────────────────────────────────────────────────┐
│ User pins "bizplan-skills" plugin in ContextPanel      │
│                                                        │
│   ┌──────────────────────────┐                         │
│   │ Plugin Pinning           │                         │
│   │ ☆ bizplan-skills (37)    │  ← one click           │
│   │ ☆ sales-toolkit (8)     │                         │
│   └──────────────────────────┘                         │
│                                                        │
│          │                                             │
│          ▼                                             │
│   buildPinnedPluginsDirective(sessionId)               │
│          │                                             │
│          ▼                                             │
│   <pinned_plugin name="bizplan-skills">                │
│     Business planning bundle. Entry point:             │
│     pvt-business-plan (orchestrates the full           │
│     workflow). Use it when user asks about             │
│     business plans, ПВТ, market research...           │
│   </pinned_plugin>                                     │
│                                                        │
│   ~60-80 tokens instead of 37×40 = 1480 tokens        │
└────────────────────────────────────────────────────────┘
```

### Orchestrator Auto-Detection

At install time (inside `installFromDirectory` or as a post-install step), detect the orchestrator skill:

```typescript
private detectOrchestrator(pluginRootPath: string): string | null {
  const skillsDir = path.join(pluginRootPath, 'skills');
  if (!fs.existsSync(skillsDir)) return null;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const content = fs.readFileSync(skillMd, 'utf8');
    // Check frontmatter description for orchestrator keywords
    const frontmatter = this.extractFrontmatter(content);
    if (frontmatter?.description &&
        /orchestrat|coordinat|delegates?\s+to/i.test(frontmatter.description)) {
      return entry.name;
    }
  }
  return null;
}
```

Result stored in `InstalledPlugin`:

```typescript
interface InstalledPlugin {
  // ... existing fields ...
  orchestratorSkill?: string; // e.g. "pvt-business-plan"
}
```

### Data Model Changes

#### InstalledPlugin type extension

```typescript
// src/renderer/types/index.ts
export interface InstalledPlugin {
  // existing fields unchanged
  pluginId: string;
  name: string;
  description?: string;
  // ...
  orchestratorSkill?: string; // auto-detected at install time
}
```

#### Session pinned plugins (parallel to `sessionPinnedSkills`)

```typescript
// src/main/session/session-manager.ts
private sessionPinnedPlugins: Map<string, Set<string>> = new Map();

// Methods:
getSessionPinnedPlugins(sessionId: string): string[]
toggleSessionPluginPin(sessionId: string, pluginId: string): string[]
```

### System Prompt Directive Generation

```typescript
// src/main/claude/agent-runner.ts
private buildPinnedPluginsDirective(sessionId: string): string {
  const pinnedPluginIds = this.getSessionPinnedPlugins(sessionId);
  if (pinnedPluginIds.length === 0) return '';

  const installedPlugins = this._pluginRuntimeService?.listInstalled() ?? [];
  const blocks: string[] = [];

  for (const pluginId of pinnedPluginIds) {
    const plugin = installedPlugins.find(p => p.pluginId === pluginId);
    if (!plugin || !plugin.enabled) continue;

    let directive = `<pinned_plugin name="${plugin.name}">`;
    directive += `\n  ${plugin.description || 'Plugin bundle.'}`;

    if (plugin.orchestratorSkill) {
      directive += `\n  Entry point skill: ${plugin.orchestratorSkill}`;
      directive += ` — invoke it first when the user's task matches this plugin's domain.`;
      directive += ` It coordinates the other skills in the bundle.`;
    } else {
      directive += `\n  Contains ${plugin.componentCounts.skills} skills.`;
      directive += ` Use them when the task matches this plugin's domain.`;
    }

    directive += `\n</pinned_plugin>`;
    blocks.push(directive);
  }

  if (blocks.length === 0) return '';

  return `<pinned_plugins>\n${blocks.join('\n')}\n</pinned_plugins>`;
}
```

### Token Budget Analysis

| Approach                       | Tokens per plugin | For 37-skill bundle   |
| ------------------------------ | ----------------- | --------------------- |
| Pin all skills individually    | 37 × 40 = 1480    | 1480 (hits cap at 10) |
| Pin plugin (with orchestrator) | ~60-80            | 60-80                 |
| Pin plugin (no orchestrator)   | ~40-50            | 40-50                 |

Plugin pinning is **~20× more efficient** and bypasses the 10-skill cap entirely.

### UI: ContextPanel Changes

Add a "Plugins" section above or below the Skills section in ContextPanel:

```tsx
{
  /* Plugin Pinning Section */
}
{
  installedPlugins.length > 0 && (
    <div className="plugin-pinning-section">
      <h4>{t('contextPanel.plugins')}</h4>
      {installedPlugins.map((plugin) => (
        <PluginPinRow
          key={plugin.pluginId}
          plugin={plugin}
          pinned={sessionPinnedPlugins.has(plugin.pluginId)}
          onToggle={() => handleTogglePluginPin(plugin.pluginId)}
        />
      ))}
    </div>
  );
}
```

Each row shows: plugin name, skill count badge, orchestrator indicator (★), pin toggle.

### IPC Channels

```typescript
// New handlers
'plugins.getSessionPinnedPlugins' → string[]
'plugins.toggleSessionPluginPin' → string[]
```

Preload:

```typescript
plugins: {
  // existing...
  getSessionPinnedPlugins: (sessionId: string) => ipcRenderer.invoke('plugins.getSessionPinnedPlugins', sessionId),
  toggleSessionPluginPin: (sessionId: string, pluginId: string) => ipcRenderer.invoke('plugins.toggleSessionPluginPin', sessionId, pluginId),
}
```

---

## Implementation Order

1. **Phase 1: Archive Install** (small, self-contained)
   - Add `extractZip` + `installFromArchive` to `PluginRuntimeService`
   - Add IPC handler + preload bridge
   - Add "Import Plugin" button to SettingsSkills
   - Add i18n keys
   - Tests: archive extraction + install flow

2. **Phase 2: Orchestrator Detection** (small, no UI)
   - Add `detectOrchestrator` to `PluginRuntimeService`
   - Store in `InstalledPlugin.orchestratorSkill`
   - Backfill for already-installed plugins on app start (one-time scan)

3. **Phase 3: Plugin Pinning** (medium, full-stack)
   - Session state in `SessionManager`
   - Directive generation in `agent-runner.ts`
   - IPC channels
   - ContextPanel UI
   - Workspace profile support (optional, can defer)

---

## Risks & Mitigations

| Risk                                                     | Impact                                          | Mitigation                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Zip extraction fails on Windows                          | Install broken                                  | Fallback to PowerShell `Expand-Archive`; test on CI                                                                                 |
| Orchestrator heuristic misdetects                        | Wrong entry point suggested to LLM              | Keyword list is narrow ("orchestrat", "coordinat", "delegates to"); if no match → fallback to generic directive without entry point |
| Plugin pinning conflicts with skill pinning              | Confusing UX                                    | They're complementary: pin a plugin for broad domain coverage, pin individual skills for precision. Document clearly in UI          |
| Large plugins (50+ skills) still load all skill metadata | Token waste from skill descriptions on the path | Future: lazy skill loading (only load skills when orchestrator invokes them). Out of scope for this design.                         |

---

## References

- Claude Code plugin spec: https://code.claude.com/docs/en/plugins-reference
- Claude Code `--plugin-dir` accepts zip since v2.1.128
- `plugin.json` schema: only standard fields (name, version, description, author, keywords)
- Community consensus: ~15-20 skills is the practical limit before LLM triggering degrades
- Current skill pinning cap: `MAX_PINNED_SKILLS_PER_SESSION = 10`
