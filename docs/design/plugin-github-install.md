# Plugin Install from GitHub + Update

**Status:** ✅ Implemented (2026-10-22, app 1.3.1)
**Date:** 2026-10-22
**Author:** Mike Obodnikov + Kiro
**Scope:** `src/shared/plugin-github-url.ts`, `src/main/skills/plugin-github-source.ts`,
`plugin-runtime-service.ts`, `main/index.ts`, `preload/index.ts`, `renderer/types`,
`SettingsSkills.tsx`, `PluginGitHubInstallDialog.tsx`, locales

---

## Problem

Plugins install from the Claude marketplace (through the external `claude` CLI) or from a
local `.plugin`/`.zip` archive ([plugin-archive-install-and-pin.md](archive/plugin-archive-install-and-pin.md)).
A plugin published as a GitHub repository — e.g. `coreyhaines31/marketingskills`, which is
both a plugin (`.claude-plugin/plugin.json`) and a one-plugin marketplace
(`.claude-plugin/marketplace.json`) — cannot be installed:

1. There is no install-by-link path at all.
2. The GitHub "Download ZIP" of that repo fails Import Plugin: it holds one symbolic link
   (`CLAUDE.md → AGENTS.md`) and `extractZipSafe` aborts the whole install on any link
   (`Unsafe archive entry (symlink)`, reproduced 2026-10-22 against commit `e85f3cb`).
   Without the link the same archive installs: 52 skills, orchestrator `marketing-loops`.

The link is the repo authors' own agent instructions. It is not needed by the plugin, and a
root `CLAUDE.md` would not reach the model here anyway: workspace instructions are read only
from the session folder (`agent-runner.ts` → `loadWorkspaceSystemPrompt(effectiveCwd, …)`),
pi's own context-file discovery is off (`noContextFiles: true`, `pi-resource-loader.ts`;
pi `dist/core/resource-loader.js` returns `agentsFiles: []`), and only
`runtime/<id>/skills` is handed to the agent. Claude Code itself does not load a plugin-root
`CLAUDE.md` either (code.claude.com/docs/en/plugins-reference).

## Decisions (2026-10-22)

1. **Symbolic links in any archive are skipped, not rejected** — Import Plugin included. A
   link is never created and never followed, so nothing can be read or written through it;
   the user is told which entries were skipped.
2. **A marketplace with several plugins is an error** listing the plugin names, with the
   hint to link one plugin's folder. Tracked as TECHNICAL_DEBTS.md #27.
3. **Update ships now** for plugins installed from GitHub.

## User flow

- Settings → Skills → Plugins & Imports → **Install from GitHub** → dialog with one field.
  Accepted: `https://github.com/owner/repo`, with `.git`, `/tree/<ref>`,
  `/tree/<ref>/<folder>`, `github.com/owner/repo`, `git@github.com:owner/repo.git`,
  `owner/repo`. A trust warning is shown above the field.
- Installed plugins from GitHub show `owner/repo`, the branch/tag (if one was given) and the
  short commit, plus an **Update** button. Update either says "already up to date" or
  installs the new commit, keeping the user's switches.

## Design

### URL parsing — `src/shared/plugin-github-url.ts`

Pure, renderer-safe (AI_MAIN_PROCESS.md §12), so the dialog can validate as the user types;
main parses again — the renderer is untrusted.

`parseGitHubPluginUrl(input) → { owner, repo, ref?, path? } | null`

- Hosts: `github.com`, `www.github.com` only; `http` is accepted and treated as https; no
  credentials or port in the URL.
- `owner` `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`; `repo` `^[A-Za-z0-9._-]{1,100}$`, not `.`/`..`,
  `.git` stripped.
- `/tree/<ref>/<path…>`: the first segment after `tree` is the ref. A branch whose name has a
  `/` cannot be told from a folder this way — debt #27.
- `ref` `^[A-Za-z0-9._+/-]{1,255}$`, no `..`, no leading `/` or `-`.
- `path` segments: no `.`/`..`, no backslash, no control characters.
- `/blob/…`, `/releases`, anything else → `null`.

