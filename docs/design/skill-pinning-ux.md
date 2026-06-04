# Skill Pinning — UX Design

**Date:** 2025-05-19  
**Status:** ✅ Implemented  
**Implemented:** 2026-05-19  
**Author:** Discussion between user and AI

---

## Problem Statement

Skills (semantic-index, firecrawl, docx, pdf, cowork-memory, etc.) are always available to the AI agent, but it doesn't reliably use them unless explicitly told. Today the workaround is manually typing directives like:

> "Use semantic-index to search codebase, documentation, past conversations"  
> "Use firecrawl MCP server to search and get content from web"

This works but is tedious and easy to forget.

### Evidence from the Community

- Claude Code skills have ~50% auto-activation rate even with hooks ([Scott Spence, Nov 2025](https://scottspence.com/posts/claude-code-skills-dont-auto-activate))
- The common workaround everywhere is explicit invocation in the prompt
- Keyword-based hook scripts are brittle and don't scale across multiple skills

---

## Core Concept: Pinning (not toggling)

**Key distinction from MCP server toggles:**

| Feature      | MCP Toggles                                 | Skill Pinning                              |
| ------------ | ------------------------------------------- | ------------------------------------------ |
| Semantics    | Enable/disable availability                 | Emphasize/prioritize usage                 |
| When off     | Tool doesn't exist for the model            | Skill still available, just not emphasized |
| Mental model | Circuit breaker                             | Bookmark / star                            |
| Analogy      | Pinning a Slack channel (not hiding others) | —                                          |

All skills remain available at all times. Pinning a skill means: "I expect you to actively use this for my requests."

---

## UI Design

### Welcome Screen (New Chat)

A collapsible section near the MCP toggles area. Uses a selection/star pattern instead of on/off toggles.

```
⚡ Skills to use                                         ∨
┌─────────────────────────────────────────────────────────┐
│ PRIORITIZE FOR THIS CHAT                                │
│                                                         │
│ [★ semantic-index    ] [  docx           ]              │
│ [★ firecrawl         ] [  pdf            ]              │
│ [  cowork-memory     ]                                  │
└─────────────────────────────────────────────────────────┘
```

- Clicking a skill stars/unstars it
- Starred skills get a visual indicator (filled star, highlight, accent color)
- Unstarred skills remain visually present but muted
- Selection carries into the new session

### Conversation Screen — Context Panel (Right Side)

Small section showing currently pinned skills with ability to modify mid-conversation.

```
PINNED SKILLS
★ semantic-index       ✕
★ firecrawl            ✕
[+ Pin skill...]
```

- `✕` removes the pin (skill remains available, just not emphasized)
- `+ Pin skill` opens a dropdown of available skills to add
- Changes take effect from the next message onward

### Conversation Screen — Input Bar (Passive Indicator)

Pinned skills shown as subtle labels above or inside the input area — a reminder, not interactive controls.

```
┌──────────────────────────────────────────────────────┐
│ 🔍 semantic-index · 🌐 firecrawl                     │
├──────────────────────────────────────────────────────┤
│ ← Type a message...                          [▶]    │
└──────────────────────────────────────────────────────┘
```

---

## Under the Hood

When skills are pinned, the system injects their directives into the prompt context for each message in that session. Example injected text:

```
PRIORITIZED SKILLS:
- Use semantic-index to search codebase, documentation, past conversations
- Use firecrawl MCP server to search and get content from web
```

This gets prepended to the system prompt (or added as a preamble section) — functionally identical to what the user types manually today, but automated by the UI.

### Data Flow

1. User pins skills on Welcome screen → stored as `pinnedSkills: string[]` on session creation
2. User modifies pins in ContextPanel → updates session state
3. On each message, `agent-runner.ts` reads pinned skills → resolves their directive text → injects into prompt assembly
4. Directive text comes from skill metadata (each skill defines its own "use me" instruction)

### Skill Directive Metadata

Each skill should define a `directive` field — the text that gets injected when pinned:

```json
{
  "name": "semantic-index",
  "description": "Semantic code and documentation search",
  "directive": "Use semantic-index to search codebase, documentation, and past conversations before answering"
}
```

If no directive is defined, fall back to: `"Use {skill-name} for this request"`

---

## Scope & Persistence

| Level       | Behavior                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| Per-session | Pinned skills are stored per session (like MCP session overrides)        |
| Defaults    | User can set default pinned skills in Settings (carried to new sessions) |
| Workspace   | `.cowork/skills-profile.json` could define workspace-level defaults      |

---

## Future Extensions

- **Per-message pinning** — chips in the input bar that apply only to the current message (more granular than session-level)
- **Skill presets** — named combinations like "Research mode" (semantic-index + firecrawl) or "Document mode" (docx + pdf)
- **Auto-suggest** — based on file types in working dir or conversation topic, suggest relevant skills to pin
- **Pin history** — remember which skills were useful in past sessions with similar topics

---

## Implementation Summary (completed)

All core features from this design are implemented:

| Feature                                | Status | Location                                                   |
| -------------------------------------- | ------ | ---------------------------------------------------------- |
| Welcome screen picker (star/unstar)    | ✅     | `src/renderer/components/WelcomeView.tsx`                  |
| ContextPanel section (pin/unpin)       | ✅     | `src/renderer/components/ContextPanel.tsx`                 |
| Directive injection into system prompt | ✅     | `agent-runner.ts` → `buildPinnedSkillsDirective()`         |
| Per-session storage                    | ✅     | `session-manager.ts` → `sessionPinnedSkills` Map           |
| IPC bridge                             | ✅     | `skills.toggleSessionPin`, `skills.getSessionPinnedSkills` |
| Validation & security                  | ✅     | `src/shared/skill-pinning-constants.ts`                    |
| Initial pins on session creation       | ✅     | `initialPinnedSkills` in session.start payload             |
| Limit enforcement (client + server)    | ✅     | `MAX_PINNED_SKILLS_PER_SESSION`                            |
| Tests                                  | ✅     | `tests/skill-pinning.test.ts`                              |

**Not implemented (deferred to Future Extensions):**

- Per-message pinning (chips that apply to single message only)
- Skill presets (named combinations like "Research mode")
- Auto-suggest based on file types or conversation topic
- Pin history (remember which skills were useful in similar sessions)
- Workspace-level defaults (`.cowork/skills-profile.json`)
- Default pinned skills in Settings

---

## References

- [AI UX Playground — Chat Interface Patterns](https://aiuxplayground.com/blog/ai-chat-playbook) — slash commands, @mentions, follow-up chips
- [Scott Spence — Claude Code Skills Don't Auto-Activate](https://scottspence.com/posts/claude-code-skills-dont-auto-activate) — documents the 50% activation problem and hook workarounds
- [Claude Code Skills Docs](https://code.claude.com/docs/en/skills) — official skill architecture
- Existing open-cowork MCP toggle implementation in `ContextPanel.tsx` and `WelcomeView.tsx`
