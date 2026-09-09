# Plugin-as-Agent: Future Upgrade Path

**Status:** Future / Exploratory
**Date:** 2026-06-11
**Author:** Mike Obodnikov + Kiro
**Depends on:** `plugin-archive-install-and-pin.md` (Phase 1-3 must ship first) —
**satisfied**: that work shipped and its design is now in
[`archive/plugin-archive-install-and-pin.md`](./archive/plugin-archive-install-and-pin.md).
**Scope:** `agent-runner.ts`, `session-manager.ts`, new `plugin-agent-adapter.ts`, renderer

---

> ## 🔄 Re-checked against pi 0.85.1 — 2026-09-09
>
> **Unblocked, and cheaper than costed.** The comparison table below ends on "Requires new
> agent dispatch subsystem", which was accurate in June. It is no longer the starting point:
> pi ships a **working subagent extension as an example** —
> `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` — with a 36 KB
> `index.ts`, its own `README.md`, a `prompts/` directory, and `agents.ts` that discovers
> agents from markdown files whose frontmatter carries `name`, `description`, `tools`,
> `model` and `systemPrompt`.
>
> That is the same shape as the Vision above: an agent with its own system prompt, its own
> tool subset, and its own model. The example is actively maintained — 0.84.3 fixed it
> re-prompting before running project-local agents in trusted repositories.
>
> **So the question changes** from "should we build a dispatch subsystem?" to "does adapting
> pi's example fit our plugin model?" Read the example first; only then re-cost this plan.
>
> **Two caveats before adopting it.** It is an _example_, not a supported API surface — it can
> change between releases without a breaking-change note, so treat it as a reference
> implementation to learn from rather than a dependency. And it discovers agents from
> `CONFIG_DIR_NAME` / `getAgentDir()` locations, which is the `~/.pi/` tree shared with the
> user's CLI — the same boundary that rules out pi's session and trust storage
> (`ARCHITECTURE.md` §4.1). Any adaptation must source its agent definitions from our own
> plugin store instead.

---

## Vision

Transform a plugin from a passive skill bundle into an **active agent** that the user can activate for a session. When a plugin is activated as agent:

- Its orchestrator skill becomes the agent's system prompt
- The agent owns routing decisions for its domain
- Individual skills become the agent's internal tools (not exposed to the user)
- The user talks to "the business planning agent" — not to 37 individual skills

This is the most natural UX for complex bundles like `bizplan-skills`, mirroring Claude Code's `settings.json → "agent"` pattern.

---

## Motivation: Why Go Beyond Plugin Pinning?

Plugin pinning (from the Phase 3 design) gives the LLM a hint: "use pvt-business-plan as entry point." But:

| Plugin Pinning                                     | Plugin-as-Agent                                     |
| -------------------------------------------------- | --------------------------------------------------- |
| LLM gets a hint, may still invoke wrong skills     | Agent system prompt forces correct routing          |
| All 37 skill descriptions still loaded on the path | Only orchestrator prompt + skill names in context   |
| User must still understand individual skills       | User just talks to "the agent"                      |
| No isolation — other pinned skills may interfere   | Agent has its own context, model, tool restrictions |
| Works today with current architecture              | Requires new agent dispatch subsystem               |

Plugin-as-Agent is the **end state** for professional plugin bundles. Plugin pinning is the **pragmatic middle ground** that ships now.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ User activates "bizplan-skills" as session agent                 │
│                                                                  │
│   ┌─────────────────────┐                                        │
│   │  Plugin Agent Shell  │                                       │
│   │                      │                                       │
│   │  System prompt:      │                                       │
│   │  pvt-business-plan   │                                       │
│   │  SKILL.md content    │                                       │
│   │                      │                                       │
│   │  Available tools:    │                                       │
│   │  - mom-test          │  (internal, not user-visible)         │
│   │  - lean-canvas       │                                       │
│   │  - market-researcher │                                       │
│   │  - saas-financial-   │                                       │
│   │    projections       │                                       │
│   │  - ...               │                                       │
│   │                      │                                       │
│   │  Also has:           │                                       │
│   │  - File read/write   │  (standard tools)                     │
│   │  - Web search        │                                       │
│   │  - docx/xlsx skills  │  (builtin, for output)                │
│   └──────────┬───────────┘                                       │
│              │                                                    │
│              ▼                                                    │
│   User: "Составь бизнес-план для моей SaaS компании"             │
│              │                                                    │
│              ▼                                                    │
│   Agent decides: invoke market-researcher → competitive-analyst  │
│   → saas-financial-projections → lean-canvas → draft sections    │
│   → produce docx output                                          │
│                                                                  │
│   User sees: coherent multi-step work, not raw skill invocations │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Sketch