### Fetching — `src/main/skills/plugin-github-source.ts`

Main builds every URL from the parsed parts; it never fetches a URL the renderer sent.

- `resolveCommitSha(loc)`: `GET https://api.github.com/repos/<o>/<r>/commits/<ref|HEAD>` with
  `Accept: application/vnd.github.sha` → 40-hex body. 404 → `repoNotFound` (private repos
  look the same), 422 → `refNotFound`. 403/429/5xx/network → `null`: unauthenticated API is
  60 requests/hour per IP, and the archive download does not depend on it.
- `downloadArchive(loc, sha | null, file)`: `GET https://codeload.github.com/<o>/<r>/zip/<sha|ref|HEAD>`.
  Redirects followed by hand (max 3), only to `codeload.github.com`, `github.com`,
  `api.github.com`. Cap 100 MB (Content-Length checked first, bytes counted while
  streaming); 120 s timeout; 15 s for the API call. 404 → `refNotFound`/`repoNotFound`.
- The archive comment of a codeload zip is the commit SHA (checked: `unzip -z` prints
  `e85f3cb…`); it is the fallback when the API gave no SHA.
- `User-Agent: sqowe-pilot-plugin-installer` (the API requires one). No token: public repos
  only.

Global `fetch` in the main process does not use the proxy env vars (probe 2026-10-22: a dead
`HTTPS_PROXY` did not stop a request), so like the marketplace catalog this path ignores the
HTTP proxy setting — debt #27.

### Archive extraction changes

