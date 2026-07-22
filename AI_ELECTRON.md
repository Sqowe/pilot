# AI rules — Electron Packaging & Lifecycle (Node/Electron)

Governs `electron-builder.yml`, `scripts/after-pack.js`, `scripts/compress-dmg.js`,
`scripts/build-windows.js`, and resource-path resolution code in `src/main/**`
(`agent-runner.ts`, `mcp-manager.ts`, `sandbox/*-bridge.ts`, `skills-manager.ts`,
`index.ts`). See [ARCHITECTURE.md](ARCHITECTURE.md) §3/§6 for the full repo layout
and dist-\* output directories.

Packaging uses **electron-builder** (`electron-builder.yml`), not Electron Forge.
There is no separate spawned backend process — the agent engine (`ClaudeAgentRunner`)
runs in-process inside the Electron main process; see [AI_MAIN_PROCESS.md](AI_MAIN_PROCESS.md)
for its internals.

---

## Resource Bundling (`extraResources`)

Each platform (`win`/`mac`/`linux` in `electron-builder.yml`) declares its own
`extraResources` list — they are **not identical**. Before assuming a resource exists
on a given platform, check that platform's block:

| Resource      | win | mac | linux | Purpose                                                                                                                                            |
| ------------- | --- | --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/`        | ✅  | ✅  | ✅    | Bundled MCP servers (from `.bundle-resources/mcp`)                                                                                                 |
| `node/`       | ✅  | ✅  | ✅    | Bundled Node runtime, arch-specific dir per platform                                                                                               |
| `python/`     | —   | ✅  | ✅    | Standalone Python (Pillow/pyobjc-Quartz) for GUI automation — **not a spawned backend**, just an interpreter `gui-operate-server.ts` shells out to |
| `tools/`      | —   | ✅  | —     | GUI helper binaries (e.g. `cliclick`) to avoid relying on user-installed Homebrew                                                                  |
| `wsl-agent/`  | ✅  | —   | —     | Compiled sandbox agent for WSL2 (`dist-wsl-agent`)                                                                                                 |
| `lima-agent/` | —   | ✅  | —     | Compiled sandbox agent for Lima (`dist-lima-agent`)                                                                                                |
| `skills/`     | ✅  | ✅  | ✅    | `resources/skills` — extracted (not asar'd) to avoid symlink issues                                                                                |

**Rules:**

- `extraResources` entries land at `process.resourcesPath/<to>` directly — e.g.
  `to: node` → `Contents/Resources/node/` on mac, `resources/node/` on win. Never
  assume an extra `app-resources/`-style subdirectory.
- Always resolve bundled binaries via `process.resourcesPath` at runtime, with a
  dev-mode fallback that walks up from `__dirname`/project root — see the
  `resourcesPath = ... : path.join(process.resourcesPath, 'node')` pattern already
  used in `agent-runner.ts` and `mcp-manager.ts`. Copy that pattern for new bundled
  tools rather than inventing a new resolution strategy.
- Spawned child processes (MCP servers, sandbox agents) do not inherit
  `process.resourcesPath`. Pass it explicitly via env (see
  `env.SQOWE_PILOT_RESOURCES_PATH` in `mcp-manager.ts`) if a spawned process needs it.
- New bundled runtimes/tools require: (1) a `prepare-*.js` script under `scripts/`
  that downloads/stages them into `resources/<name>/<platform>-<arch>/`, (2) an
  `extraResources` entry per platform that needs it, (3) a resolution helper in the
  consuming main-process module.
- `afterPack: ./scripts/after-pack.js` strips non-matching platform/arch binaries
  (koffi, better-sqlite3 prebuilds) and unused locale files post-pack. When adding a
  new native dependency with per-platform prebuilds, add its pruning logic here or
  it inflates every installer with unused platform binaries.
- The `files` allowlist in `electron-builder.yml` explicitly lists which
  `node_modules/**` packages ship in the asar. A new runtime dependency with native
  bindings or large payload must be added to this list explicitly — it will NOT be
  included by default just because it's in `package.json` `dependencies`.

---

## Window & Menu Lifecycle (macOS + cross-platform)

- On macOS, closing all windows does not quit the app (`app.on('activate')` on line
  ~1329 of `src/main/index.ts` recreates the window). Any code holding a
  `BrowserWindow` reference must handle it being destroyed and recreated.
- Never close over a stale `mainWindow` variable in async callbacks or menu handlers
  spanning a window recreation. Guard every access with `mainWindow &&
!mainWindow.isDestroyed()`, or iterate `BrowserWindow.getAllWindows()` when
  broadcasting to all windows (see `emitLocalEmbeddingProgress` in `index.ts` for the
  broadcast pattern).
- `Menu.setApplicationMenu(...)` is called once at startup — do not rebuild the menu
  on window recreate.
- Single-instance lock (`app.requestSingleInstanceLock()`) is skipped in dev
  (`isDev || app.requestSingleInstanceLock()`) so multiple dev windows can run
  concurrently; do not remove the `isDev` bypass.

---

## macOS Entitlements & GUI Automation

- `hardenedRuntime: true` + `entitlements: resources/entitlements.mac.plist` are
  required for the app to keep screen-recording/accessibility permissions across
  updates. `NSScreenCaptureUsageDescription` / `NSAccessibilityUsageDescription` in
  `extendInfo` are user-facing permission prompts for `gui-operate-server.ts`
  (vision-based GUI automation) — update the copy there if the automation feature's
  scope changes, never remove the keys while GUI automation ships.
- `identity: auto` + `gatekeeperAssess: true` — do not hardcode a signing identity;
  let electron-builder pick up the local keychain cert.

---

## Native Modules & Rebuilds

- `better-sqlite3` must be compiled against Electron's ABI, not the host Node's.
  `npm run rebuild` (`electron-rebuild -f -w better-sqlite3`) runs as part of
  `pretest`/`posttest` and must be re-run manually after any plain `npm install` /
  `npm update` that touches native deps.
- `npmRebuild: true` in `electron-builder.yml` means `electron-builder` itself
  rebuilds native modules during `npm run build` — don't add a redundant manual
  rebuild step to the build script.
- `sharp`, `onnxruntime-node`, `better-sqlite3` are native and platform/arch-specific.
  When adding a new native dependency, check whether `after-pack.js` needs a pruning
  rule for its prebuild directory (mirror the existing `koffi` handling).

---

## Windows-Specific (NSIS)

- `deleteAppDataOnUninstall: false` is intentional — user config/history/sessions
  persist across uninstall/reinstall. Do not flip this without discussing data
  retention with the user; use explicit in-app cleanup tooling for that instead.
- `signAndEditExecutable: false` — the Windows build is unsigned; do not assume a
  code-signing step exists in `build:win` / `scripts/build-windows.js`.

---

## Common Pitfalls

| Issue                                            | Cause                                                              | Rule                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Bundled binary not found in packaged app         | Assumed a resource ships on all platforms                          | Check the platform-specific `extraResources` block before relying on a path     |
| New dependency missing in packaged app           | Not added to `files` allowlist in `electron-builder.yml`           | Explicitly list `node_modules/<pkg>/**/*` for new runtime deps with native code |
| Stale `mainWindow` reference after close         | Closure captured `mainWindow` before macOS `activate` recreated it | Re-check `!mainWindow.isDestroyed()` at call time, don't cache across awaits    |
| Spawned MCP/sandbox process can't find resources | `process.resourcesPath` is undefined in spawned child processes    | Pass resource path explicitly via env var to the child process                  |
| better-sqlite3 fails to load after `npm install` | Native module compiled against host Node ABI, not Electron's       | Run `npm run rebuild` after any plain npm operation touching native deps        |
