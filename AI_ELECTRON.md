# Electron Desktop Implementation Rules

Derived from real bugs encountered during implementation.

## Packaging & Resource Paths

- `extraResource` items land directly in `Contents/Resources/<name>/`, NOT in a
  subdirectory like `app-resources/`. Always use `process.resourcesPath` directly.
- The Electron app source (`desktop/`) is packaged into `Contents/Resources/app/`.
  Use `__dirname` to reference files relative to the app source (e.g. binaries in
  `build/dist/`), not `_getProjectRoot()`.
- Never hardcode `path.join(process.resourcesPath, 'app-resources')` — verify the
  actual packaged layout before assuming a subdirectory exists.

## node_modules in Packaged App

- Do NOT add `/^\/node_modules\//` to the `ignore` array in `forge.config.js`.
  Electron Forge auto-prunes devDependencies; blanket-ignoring node_modules strips
  runtime dependencies like `electron-store` and `get-port`.
- Runtime dependencies must be in `dependencies`, not `devDependencies`.
- `electron-store` v8+ and `get-port` v7+ are ESM-only. Pin `electron-store` to
  v7 and `get-port` to v5 if the codebase uses CommonJS (`require()`). The project
  currently uses `get-port@^5.1.1` and `electron-store@^7.0.0`.

## Protocol Registration

- `protocol.handle()` can only be called once per scheme. Never call `registerProtocol()`
  inside `createWindow()` — call it once in `app.whenReady()` before the first window.
- Register the scheme as privileged with `protocol.registerSchemesAsPrivileged()` before
  `app.whenReady()`, otherwise fetch/XHR from the renderer will be blocked.

## Window & Menu Lifecycle (macOS)

- On macOS, closing all windows does not quit the app. The `activate` event recreates
  the window. Any object that holds a `BrowserWindow` reference must handle the window
  being destroyed and recreated.
- Never close over a `mainWindow` variable in menu click handlers — the reference goes
  stale after the window is closed. Use `BrowserWindow.getFocusedWindow()` or
  `BrowserWindow.getAllWindows()[0]` at click time instead.
- Call `setupMenu()` once; do not rebuild the menu on window recreate.

## PyInstaller Hidden Imports

- The backend uses `try/except ImportError` to support both `backend.routes.llm` and
  `routes.llm` import styles. PyInstaller's static analysis cannot resolve the bare
  `routes.*` / `services.*` paths because they are not top-level packages.
- Only list `backend.*` prefixed hidden imports. Remove bare `routes.*`, `services.*`,
  and `config` entries — they will always produce "not found" warnings and are redundant.

## External Tool Detection (pandoc, python)

- Packaged Electron apps inherit a minimal `PATH` that excludes Homebrew and user-local
  paths (e.g. `~/.local/Homebrew/bin`). Never assume system tools are on PATH.
- Always provide a user-configurable path setting for any external binary (pandoc, python).
- Auto-detection should try common install locations as fallback candidates:
  `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/Homebrew/bin`, `/usr/bin`.
- Pass resolved binary paths as environment variables to child processes so they
  propagate through to Python services (e.g. `PANDOC_PATH`, `PYTHONPATH`).

## Backend Process Resilience (Sleep/Idle Recovery)

- macOS App Nap and system sleep can kill or corrupt child processes (especially
  PyInstaller binaries whose `_MEIPASS` temp directory gets cleaned up).
- Never assume a spawned backend process will survive indefinitely. Always monitor it.
- Implement periodic health checks (e.g. 30s interval) with auto-restart after N
  consecutive failures.
- Use Electron's `powerMonitor.on('resume')` to proactively check backend health
  on wake from sleep — don't wait for a user action to discover the backend is dead.
- Guard against concurrent restart attempts with a shared `_restartPromise` — all
  concurrent callers await the same outcome, only one restart executes.
- Notify renderer windows via IPC (`backend:restarted`) after recovery so the UI
  can retry failed requests.
- Use `shutdown()` with a hard timeout in the `before-quit` handler to ensure
  deterministic cleanup. Stop health monitoring and await any in-flight restart
  before killing the backend process.
- See `docs/ELECTRON_BACKEND_SLEEP_RECOVERY.md` for the full pattern (reusable across projects).