`extractZipSafe` keeps every check (absolute path, traversal, escape, size, entry count) and
returns `{ comment, skippedSymlinks }`. A link entry is recorded and skipped.
`PluginInstallResultV2.skippedSymlinks?: string[]` carries the list to the UI (paths relative
to the archive's top folder). Import Plugin's test for links changes from "rejects" to
"skips and reports".

**Stall fix (2026-10-22).** `yauzl` 2.10.0 stalled for ever on any entry whose compressed
data passed ~64 KB (reproduced in Node 24 and Electron 44: 40 KB of random bytes extracted,
70 KB never ended; the raw data inflated fine with `zlib`). Small plugins never hit it, but
`anthropics/claude-code` (a 1 MB `CHANGELOG.md`) spun for ever — and so did Import Plugin
with that archive, before any GitHub code existed. Two changes:

- `yauzl` 2.10.0 → 3.4.0 (`@types/yauzl` 3.4.0). The 3.x breaking changes do not apply: Node ≥ 12,
  and a custom `RandomAccessReader` that the app does not have. 3.4.0 has no install script, so
  no `allowScripts` entry; it is bundled into the main build. `ngrok` → `extract-zip` keeps its
  own 2.10.0.
- `extractZipSafe` gives up after 5 minutes (`DEFAULT_EXTRACT_TIMEOUT_MS`, overridable via the
  constructor's `extractTimeoutMs`), destroying the open streams, so a stall ends in an error
  instead of an endless spinner. 480 MB extracts in under a second on the dev machine; the
  margin is for slow disks.

### Locating the plugin

GitHub archives always wrap the tree in `<repo>-<sha>/`; that folder is unwrapped, then the
requested `path` is applied (must exist and stay inside, checked with `isPathWithinRoot` on
real paths). At that folder, in order:

1. `.claude-plugin/plugin.json` → the plugin root is this folder.
2. `.claude-plugin/marketplace.json` → its `plugins` entries:
   - one entry with a relative `source` (`./x`, `.`, or a bare name under
     `metadata.pluginRoot`) → that folder, which must exist and stay inside; no `..`, no
     backslash, no absolute path (the same rules Claude Code applies);
   - one entry with an object `source` (`github`, `url`, `git-subdir`, `npm`, `archive`,
     `command`) → `unsupportedSource`;
   - several entries → `multiplePlugins` with the names; none → `noPlugin`.
3. `skills/` with at least one `*/SKILL.md` → this folder, without a manifest.
4. Otherwise `noPlugin`.

The plugin's name comes from its `plugin.json`, else the marketplace entry name, else the
last path segment, else the repo name — never the temp folder name.

### Install

`installFromGitHub(input)`: parse → SHA (or `null`) → download → extract → locate →
`installFromDirectory(root, { fallbackName, source })`. Re-installing an installed plugin
overwrites it, as every other install path does.

### Source record

```typescript
export interface PluginGitHubSource {
  type: 'github';
  owner: string;
  repo: string;
  ref?: string; // as given; undefined = default branch
  path?: string; // plugin root inside the repo, as located at install
  commitSha?: string; // installed commit
}
// InstalledPlugin.source?: PluginGitHubSource
```

`path` is the folder actually located (e.g. the marketplace entry's folder), so Update goes
straight to it and does not depend on how the marketplace looks later.

### Update

`updateFromGitHub(pluginId)`:

1. The plugin must have `source.type === 'github'` (`notFromGitHub` otherwise).
2. SHA from the API; equal to `commitSha` → `{ status: 'upToDate' }`, nothing downloaded.
3. Download (by SHA, or by ref when the API gave none) → archive comment equal to
   `commitSha` → `upToDate`.
4. Locate at the stored `path`; the new plugin name must map to the same `pluginId`
   (`pluginRenamed` otherwise — uninstall and install again).
5. `installFromDirectory(root, { source, preserve: previous })` keeps `installedAt`, the
   plugin switch and every component switch whose component still exists; a component that
   is new gets the install default (skills/commands/agents on, hooks/MCP off). The
   orchestrator is detected again.

Main invalidates the skills setup after an update, as after install.

### IPC and errors

- `plugins.installFromGitHub(url: string)` → `{ ok: true, result: PluginInstallResultV2 }`
- `plugins.updateFromGitHub(pluginId: string)` → `{ ok: true, result: PluginGitHubUpdateResult }`
- Failure → `{ ok: false, error: { code, details? } }`, never a throw (AI_MAIN_PROCESS.md §2).
  Codes: `invalidUrl`, `repoNotFound`, `refNotFound`, `pathNotFound`, `noPlugin`,
  `multiplePlugins`, `unsupportedSource`, `tooLarge`, `downloadFailed`, `archiveInvalid`,
  `pluginNotFound`, `notFromGitHub`, `pluginRenamed`, `unknown`. The renderer maps each to
  an i18n key (AI_FRONTEND.md §12); the technical message is logged in main.

### UI

- Fourth button **Install from GitHub** in Plugins & Imports (grid becomes 2×2).
- `PluginGitHubInstallDialog` on `SettingsDialogFrame`: labelled field with `autoFocus`,
  hint with examples, trust warning, error with `role="alert"`, Install disabled while the
  link does not parse or a request is running; Enter submits, Escape closes.
- Installed row: `GitHub · owner/repo · ref · abc1234` line and an Update icon button with
  `aria-label`. Results go to the existing toast, which gains `role="status"`.
- Skipped links are appended to the success message.

## Security

- No git, no CLI, no script runs; only HTTPS GETs to three GitHub hosts.
- Size, entry count, traversal, absolute-path and escape checks unchanged; links never
  created.
- Marketplace `source` paths and the URL folder are confined to the extracted tree.
- Hooks and MCP stay off by default (`getDefaultComponentState`), on install and for new
  components on update.
- Plugin text reaches the model as skills — the same prompt-injection exposure as archive
  import; the dialog says to install only from trusted sources.

## Tests

- `tests/plugin-github-url.test.ts` — accepted forms, rejected hosts/paths/segments.
- `tests/plugin-github-source.test.ts` — SHA lookup statuses, download limits, redirects.
- `tests/plugin-github-install.test.ts` — install/update with a fake `fetch` serving zips
  built by `archiver`: links skipped, marketplace one/several/remote, folder, rename,
  up-to-date by API and by archive comment, preserved switches.
- `tests/plugin-archive-install.test.ts` — link test updated; an entry larger than 64 KB
  compressed (fails on yauzl 2.10.0); a stream that never ends fails within the timeout.
- Renderer: source-pattern checks as in `settings-panel-plugin-entry.test.ts`, plus the
  error-code → i18n-key mapping.