### 1. Plugin Agent Definition (derived from plugin data)

No new files needed in the plugin archive. The system generates an agent definition at runtime:

```typescript
interface PluginAgentConfig {
  pluginId: string;
  name: string; // plugin.name
  description: string; // plugin.description
  systemPrompt: string; // orchestrator SKILL.md content (full)
  availableSkills: string[]; // sibling skill names
  model?: string; // from plugin metadata or user config
  maxTurns?: number; // safety limit
  allowedBuiltinSkills?: string[]; // e.g. ["docx", "xlsx"] for output
}
```

### 2. Activation Modes

| Mode                   | Behavior                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Session agent**      | Plugin agent becomes the default responder for the session. All messages routed through its system prompt.                    |
| **On-demand subagent** | Plugin agent available as a delegatable subagent. Main agent can invoke it: "delegate to bizplan-skills agent for this task." |
| **Auto-detect**        | If user message matches plugin keywords, suggest activating the plugin agent (toast/prompt).                                  |

For v1, implement **on-demand subagent** — safest, least disruptive.

### 3. Skill Isolation

When a plugin is activated as agent:

- Its skills are **removed from the global skill paths** (no duplicate descriptions)
- They become **internal tools** of the plugin agent only
- The agent's system prompt (orchestrator SKILL.md) already knows how to route to them
- This dramatically reduces global context cost

```typescript
// agent-runner.ts — resolveSkillPaths modification
if (pluginActivatedAsAgent(plugin)) {
  // Don't add this plugin's skills/ to the global path
  // They're handled internally by the plugin agent
  continue;
}
```

### 4. Communication Pattern

```
User message
    │
    ▼
Main Agent (standard system prompt)
    │
    ├── Is this a business planning task? → YES
    │       │
    │       ▼
    │   Invoke plugin agent: bizplan-skills
    │       │
    │       ├── Plugin agent reads orchestrator prompt
    │       ├── Decides: need market research first
    │       ├── Loads market-researcher SKILL.md internally
    │       ├── Executes research (web tools, firecrawl)
    │       ├── Loads saas-financial-projections
    │       ├── Builds the financial model
    │       ├── Loads lean-canvas for positioning
    │       ├── Assembles the full plan
    │       ├── Calls docx skill to produce output
    │       └── Returns: "Here's your business plan [docx attached]"
    │
    ▼
Main Agent: presents result to user
```

### 5. Implementation Components

#### `src/main/skills/plugin-agent-adapter.ts` (new file)

```typescript
export class PluginAgentAdapter {
  /**
   * Generate a subagent definition from an installed plugin.
   * Only works for plugins with a detected orchestrator skill.
   */
  buildAgentConfig(plugin: InstalledPlugin): PluginAgentConfig | null {
    if (!plugin.orchestratorSkill) return null;

    const orchestratorPath = path.join(
      plugin.runtimePath,
      'skills',
      plugin.orchestratorSkill,
      'SKILL.md'
    );
    if (!fs.existsSync(orchestratorPath)) return null;

    const systemPrompt = fs.readFileSync(orchestratorPath, 'utf8');
    const siblingSkills = this.listSiblingSkills(plugin);

    return {
      pluginId: plugin.pluginId,
      name: plugin.name,
      description: plugin.description || `Agent for ${plugin.name}`,
      systemPrompt,
      availableSkills: siblingSkills,
      maxTurns: 30,
      allowedBuiltinSkills: ['docx', 'xlsx', 'pdf'],
    };
  }

  private listSiblingSkills(plugin: InstalledPlugin): string[] {
    const skillsDir = path.join(plugin.runtimePath, 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== plugin.orchestratorSkill)
      .map((e) => e.name);
  }
}
```

#### Agent dispatch integration

The Pi SDK's `createAgentSession` would need to support either:

- A custom tool that "calls another agent session" (subagent pattern)
- Or a prompt-based delegation where the main agent's output triggers a new scoped session

This depends on Pi SDK capabilities (currently pre-1.0, evolving).

---

## UX Concepts

### Welcome Screen

