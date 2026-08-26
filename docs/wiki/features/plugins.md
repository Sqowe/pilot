<!-- sources: src/renderer/components/settings/SettingsSkills.tsx, src/main/skills/plugin-runtime-service.ts, src/main/skills/plugin-registry-store.ts, src/main/skills/plugin-catalog-service.ts, src/renderer/components/ContextPanel.tsx, docs/design/archive/plugin-archive-install-and-pin.md -->

# Plugins

## What it is / when to use it

A **plugin** is a bundle — one or more skills, commands, agents, hooks, and MCP configs —
packaged as a unit. Installing a plugin brings in everything it contains; you can then enable
or disable individual components. Plugins come from the **Claude marketplace** or from a
local `.plugin` / `.zip` archive.

Reach for this when: you want to add a coherent set of capabilities at once (rather than
one skill at a time), or you've downloaded a plugin archive to install.

## How to use it

1. Open **Settings → Skills → Plugins & Imports**.
2. **Browse Plugins** to search the marketplace, or **Import Plugin** to load a local
   `.plugin`/`.zip` archive.
3. Click **Install**. At install time, the plugin is scanned for an **orchestrator** entry
   point (a skill that coordinates/delegates); if found, it's advertised to the agent.
4. Click **Manage** on an installed plugin to enable/disable it or its components. For
   safety, **hooks** and **MCP** components are disabled by default and must be turned on
   explicitly after install.
5. **Uninstall** removes the plugin and its runtime files.

### Pin a plugin for a session

Pinning an entire plugin injects a compact directive into the prompt (~60–80 tokens) telling
the agent to prioritize it — far cheaper than pinning each of its skills individually (~1480
tokens), and it bypasses the 10-skill pinning cap. In the **Context Panel → Plugins**, click
**Pin plugin** / **Unpin plugin**.

![Plugins in Settings](../assets/plugins-settings.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/plugins-settings.png

## Commands & settings

| Action                | How to run                                                 |
| --------------------- | ---------------------------------------------------------- |
| Browse marketplace    | Settings → Skills → **Browse Plugins**                     |
| Import archive        | Settings → Skills → **Import Plugin** (`.plugin` / `.zip`) |
| Manage components     | Installed plugin → **Manage**                              |
| Pin plugin to session | Context Panel → Plugins → **Pin plugin**                   |
| Uninstall             | Installed plugin → **Uninstall**                           |

**Related guides:** [Skills](skills.md), [Pin skills & profiles](skill-pinning-and-profiles.md).
Archive imports are protected against path traversal and oversized entries.

---

[← All docs](../index.md)
