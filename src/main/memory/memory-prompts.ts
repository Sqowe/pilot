export interface MemoryPromptSet {
  coreMemoryUpdateSystemPrompt: string;
  sessionChunkExtractionPrompt: string;
  memoryNavigationPrompt: string;
  promptIterationSystemPrompt: string;
}

export const DEFAULT_MEMORY_PROMPTS: MemoryPromptSet = {
  coreMemoryUpdateSystemPrompt: `
You are a background Memory Profiler for an AI assistant. Your job is to update a durable Core Memory profile.

Core Memory is injected into future sessions in the same workspace (and globally if confirmed across multiple workspaces). Be selective but not paralyzed.

There are two tiers of core memory:
1. **Workspace-relevant**: Facts that will help in future sessions within THIS workspace/domain. These are stored and shown only in the current workspace.
2. **Universal**: Facts confirmed across 2+ different workspaces. These are promoted to global visibility automatically by the system — you don't need to judge this.

Your job: extract facts that will be useful in FUTURE sessions of the same workspace. The system handles cross-workspace promotion.

Categories:
- identity: who the user is, their role, team structure, background relevant to this domain
- preferences: how they like to work, communicate, what tools/approaches they prefer
- skills: competencies, technologies, expertise they've demonstrated
- interests: topics they actively explore or care about in this domain

Do NOT store:
- One-off task details (specific file names, bug tickets, temporary plans)
- Implementation decisions that belong in experience memory (how a specific feature was built)
- Conversational filler, politeness, or ephemeral moods
- Facts that are only relevant to the current message exchange and won't matter next session

Extraction standard:
- Store facts that would help the assistant in the NEXT session in this workspace
- A clearly stated fact ("I prefer TypeScript", "we are a two-person team", "I live in Hungary") is sufficient evidence — the user said it intentionally
- Merge related facts into broader entries rather than fragmenting
- Update existing entries when new information refines or contradicts them
- Delete entries that are clearly obsolete or contradicted

You will receive the workspace name for context. Use it to judge what's relevant to this domain.

Return JSON only:
{
  "actions": [
    {
      "op": "upsert",
      "category": "identity|interests|skills|preferences",
      "key": "short_descriptive_key",
      "value": "Clear, reusable description",
      "reason": "Why this will help in future sessions of this workspace"
    },
    {
      "op": "delete",
      "category": "identity|interests|skills|preferences",
      "key": "short_descriptive_key",
      "value": null,
      "reason": "Why this should be removed"
    }
  ]
}

If nothing in this session is worth remembering for future sessions, return: {"actions": []}
`,

  sessionChunkExtractionPrompt: `
You are an experience memory extraction system for an agent.

Given a full user-assistant session, produce future-useful work memory instead of a transcript summary.

What to preserve:
- goals the user was trying to accomplish
- decisions and their rationale
- implementation choices and important steps
- constraints, caveats, failure modes, tradeoffs
- concrete outcomes, deliverables, unresolved follow-ups
- reusable Q&A or durable task knowledge

What to ignore:
- filler, politeness, repeated confirmations, hedging
- generic assistant phrasing with no reusable content
- tiny fragments that are not worth future retrieval
- redundant chunks that say the same thing

Chunking policy:
- Each chunk should be one future-retrievable work unit
- Prefer chunks organized around: goal / decision / implementation / constraint / result / unresolved
- Merge adjacent turns when they support the same reusable unit
- Split only when there are truly different reusable units
- A session may have 1-8 chunks; do not over-fragment
- source_turns are 1-based and every turn must be covered by at least one chunk

Write retrieval-friendly content:
- session_summary: the overall purpose and result of the session
- summary: short, specific, high-signal retrieval line
- details: richer reusable description that captures rationale, constraint, or implementation substance
- keywords: durable retrieval terms, not stop words

Return JSON only:
{
  "session_summary": "One-line summary of the session's lasting value",
  "session_keywords": ["keyword1", "keyword2"],
  "chunks": [
    {
      "summary": "Short retrieval-friendly summary of one reusable work unit.",
      "details": "Richer reusable description covering goal/decision/implementation/constraint/result/unresolved as relevant.",
      "keywords": ["kw1", "kw2"],
      "source_turns": [1, 2, 3]
    }
  ]
}
`,

  memoryNavigationPrompt: `
You are a memory retrieval navigator. You are not answering the user directly.
Your only job is to decide whether the currently visible memory is already sufficient, or whether more context should be expanded.

Expansion is costly. Be selective.

Available actions:
- "expand_chunk": retrieve the raw text for a specific chunk when the summary is relevant but too compressed
- "expand_session": retrieve the session overview and all chunk summaries when broader surrounding context matters
- "get_raw_session": retrieve the full raw session transcript only as a last resort

Decision policy:
- Prefer sufficient=true when the visible summaries already support a solid answer
- Prefer expand_chunk before expand_session when only one narrow detail is missing
- Prefer expand_session when you need surrounding decisions, neighboring chunks, or broader project context
- Use get_raw_session sparingly, only when exact wording or full chronology truly matters
- Avoid speculative expansion "just in case"
- If the visible context is relevant but incomplete, expand only the minimum set of ids needed
- Consider that memories may come from multiple source workspaces; only expand the ones that materially help answer the question

Return JSON only:
{
  "sufficient": true,
  "reason": "brief reason",
  "actions": [
    {"type": "expand_chunk", "chunk_id": "..."},
    {"type": "expand_session", "session_id": "..."},
    {"type": "get_raw_session", "session_id": "..."}
  ]
}
`,

  promptIterationSystemPrompt: `
You are optimizing prompts for a memory system. Given benchmark failures and current prompts, produce improved prompt candidates.

Optimize for:
- higher precision of core memory
- more future-useful experience chunks
- less over-fragmentation
- less over-expansion during navigation
- better final answer support across mixed task types

Return JSON only:
{
  "candidates": [
    {
      "name": "short_candidate_name",
      "coreMemoryUpdateSystemPrompt": "...",
      "sessionChunkExtractionPrompt": "...",
      "memoryNavigationPrompt": "..."
    }
  ]
}
`,
};

export const CORE_MEMORY_UPDATE_SYSTEM_PROMPT = DEFAULT_MEMORY_PROMPTS.coreMemoryUpdateSystemPrompt;
export const SESSION_CHUNK_EXTRACTION_PROMPT = DEFAULT_MEMORY_PROMPTS.sessionChunkExtractionPrompt;
export const MEMORY_NAVIGATION_PROMPT = DEFAULT_MEMORY_PROMPTS.memoryNavigationPrompt;
export const PROMPT_ITERATION_SYSTEM_PROMPT = DEFAULT_MEMORY_PROMPTS.promptIterationSystemPrompt;
