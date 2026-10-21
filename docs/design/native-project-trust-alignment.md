# Native Project-Trust Alignment — Design & Investigation Plan

**Created:** 2026-07-17
**Status:** Phase 0 — not started. Investigation-first; **no code** until the phase-2 design
is approved and security-reviewed.
**Author:** AI-assisted design session
**Provenance:** Extracted from
[`pi-sdk-080-feature-adoption-plan.md`](./archive/pi-sdk-080-feature-adoption-plan.md) §4.2 on
2026-07-17. That plan is an _opportunistic SDK-adoption_ track; project-trust is a security
boundary and does not belong in it.
**Security classification:** **High.** These gates decide whether an LLM-driven agent may act
on the user's machine.

---

> ## ⚠️ Re-checked against pi 0.85.1 — 2026-09-09
>
> **The naive reading of "align with native project trust" is not available to us, and would
> be a security hole if taken literally.** pi stores trust decisions in
> `join(resolvePath(agentDir), "trust.json")` — `~/.pi/agent/trust.json`
> (`dist/core/trust-manager.js:173`). That is the same shared location as pi's session files,
> and the SDK-only boundary (`ARCHITECTURE.md` §4.1) rules it out for the same reason, only
> with higher stakes: marking a project trusted in this app would mark it trusted for the
> user's `pi` CLI in a terminal, and the reverse. Trust decides what the agent may do, so
> the two products silently sharing that state is worse than sharing conversation history.
>
> **The mechanism is still usable, with our own store.** `resolveProjectTrusted()` takes
> `trustStore: ProjectTrustStore` as a parameter (`dist/core/project-trust.d.ts`), and
> `AgentSessionRuntime.switchSession()` accepts a `projectTrustContextFactory(cwd)`
> (`dist/core/agent-session-runtime.d.ts:76`). So we can borrow pi's _decision logic_ while
> keeping the _state_ ours.
>
> **But that changes the payoff, and the plan below is written against the old one.** The
> stated benefit was removing duplication by adopting something native. If we must supply the
> store, the persistence half stays ours regardless, and what is actually gained is one
> resolution routine — considerably less than "one coherent trust story". Whether that is
> worth an epic spanning five surfaces is now an open question, not a premise.
>
> **Before any phase-1 work, decide:** is the goal still consolidation, or has it become
> "reuse pi's resolver, keep our storage"? Those are different projects with different
> justifications. Note also that §7.1.1 of
> [`pi-sdk-085-feature-adoption-plan.md`](./archive/pi-sdk-085-feature-adoption-plan.md) found the
> file-tool path surface has _no_ containment check today — so the five surfaces this plan
> enumerates may not all be as built-out as it assumes. Re-audit them before costing the work.

---

## 1. Why this is its own epic

pi (0.79.0–0.79.1, broadened since) added a **native** project-trust mechanism. Open Cowork
already has **five parallel, app-owned trust/permission surfaces**, all written before that
mechanism existed. Aligning them could remove duplication and give one coherent trust story —
but "trust" is the boundary that stops an untrusted project from widening the agent's rights,
so this is **investigation-first**, not a mechanical refactor.

Every other item in the parent adoption plan is a pure, low-risk consumer of a public SDK
surface, shippable in a single edit. This one spans five subsystems and can regress a security
invariant **silently**. Hence: its own doc, its own phases, its own review.

## 2. SDK surface (pi coding-agent)

Verified present in `@earendil-works/pi-coding-agent` on the 0.80.10 baseline. The surface is
**broader than §4.2's original sketch** — which itself matters, because it widens what "align"
could mean:

- **Extension event `ProjectTrustEvent`** (`type: "project_trust"`), decision
  `"yes" | "no" | "undecided"` (`ProjectTrustEventResult`) — a global/CLI extension can
  decide / remember / defer trust **before** project-local resources load.
- **`ctx.isProjectTrusted(): boolean`** / **`setProjectTrusted(trusted)`** — observe / set the
  effective decision (including temporary).
- **`DefaultProjectTrust`** global setting (`getDefaultProjectTrust` / `setDefaultProjectTrust`)
  — ask / always-trust / never-trust default.
- **`ProjectTrustStore`** + `trust-manager.ts` — persisted per-cwd decisions
  (`ProjectTrustDecision = boolean | null`; `get` / `set` / `setMany`; `ProjectTrustStoreEntry`).
- Helpers: `resolveProjectTrusted(...)`, `getProjectTrustOptions(cwd)`,
  `getProjectTrustParentPath(cwd)`, `hasTrustRequiringProjectResources(...)`, and per-scope
  guards (`assertProjectTrustedForScope` / `...ForWrite`).

