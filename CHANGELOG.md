# Changelog

All notable changes to the Open Cowork AI agent desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.3.0-sqowe.3] - 2026-05-08

### Changed

- Uplift Electron from 35.7.5 to 41.3.0 (Chromium 146, Node 24.14, V8 14.6)
- Update .nvmrc from 22 to 24 to match host environment
- Route renderer clipboard writes through main process IPC (Electron 40+ deprecation)
- Rename readme.md → README.md
- Document native module rebuild step in README and CONTRIBUTING

## [3.3.0-sqowe.2] - 2026-05-05

### Fixed

- Pass user-attached images to pi-coding-agent SDK prompt (images were silently dropped)

## [3.3.0-sqowe.1] - 2026-05-02

Sqowe fork variant based on upstream `3.3.0`. Tracks upstream functionality with fork-specific customizations layered on top. See the [Sqowe-Specific Features](readme.md#sqowe-specific-features) section in the README for details.

## [3.3.0] - 2026-04-18

First stable release of the 3.3.x series. Graduated from 9 beta releases with 30+ commits since beta.9.

### Added

- Pairing mode UI guidance and approval panel for Feishu remote control (#109)
- Official project website with VitePress (#122)
- Codex-powered PR review bot with GPT-5.3-codex (#94)
- Codex issue auto-response workflow (#95)
- Platform-based issue auto-assignment (#96)
- ROADMAP.md with versioned planning (v3.4.0+)
- SEO optimizations — llms.txt, social preview, FAQ
- Dependency management policy in CONTRIBUTING.md

### Fixed

- Feishu DM policy now correctly syncs to gateway auth mode (#107)
- Feishu WebSocket connection failures (#93, #105)
- Screenshot tool results display as images instead of bloating text context (#135, #124)
- GUI tool-result image deduplication via content hashing
- Gemini and other providers: empty probe response handling (#88)
- Model probe error causes now preserved in diagnostics (#121)
- MCP: prefer system npx on Windows (#120)
- Security: zip-slip and path traversal hardening (#139)
- Dark/light theme switching on website
- Outdated model fallbacks updated to current versions (claude-sonnet-4-6, gemini-3-flash-preview, gpt-5.4-mini)

### Changed

- OpenAI model presets updated: gpt-5.4-mini, gpt-5.4-nano, o4-mini (replaced retired gpt-4.1)
- CI: platform builds moved to release-only, smoke tests added
- Dependabot: grouped CI actions, separated production patch/minor, ignored Electron major

### Removed

- Unused credentials store module and Keychain integration (eliminated macOS Keychain popup on startup)

### Contributors

- [@hqhq1025](https://github.com/hqhq1025)
- [@Sun-sunshine06](https://github.com/Sun-sunshine06)
- [@JackXFan](https://github.com/JackXFan)
- [@andoan16](https://github.com/andoan16)

## [3.3.0-beta.8] - 2026-03-29

### Added

- Build verification and post-install reliability checks for Windows and macOS installers
- ~100 test files with coverage thresholds enforced in CI pipeline

### Fixed

- 8 critical + 10 high security findings from Round 3 security audit
- 20 medium-severity hardening fixes across sandbox and MCP modules
- VM sandbox security against command injection and symlink attacks (WSL2 & Lima)
- MCP server staging and lifecycle issues for external tool integration
- Skills ENOTDIR error when built-in skills (PPTX, DOCX, PDF, XLSX) symlink into .asar archive
- Remote gateway null check in `loadPairedUsers` for Feishu/Slack integration
- Scrypt `maxmem` parameter for startup key derivation performance
- CI pipeline stabilization for cross-platform builds

## [3.2.0] - 2026-03-02

### Added

- GUI automation support for Windows desktop applications (computer use with WeChat workflow)
- Drag-and-drop file and image attachments with bubble layout in chat interface

### Changed

- Updated Open Cowork app icons for Windows and macOS packaging (branding refresh)
- Widened chat content area layout for better readability

### Fixed

- Improved `key_press` robustness for GUI automation on Windows and macOS

## [3.1.0] - 2026-02-13

### Added

- Full V2 plugin runtime and management system for custom MCP connectors
- Demo videos showcasing file organization, PPTX generation, XLSX creation, and GUI operation

### Fixed

- Custom Anthropic API timeout handling for Claude model requests
- Agent runner `sdkPlugins` runtime ReferenceError in multi-model configurations
- Hardcoded Chinese text removed from config modal and titlebar (full English/Chinese localization)
- Sensitive log redaction hardened for API keys and credentials
- Packaged app version alignment to 3.0.0 for consistent update detection

## [3.0.0] - 2026-02-08

### Changed

- **Breaking**: Removed proxy layer — all AI model requests now go through Claude Agent SDK directly
- Architecture redesigned to SDK-first approach for better multi-model support (Claude, OpenAI, Gemini, DeepSeek)

### Fixed

- GUI dock click targeting and verification gating for macOS computer use

## [2.0.0] - 2026-01-25

### Changed

- Major architecture overhaul: Electron-based desktop app with React UI, sandbox isolation, and Skills system

## [1.0.0] - 2025-12-01

### Added

- Initial release of Open Cowork — open-source AI agent desktop app with one-click install for Windows and macOS

[Unreleased]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.3.0-sqowe.3...HEAD
[3.3.0-sqowe.3]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.3.0-sqowe.2...v3.3.0-sqowe.3
[3.3.0-sqowe.2]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.3.0-sqowe.1...v3.3.0-sqowe.2
[3.3.0-sqowe.1]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.3.0...v3.3.0-sqowe.1
[3.3.0-beta.8]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.2.0...v3.3.0-beta.8
[3.2.0]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/OpenCoworkAI/open-cowork/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/OpenCoworkAI/open-cowork/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/OpenCoworkAI/open-cowork/compare/v1.0...v2.0.0
[1.0.0]: https://github.com/OpenCoworkAI/open-cowork/releases/tag/v1.0