```
┌─────────────────────────────────────────────────────────┐
│ Start a new conversation                                 │
│                                                          │
│ Available agents:                                        │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 🤖 Default (general assistant)              [active] │ │
│ │ 📊 bizplan-skills — Business planning agent          │ │
│ │ 🔬 research-toolkit — Research assistant             │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ Pin skills: [pdf] [docx] [semantic-index]                │
└─────────────────────────────────────────────────────────┘
```

### Mid-Session Activation

```
┌─────────────────────────────────────────────────────────┐
│ User: "I need to write a business plan for ПВТ"          │
│                                                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 💡 The bizplan-skills plugin can handle this.         │ │
│ │    Activate as agent for this task?                   │ │
│ │    [Activate] [No, I'll handle it]                    │ │
│ └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Token Impact Comparison

| Approach                 | Global context cost                                         | Per-query overhead                                  |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------- |
| All skills loaded flat   | 37 × 40 = 1480 tok                                          | Each query scans all 37 descriptions                |
| Plugin pinning (Phase 3) | ~70 tok directive + 37 × 40 skill metadata                  | Better routing, same skill metadata                 |
| Plugin-as-Agent          | ~70 tok for agent availability + 0 skill metadata in global | Only orchestrator prompt loaded in agent subcontext |

Plugin-as-Agent is the **zero-waste** option for the global context — skills only exist inside the agent's scope.

---

## Prerequisites

Before implementing this:

1. ✅ Plugin archive install (Phase 1 of companion design)
2. ✅ Orchestrator detection (Phase 2 of companion design)
3. ✅ Plugin pinning working and validated (Phase 3 of companion design)
4. 🔲 Pi SDK subagent/delegation support stabilized
5. 🔲 Agent runner supports scoped tool sets per subagent
6. 🔲 Renderer supports agent selection UI

---

## Open Questions

1. **Model selection per plugin agent:** Should plugin agents use the same model as the main session or allow override? (Cost vs quality tradeoff for long multi-step tasks)

2. **Context isolation:** Should the plugin agent share conversation history with the main agent, or start fresh with only the delegated task?

3. **Interruption:** If the plugin agent is working on a 6-section business plan, can the user interrupt/redirect mid-flow? How does partial work get surfaced?

4. **Skill access boundaries:** Should the plugin agent ONLY access its own skills, or also builtin skills (docx, xlsx, web search)? Current design says yes to builtins needed for output.

5. **Multiple active agents:** Can two plugin agents be active simultaneously? (e.g., bizplan agent + research agent collaborating)

6. **Fallback:** If the orchestrator SKILL.md is too long for a system prompt (~5000 tokens for pvt-business-plan), should it be truncated or summarized?

---

## Relationship to Claude Code's Plugin System

Claude Code already has this pattern:

- `settings.json` at plugin root with `{"agent": "agent-name"}` activates an agent
- Plugin agents appear in `/agents` interface
- Agents have `name`, `description`, `model`, `maxTurns`, `tools`, `disallowedTools`

Our implementation would follow the same mental model but adapt it to Open Cowork's session-based architecture (Pi SDK + Electron) rather than Claude Code's CLI architecture.

---

## Timeline Estimate

| Phase                       | Effort       | Depends on                             |
| --------------------------- | ------------ | -------------------------------------- |
| Design validation           | 1 week       | Plugin pinning shipped + user feedback |
| Pi SDK subagent exploration | 2 weeks      | SDK pre-1.0 stabilization              |
| Plugin agent adapter        | 1 week       | Above                                  |
| Agent dispatch integration  | 2 weeks      | Agent runner refactor                  |
| UI (welcome + mid-session)  | 1 week       | Agent dispatch working                 |
| Testing + polish            | 1 week       | All above                              |
| **Total**                   | **~8 weeks** | After Phase 3 ships                    |

This is a significant investment. Only pursue if:

- Users with 20+ skill plugins report poor routing quality with pinning alone
- Pi SDK matures to support scoped subagents cleanly
- There's demand for "agent marketplace" (install a domain agent, not just skills)

---

## References

- Claude Code `settings.json` agent key: https://code.claude.com/docs/en/plugins-reference#file-locations-reference
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Current Pi SDK agent session API: `createAgentSession()` in `@earendil-works/pi-coding-agent`
- Plugin pinning design: `docs/design/plugin-archive-install-and-pin.md`
