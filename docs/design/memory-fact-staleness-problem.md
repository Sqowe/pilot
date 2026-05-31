# Memory Fact Staleness Problem

> Analysis of how facts become outdated in the memory system, industry approaches to solving this,
> and recommendations for Open Cowork.
> Last updated: 2026-05-31

## 1. Problem Statement

When a user states a fact repeatedly over many sessions (e.g., "app version = 2.17" mentioned in 50 chats over months), the memory system indexes this as a durable fact. If the user then changes the value (e.g., "version = 2.25") in a single chat, that one mention cannot reliably override the accumulated weight of all previous mentions.

This manifests in two distinct ways:

### 1.1 Core Memory: Single-Session Update Problem

The core memory profiler processes sessions one at a time. When it sees "version = 2.25" alongside the existing entry "version = 2.17", it _should_ update the entry. The prompt says:

> "Update existing entries when new information refines or contradicts them"

In practice, this works **if** the profiler correctly identifies the contradiction. The risk is:

- The new value is mentioned casually, not emphatically
- The profiler doesn't recognize it as contradicting the existing entry (different phrasing)
- The profiler treats it as a one-off detail not worth storing

**Verdict:** Core memory updates work reasonably well for explicit contradictions. The profiler sees both old and new values side by side and can make the right call. This is the easier problem.

### 1.2 Experience Memory: Accumulated Stale Context

This is the harder problem. Experience memory stores chunks from past sessions. Those 50 older sessions all contain references to "version 2.17" in their raw text, summaries, and details. When the model searches past conversations:

- Query: "what version are we on?"
- Results: 50 chunks mentioning "2.17", 1 chunk mentioning "2.25"
- Scoring: the 50 older chunks have higher aggregate relevance (more keyword matches, more embedding similarity)
- Recency boost: only +0.02 to +0.08 — nowhere near enough to overcome 50:1 ratio

The model receives contradictory information and must guess which is current. With 50 sources saying one thing and 1 saying another, it often picks the majority.

---

## 2. Root Cause Analysis

### 2.1 Vector stores are temporally blind

Embedding-based retrieval has no concept of "which fact supersedes which." A fact stored in January and a fact stored in May occupy the same flat namespace. Similarity search returns whatever is semantically close, regardless of temporal validity.

### 2.2 Experience memory is append-only

Old session chunks are never modified or invalidated. Once a chunk is stored, it persists indefinitely with its original content. There is no mechanism to mark a chunk as "contains stale information."

### 2.3 No structured fact extraction

Experience memory stores narrative chunks ("we decided to use version 2.17 for the release"), not structured facts ("version = 2.17 [valid: Jan–May 2026]"). You cannot invalidate a specific fact within a narrative chunk without rewriting the entire chunk.

### 2.4 Recency boost is insufficient

The current recency boost formula:

```
boost = max(0.02, 0.08 * (1 - daysSinceIngestion / 45))
```

This gives a maximum +0.08 advantage to brand-new chunks, decaying to +0.02 after 45 days. When competing against 50 older chunks that all score 0.6+ on relevance, a +0.08 boost on a single chunk is negligible.

### 2.5 No frequency-aware scoring

The system doesn't track how many times a fact appears across sessions. A fact mentioned 50 times has no explicit "confidence" score — it just happens to appear in more retrievable chunks. There's no mechanism to say "this fact was mentioned 50 times but has been superseded."

---

## 3. Industry Approaches

### 3.1 Temporal Knowledge Graphs (Graphiti/Zep)

**How it works:** Every fact is stored as a graph edge with `valid_from` and `valid_until` timestamps. When a new fact contradicts an old one, the old fact's `valid_until` gets stamped. Retrieval only returns currently-valid facts.

**Example:**

```
(app)-[version: "2.17", valid_from: "2026-01", valid_until: "2026-05"]->()
(app)-[version: "2.25", valid_from: "2026-05", valid_until: null]->()
```

Query "what version?" returns only the entry with `valid_until = null`.

**Pros:** Clean temporal reasoning, full history preserved, deterministic retrieval.
**Cons:** Requires graph database infrastructure, complex to implement, significant architectural change.

**Source:** [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)

### 3.2 Contradiction Detection at Write Time (Mem0)