> **Caveat — SDK-only boundary.** Part of this is CLI-shaped (the on-disk store, the
> `/`-command options). Per `ARCHITECTURE.md` §4.1 and the parent plan's §7, OC consumes the
> **SDK**, not the CLI's config or workflow. Phase 1 must decide which of these are legitimately
> consumable versus which would re-couple OC to the pi CLI.

## 3. OC's current trust/permission surfaces (as-is)

Five places, each with its own notion of "trusted / allowed":

| #   | Surface                 | File                                                                                  | Scope of its decision                                                            |
| --- | ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Bash project-trust gate | [`bash-restrictions/`](../../pi-extensions/bash-restrictions/)                        | Honors project-scoped `.pi/bash-restrictions.json` **only for trusted projects** |
| 2   | Tool-call gating        | [`before-tool-call-hook.ts`](../../src/main/claude/before-tool-call-hook.ts) (136 ln) | Per-tool allow/deny before execution                                             |
| 3   | MCP tool permissions    | [`mcp-tool-permissions.ts`](../../src/main/mcp/mcp-tool-permissions.ts) (427 ln)      | Which MCP tools a session may call                                               |
| 4   | MCP workspace profile   | [`mcp-workspace-profile.ts`](../../src/main/mcp/mcp-workspace-profile.ts) (415 ln)    | Per-workspace MCP server enable/routing                                          |
| 5   | Sandbox boundary        | [`sandbox-adapter.ts`](../../src/main/sandbox/sandbox-adapter.ts) (754 ln)            | OS-level containment (path/network)                                              |

(plus permission-rules handling threaded through several of these).

## 4. Problem statement

Five surfaces encode trust independently; pi now models the _project-trust decision_ once,
natively. The question this epic must answer — **and cannot answer from the armchair** — is:

> Does alignment **replace** OC's trust surfaces, or only **delegate the project-trust
> decision** to pi's native event while OC keeps its own per-tool / sandbox / MCP gating?

That is the deliverable of phase 1, not an input to it.

## 5. Security invariants that must NOT regress

Any design is rejected if it weakens any of these. This list **is** the review checklist:

- **Path containment** — the agent cannot read/write outside the approved workspace root.
- **Sandbox boundaries** — the OS-level isolation in `sandbox-adapter.ts` stays authoritative;
  a trust decision must never bypass it.
- **MCP host-only spawns** — MCP servers spawn on the host under OC's control, never at an
  untrusted project's direction.
- **Bash trust gate** — project-scoped bash restrictions apply only to trusted projects; an
  untrusted project cannot loosen its own restrictions.
- **Renderer/main IPC boundary** — trust decisions are made in the main process, never in the
  renderer.
- **Default-deny** — an _undecided_ / unknown project is treated as **untrusted**, not trusted.

## 6. Phases

1. **Investigation (no code).** Map each of the five surfaces to what pi's `ProjectTrustEvent`
   / `isProjectTrusted()` / `DefaultProjectTrust` / `ProjectTrustStore` now cover. Output: a
   gap analysis — what pi covers, what is genuinely OC-specific (GUI permission dialogs,
   sandbox, MCP routing), what is redundant, and what would breach the SDK-only boundary if
   adopted.
2. **Design (this doc, phase 2).** Propose a target architecture — most likely: OC's GUI
   permission layer **delegates** the project-trust decision to pi's native event while keeping
   its own per-tool / sandbox / MCP gating. Enumerate every invariant from §5 and show how the
   design preserves it. **Requires explicit approval before any code.**
3. **Implementation.** Only after the design is approved. Behind a feature flag; extensive
   tests (including adversarial "untrusted project tries to widen its own rights"); security
   review.

## 7. Risk & effort

- **Risk: High** — security boundary, five subsystems, silent-regression potential.
- **Effort: Large** — treat as its own epic; do not fold into a routine SDK uplift.

## 8. Open questions (owned by phase 1)

1. **Replace vs. delegate** (§4) — the central one.
2. Which SDK trust helpers are consumable without breaching the SDK-only boundary (§2 caveat)?
3. Does OC need its own persisted trust store, or can it observe pi's `ProjectTrustStore`
   without adopting the CLI's on-disk format?
4. How does a GUI "trust this project?" prompt map onto the `project_trust` event's
   `yes / no / undecided` decision plus the `DefaultProjectTrust` setting?

## 9. Non-goals

- Adopting the pi **CLI's** trust _workflow_, on-disk config, or `/`-command options (SDK-only
  boundary, `ARCHITECTURE.md` §4.1).
- Reworking OC's own `.cowork` workspace-config system.
- **Any** code change before the phase-2 design is approved and security-reviewed.
