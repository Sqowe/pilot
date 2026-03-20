# Cross-Platform CI Design

**Date**: 2026-03-20
**Status**: Approved
**Goal**: Catch cross-platform build regressions automatically on every push

## Problem

Dual-machine (macOS + Windows) development with no CI. Changes on one platform
break builds on the other, discovered only after manual testing — often several
commits later.

## Solution

Two GitHub Actions workflows for the public repo (free, unlimited minutes):

### 1. `ci.yml` — Daily Development Validation

**Triggers**: push to `main`/`dev`, all PRs

Three parallel jobs:

| Job | Runner | Steps |
|-----|--------|-------|
| `lint-and-test` | `ubuntu-latest` | `npm ci` → lint → tsc --noEmit → vitest |
| `build-macos` | `macos-14` (arm64) | download:node → prepare:python → prepare:gui-tools (brew install cliclick) → build:lima-agent → build:mcp → tsc → vite build → electron-builder --mac dir (unsigned) → upload artifact |
| `build-windows` | `windows-latest` (x64) | download:node → build:wsl-agent → build:mcp → tsc → vite build → electron-builder --win nsis (unsigned) → upload artifact |

### 2. `release.yml` — Tag-Triggered Release Build

**Triggers**: push tag `v*`

Same build matrix but with:
- macOS: code signing + notarize (via `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` secrets)
- Upload to GitHub Releases

### Caching Strategy

- `node_modules`: keyed on `package-lock.json` hash
- Electron binary: `~/.cache/electron`
- Node binaries: `resources/node/` (per-platform)

### Script CI Compatibility

| Script | CI Ready | Notes |
|--------|----------|-------|
| `download-node.js` | ✅ | Downloads current platform only |
| `prepare-python.js` | ✅ | Self-contained, downloads from GitHub |
| `prepare-gui-tools.js` | ⚠️ | Needs `brew install cliclick` on macOS runner |
| `build-windows.js` | ❌ Skip | CI calls `electron-builder` directly |
| `bundle-mcp.js` | ✅ | Cross-platform esbuild |

### Notifications

- GitHub PR status checks: automatic ✅/❌
- Email on failure: GitHub default
- Feishu: future enhancement

## Non-Goals (v1)

- Self-hosted runners
- Smoke testing built artifacts
- Linux builds (no current user base)
- Automatic version bumping