**How it works:** Before storing a new memory, the system checks if a semantically equivalent memory already exists. If yes, it decides: ADD (no conflict), UPDATE (complement), DELETE+ADD (replace), or NOOP.

**Example:**

```
Incoming: "app version is 2.25"
Existing: "app version is 2.17"
→ Semantic similarity: 0.95 (same topic)
→ Decision: DELETE old + ADD new
```

**Pros:** Simple to implement, works with flat storage, prevents contradiction accumulation.
**Cons:** Requires semantic similarity check on every write (latency), may incorrectly merge unrelated facts.

**Source:** [Mem0 blog — conflict resolution](https://mem0.ai/blog/your-ai-agents-memory-is-just-a-file-thats-the-problem)

### 3.3 Differentiated Temporal Decay (A-MAC Framework)

**How it works:** Different fact types decay at different rates:

| Fact Type                 | Daily Decay | Half-life |
| ------------------------- | ----------- | --------- |
| Preferences               | 0.5%        | ~139 days |
| Facts (versions, configs) | 2%          | ~35 days  |
| Actions (what was done)   | 20%         | ~3 days   |

At retrieval time, recency weighting using exponential decay reduces the score of older memories.

**Pros:** Simple to implement, no structural changes needed, tunable per fact type.
**Cons:** Doesn't solve the structural problem — contradictory facts still exist, just weighted differently. A 50:1 ratio still overwhelms decay.

**Source:** [A-MAC: Agentic Memory Evaluation Framework](https://arxiv.org/html/2603.07670v1)

### 3.4 Dual-Buffer with Probation (TiMem)

**How it works:** New memories go into a "hot" buffer during a probation period. Before promotion to long-term storage, they undergo:

- Re-verification against existing memories
- Deduplication
- Contradiction detection
- Importance scoring

Only memories that pass all checks get promoted.

**Pros:** Catches contradictions before they propagate, filters low-quality extractions.
**Cons:** Adds latency to memory formation, requires a separate verification LLM call.

### 3.5 Bi-Temporal Storage (MinnsDB)

**How it works:** Every fact carries two independent time axes:

- **Valid-time:** When was this fact true in the real world?
- **Transaction-time:** When did the system learn about it?

This enables queries like:

- "What is currently true?" (valid-time filter)
- "What did we know on March 10?" (transaction-time filter)
- "What changed in the last week?" (temporal diff)

**Pros:** Full temporal reasoning, audit trails, can reconstruct past beliefs.
**Cons:** Requires specialized database, significant complexity.

**Source:** [The 5 Memory Problems for Agents](https://dev.to/jonathanfarrow/-how-an-agent-actually-learns-from-experience-2m28)

---

## 4. The "Ghost Context" Problem

The term comes from [this analysis](https://tianpan.co/blog/2026-05-05-ghost-context-agent-memory-contradictory-beliefs): stale beliefs that never die, retrieved alongside their replacements, silently corrupting agent reasoning.

### Four failure modes:

1. **Update blindness** — agent acts on old version because it was retrieved alongside the new one and the model weighted the older entry (more sources = more confidence)

2. **Self-reinforcing errors** — agent incorrectly concludes something, stores it, future retrievals surface the belief, no new evidence collected to refute it

3. **Over-generalization bleed** — lessons from one context contaminate reasoning in a different context

4. **Multi-turn compound failure** — in progressive retrieval, stale context from step 1 influences what gets expanded in step 2

### Key insight from research:

> "The problem is primarily in the **write path**, not the read path. Most teams invest in retrieval optimization — better embeddings, hybrid search, reranking. The contradiction problem is upstream of that."

---

## 5. How This Applies to Open Cowork

### What works well today:

- Core memory updates via upsert — when the profiler correctly identifies a contradiction, it overwrites the old value atomically
- Workspace scoping — experience search is limited to current workspace, reducing cross-domain contamination
- Active retrieval — model decides when to search, reducing unnecessary stale context injection

### What doesn't work:

| Problem                                                                    | Impact                                          | Frequency                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Experience chunks with stale facts never get invalidated                   | Model retrieves outdated info alongside current | High (any fact that changes)                     |
| Recency boost too weak to overcome accumulated old mentions                | Old fact "wins" by volume                       | High (proportional to how long old fact existed) |
| No contradiction detection between core memory and retrieved experience    | Model sees conflicting info without guidance    | Medium                                           |
| Core profiler may miss subtle updates (casual mention, different phrasing) | Core memory stays stale                         | Low-Medium                                       |

---

## 6. Recommendations

### 6.1 Quick Win: Aggressive Core Memory Updates (Effort: Low)

**What:** Strengthen the extraction prompt to be aggressive about versioned/numeric facts.

**Change:** Add to `coreMemoryUpdateSystemPrompt`:

```
CRITICAL: For SPECIFIC VALUES (version numbers, dates, counts, URLs, names,
configurations), the NEWEST mention is ALWAYS the source of truth. If the
session mentions a specific value that differs from an existing entry with
the same key, ALWAYS upsert with the new value. Do not preserve old values
"just in case." The user stated the new value intentionally — that IS the update.
```

**Impact:** Ensures core memory (the profile) stays current. Doesn't fix experience memory staleness.

**Risk:** Low. Worst case: a misheard value gets stored. User can correct in next session.

### 6.2 Medium Effort: Contradiction Annotation at Retrieval Time (Effort: Medium)

**What:** When `search_workspace_chats` returns results, cross-reference them against current core memory. If a retrieved chunk contains a value that contradicts a core memory entry, annotate it.

**Implementation:**

```typescript
// In memory-chat-search-tool.ts, after retrieval:
for (const result of results) {
  const contradictions = findContradictions(result.rawText, coreEntries);
  if (contradictions.length) {
    result.annotation =
      `⚠️ This chunk may contain outdated info. ` +
      `Current values: ${contradictions.map((c) => `${c.key}=${c.currentValue}`).join(', ')}`;
  }
}
```

**Impact:** Model sees explicit warnings about stale data. Can make informed decisions about which value to trust.

**Risk:** Medium. Contradiction detection is imperfect — may produce false positives. Requires a lightweight comparison (could be keyword-based, not LLM-based).

### 6.3 Medium Effort: Stronger Recency Weighting (Effort: Low-Medium)

**What:** Increase the recency boost significantly, especially for chunks that share keywords with newer chunks on the same topic.

**Current:** `max(0.02, 0.08 * (1 - days/45))`
**Proposed:** `max(0.05, 0.25 * (1 - days/90))`

Additionally, add a **supersession penalty**: if a newer chunk from the same workspace covers the same keywords, older chunks on that topic get penalized.

**Implementation:**

```typescript
function supersessionPenalty(chunk, allChunks, currentWorkspace) {
  const newerSameTopicChunks = allChunks.filter(
    (other) =>
      other.sessionDate > chunk.sessionDate &&
      other.sourceWorkspace === currentWorkspace &&
      keywordOverlap(chunk.keywords, other.keywords) > 0.5
  );
  return newerSameTopicChunks.length > 0 ? -0.2 : 0;
}
```

**Impact:** Newer information on the same topic naturally outranks older information.

**Risk:** May suppress legitimately relevant older context. Needs tuning.

### 6.4 Higher Effort: Fact Layer with Contradiction Tracking (Effort: High)

**What:** Extract structured facts from sessions into a separate store. Track when a fact is explicitly contradicted by a newer one — but **never auto-expire facts**.

**Key design principle: Facts don't expire. They get contradicted.**

Not all facts are temporal. "I have 2 daughters" is permanent — it stays true for years. "App version = 2.17" is replaceable — it changes with each release. The system **cannot know in advance** which category a fact belongs to. Therefore:

- **Never auto-expire facts** — no TTL, no time-based decay on facts themselves
- **Only mark as superseded on explicit contradiction** — when a new fact with the same subject arrives with an incompatible value
- **Require high confidence for supersession** — same subject, clearly incompatible values, not just similar topics
- **Reinforcement strengthens facts** — "2 daughters" mentioned 100 times becomes very hard to override by a single ambiguous mention

**New data model:**

```typescript
interface MemoryFact {
  id: string;
  subject: string; // "app_version", "team_size", "daughters_count"
  value: string; // "2.25", "2", "2"
  firstMentioned: string; // ISO date of first occurrence
  lastMentioned: string; // ISO date of most recent mention
  sourceSessionId: string;
  sourceWorkspace: string | null;
  mentionCount: number; // How many sessions mentioned this — higher = harder to override
  supersededBy: string | null; // ID of the contradicting fact (if any)
  supersededAt: string | null; // When it was superseded (if ever)
}
```

Note: `supersededBy` is only set when a **new contradicting fact on the same subject** arrives. "2 daughters" mentioned 100 times will never get superseded unless the user explicitly states a different number. "Version 2.17" gets superseded when "version 2.25" arrives because they share the subject "app_version" with incompatible values.

**What counts as a contradiction (high confidence required):**

| Scenario                               | Contradiction? | Reason                                                          |
| -------------------------------------- | -------------- | --------------------------------------------------------------- |
| "version 2.17" → "version 2.25"        | ✅ YES         | Same subject, different numeric value                           |
| "2 daughters" → "3 kids"               | ❌ NO          | Not clearly incompatible (could be 2 daughters + 1 son)         |
| "2 daughters" → "2 daughters"          | ❌ NO          | Reinforcement, not contradiction                                |
| "prefer tabs" → "use spaces now"       | ✅ YES         | Same subject (indentation), explicit replacement ("now")        |
| "we use React" → "migrating to Svelte" | ⚠️ MAYBE       | "Migrating" implies transition, not completion — low confidence |

**Supersession should be proportional to mention count:** A fact mentioned 50 times should require stronger evidence to override than a fact mentioned once. Possible formula:

```typescript
function shouldSupersede(oldFact: MemoryFact, newMention: string): boolean {
  // High-mention facts need explicit, unambiguous contradiction
  if (oldFact.mentionCount > 10) {
    return isExplicitContradiction(oldFact.value, newMention); // strict check
  }
  // Low-mention facts can be overridden more easily
  return isLikelyContradiction(oldFact.value, newMention); // relaxed check
}
```

**Pipeline addition:**

```
Session ingested
    │
    ├─ (existing) Extract experience chunks
    ├─ (existing) Update core memory
    └─ (NEW) Extract structured facts
              │
              ├─ If fact already exists with same subject+value: increment mentionCount
              ├─ If fact exists with same subject but DIFFERENT value:
              │     assess contradiction confidence
              │     if HIGH confidence: mark old fact supersededBy = new fact
              │     if LOW confidence: store both, let retrieval sort it out
              └─ If no existing fact on this subject: store new fact
```

**At retrieval time:** When experience chunks are returned, cross-reference the fact store. If a chunk references a superseded fact, annotate it: "⚠️ This chunk mentions version 2.17, which was updated to 2.25 on [date]." Never filter/hide — just annotate.

**Impact:** Facts that genuinely change get tracked. Permanent facts stay strong forever (reinforced by mention count). The system doesn't guess about expiry — it only acts on clear contradictions.

**Risk:** Significant implementation effort. Contradiction detection is hard to get right — false positives could suppress valid facts. Requires careful subject-matching logic (or an LLM call per comparison). The `mentionCount` threshold needs tuning.

### 6.5 Higher Effort: Write-Time Contradiction Detection for Experience Memory (Effort: High)

**What:** When a new session is ingested, check if its chunks contradict existing chunks. If they do, mark the old chunks as "contains superseded information."

**Implementation:**

```typescript
// During ingestion, after extracting new chunks:
for (const newChunk of extractedChunks) {
  const similar = experienceStore.findSimilar(newChunk.embedding, threshold: 0.85);
  for (const oldChunk of similar) {
    if (isContradiction(newChunk, oldChunk)) {
      oldChunk.supersededAt = new Date().toISOString();
      oldChunk.supersededBy = newChunk.id;
    }
  }
}

// During retrieval, penalize superseded chunks:
if (chunk.supersededAt) {
  score *= 0.3; // Heavy penalty
}
```

**Impact:** Old chunks with stale facts get naturally deprioritized in retrieval.

**Risk:** Contradiction detection between narrative chunks is hard. May require an LLM call per comparison (expensive). False positives could suppress valid context.

### 6.6 Architectural: Migrate to Temporal Knowledge Graph (Effort: Very High)

**What:** Replace the flat JSON storage with a temporal knowledge graph (like Graphiti/Zep or a custom implementation on top of SQLite).

**Pros:** Solves the problem completely and permanently. Enables temporal queries, audit trails, multi-hop reasoning.

**Cons:** Massive architectural change. Requires graph traversal logic, temporal query language, migration of existing data. Overkill for a single-user desktop app unless the memory system is a core differentiator.

**Verdict:** Not recommended for now. The simpler approaches (6.1–6.5) address the immediate pain. Revisit if memory becomes a product-level feature with multi-user requirements.

---

## 7. Recommended Implementation Order

| Priority | Recommendation                                | Effort     | Impact                                      |
| -------- | --------------------------------------------- | ---------- | ------------------------------------------- |
| 1        | 6.1 — Aggressive core memory updates          | Low        | Fixes core memory staleness                 |
| 2        | 6.3 — Stronger recency + supersession penalty | Low-Medium | Reduces experience staleness                |
| 3        | 6.2 — Contradiction annotation at retrieval   | Medium     | Model gets explicit warnings                |
| 4        | 6.4 — Fact layer with contradiction tracking  | High       | Comprehensive long-term solution            |
| 5        | 6.5 — Write-time contradiction detection      | High       | Prevents ghost context accumulation         |
| —        | 6.6 — Temporal knowledge graph                | Very High  | Deferred unless memory becomes core product |

### Suggested first iteration:

Implement **6.1 + 6.3** together. This gives:

- Core memory always reflects the latest stated value (prompt fix)
- Experience retrieval naturally favors newer information on the same topic (scoring fix)
- No structural changes to storage format
- Minimal code changes, testable immediately

### Suggested second iteration:

Add **6.2** (contradiction annotation). This gives the model explicit guidance when it encounters stale experience chunks, without requiring changes to how chunks are stored.

### Long-term:

If staleness remains a problem after iterations 1–2, implement **6.4** (fact layer with contradiction tracking). This is the proper engineering solution but requires careful design around:

- What constitutes a "fact" vs narrative context
- How to extract facts reliably (another LLM call)
- How to match incoming facts against existing ones (subject identification)
- **Crucially: how to distinguish replaceable facts from permanent ones** — the answer is you don't. You never auto-expire. You only react to explicit contradictions, and you weight contradiction confidence against mention count (a fact mentioned 100 times needs very strong evidence to override).

---

## 8. References

- [Ghost Context: How Contradictory Beliefs Break Long-Running Agent Memory](https://tianpan.co/blog/2026-05-05-ghost-context-agent-memory-contradictory-beliefs) — Comprehensive analysis of the contradiction problem in production agent memory systems.
- [The 5 Memory Problems for Agents](https://dev.to/jonathanfarrow/-how-an-agent-actually-learns-from-experience-2m28) — Bi-temporal storage, contradiction detection, confidence evolution.
- [Mem0: Your AI Agent's Memory Is Just a File](https://mem0.ai/blog/your-ai-agents-memory-is-just-a-file-thats-the-problem) — Why flat-file memory breaks at scale, conflict resolution approaches.
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) — Graphiti engine, temporal edges, validity windows.
- [LongMemEval (ICLR 2025)](https://arxiv.org/html/2501.13956v1) — Benchmark showing 30% accuracy drop on knowledge-update tasks in commercial assistants.
- [A-MAC: Agentic Memory Evaluation](https://arxiv.org/html/2603.07670v1) — Differentiated temporal decay rates by fact type.

---

## 9. Open Questions

1. **Should experience chunks be mutable?** Currently they're append-only. Adding a `supersededAt` field would require schema migration and changes to the retrieval pipeline. Alternative: never mutate chunks, only annotate at retrieval time.

2. **How to detect contradictions without LLM calls?** Keyword overlap + value extraction (regex for numbers, URLs, versions) could catch the most common cases cheaply.

3. **Should the user be notified of contradictions?** When the system detects that a new fact contradicts an old one, should it surface this to the user for confirmation?

4. **What about facts that are context-dependent?** "Version 2.17" might be correct for one branch/environment and "2.25" for another. The system currently has no way to represent conditional facts.

5. **How does this interact with workspace scoping?** If a fact changes in workspace A, should it invalidate the same fact in workspace B's experience memory? Or are they independent?

6. **How to handle the "permanent fact" problem?** Not all facts are temporal. "I have 2 daughters" is true indefinitely. The system must never auto-expire facts based on age alone. Supersession should only happen on explicit contradiction — and even then, a fact reinforced by many mentions (high `mentionCount`) should require proportionally stronger evidence to override. A single ambiguous mention should never override 100 consistent prior mentions.
