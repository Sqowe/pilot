# Scheduler v2 — Design Document

> Feature: Anacron-style in-app task scheduling for Open Cowork
> Status: Draft
> Author: AI-assisted design session
> Date: 2026-05-07

---

## 1. Overview

Extend the existing `src/main/schedule/` module from a basic cron-like timer into a
full-featured, application-level scheduler with fuzzy time windows, explicit config set
binding, autonomous execution mode, and budget controls.

**Core philosophy:** The scheduler lives and dies with the Electron window. No OS-level
daemons, no background processes, no tray-only execution. If the app is closed, nothing
runs. This gives the user full control and visibility.

**Inspiration:** Linux anacron — tasks run "sometime during a window" rather than at a
precise second. The system picks the best moment within the window, not the user.

---

## 2. Key Design Decisions

| #   | Decision                                                   | Rationale                                                              |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Named time windows (morning/afternoon/evening/night)       | Simple, opinionated, no cron syntax for end users                      |
| 2   | Random firing within window                                | Simple to implement; `conflict: queue` handles busy-agent case         |
| 3   | Catch-up policy as user setting (4 options)                | Different users have different tolerance for missed tasks              |
| 4   | Explicit config set binding per task                       | Tasks must declare which LLM config they use — no implicit inheritance |
| 5   | Inherit global bash trust/denylist                         | Unified security model; no per-task permission surface                 |
| 6   | `executionMode: 'auto'` blocks on `'ask'` decisions        | If a command isn't globally trusted, autonomous tasks can't run it     |
| 7   | Window-tied lifecycle                                      | Scheduler stops when app closes; no OS-level persistence               |
| 8   | Per-run token/time budget                                  | Prevents runaway autonomous tasks                                      |
| 9   | Run history with configurable depth                        | Default 10, user-adjustable                                            |
| 10  | Batch catch-up panel with per-task run/skip + bulk actions | Clean UX for missed-window recovery                                    |

---

## 3. Time Windows

Fixed named windows with hardcoded ranges (local time):

| Window      | Range         | Description      |
| ----------- | ------------- | ---------------- |
| `morning`   | 09:00 – 11:00 | Start of workday |
| `afternoon` | 13:00 – 15:00 | Post-lunch       |
| `evening`   | 17:00 – 19:00 | End of workday   |
| `night`     | 21:00 – 23:00 | Late session     |

**Firing strategy:** When the app is running and the current time enters a task's window,
the scheduler picks a random offset within the remaining window time and sets a timer.
If the app opens mid-window (e.g., user opens at 10:30, task window is morning), the
random offset is computed from the remaining time (10:30–11:00).

**Window miss:** If the app was closed for the entire window, the catch-up policy applies
on next app open.

---

## 4. Data Model

### 4.1 Extended ScheduledTask Interface

```typescript
export type TimeWindow = 'morning' | 'afternoon' | 'evening' | 'night';
export type ExecutionMode = 'ask' | 'auto';
export type CatchUpPolicy = 'skip' | 'run-once' | 'run-all' | 'ask';
export type ConflictPolicy = 'queue' | 'skip-if-busy' | 'parallel';
export type SandboxMode = 'inherit' | 'require' | 'skip';

export interface ScheduledTask {
  // --- Existing fields (unchanged) ---
  id: string;
  title: string;
  prompt: string;
  cwd: string; // Must be a valid workspace path
  runAt: number;
  nextRunAt: number | null;
  scheduleConfig: ScheduledTaskScheduleConfig | null;
  repeatEvery: number | null;
  repeatUnit: ScheduleRepeatUnit | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;

  // --- New fields (v2) ---
  configSetId: ConfigSetId; // REQUIRED — which LLM config to use
  executionMode: ExecutionMode; // 'ask' = confirm before run, 'auto' = silent
  timeWindow: TimeWindow | null; // If set, overrides exact time scheduling
  maxDurationMs: number | null; // Per-run timeout (null = no limit)
  maxTokens: number | null; // Per-run token budget (null = no limit)
  sandboxMode: SandboxMode; // Future-proofing for sandbox integration
}
```

### 4.2 New: ScheduledTaskRunHistory

```typescript
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'success' | 'failed' | 'timeout' | 'blocked' | 'skipped';
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  tokensUsed: number | null;
  blockedCommands: string[] | null; // Commands that hit 'ask' in auto mode
}
```

### 4.3 User Settings (global, in electron-store)

```typescript
export interface SchedulerSettings {
  catchUpPolicy: CatchUpPolicy; // Default: 'ask'
  conflictPolicy: ConflictPolicy; // Default: 'queue'
  runHistoryDepth: number; // Default: 10, per task
}
```

---

## 5. Execution Flow

### 5.1 Normal Execution (app is open, within window)

```
Window opens (e.g., 09:00)
  │
  ├─ Scheduler checks: any tasks with timeWindow = 'morning'?
  │
  ├─ For each eligible task:
  │     ├─ Compute random offset within remaining window
  │     ├─ Set setTimeout for that offset
  │     └─ Store timer reference
  │
  ▼ Timer fires
  │
  ├─ Check: is configSetId still valid?
  │     └─ NO → auto-disable task, log error, notify user. Stop.
  │
  ├─ Check: conflict policy
  │     ├─ queue → add to prompt queue, wait for active session to finish
  │     ├─ skip-if-busy → if agent is active, skip this run, log as 'skipped'
  │     └─ parallel → start immediately (future consideration)
  │
  ├─ Check: executionMode
  │     ├─ 'ask' → show confirmation dialog to user
  │     │     ├─ User approves → proceed
  │     │     └─ User declines → log as 'skipped'
  │     └─ 'auto' → proceed silently
  │
  ├─ Activate config set (switch LLM provider/model/keys for this session)
  │
  ├─ Start session via sessionManager.startSession(title, prompt, cwd)
  │     └─ Permission hook uses global bash trust/denylist
  │           ├─ 'allow' → command runs
  │           ├─ 'ask' + executionMode:'auto' → BLOCK, log to blockedCommands
  │           └─ 'ask' + executionMode:'ask' → show permission dialog (normal flow)
  │
  ├─ Monitor: maxDurationMs timeout
  │     └─ If exceeded → abort session, log as 'timeout'
  │
  ├─ Monitor: maxTokens budget
  │     └─ If exceeded → abort session, log as 'timeout'
  │
  ├─ Session completes → record run in history
  │
  └─ Prune history if > runHistoryDepth
```

### 5.2 Catch-Up Flow (app opens after missed window)

```
App starts / window becomes active
  │
  ├─ Scheduler checks: any tasks with missed windows?
  │     (task.nextRunAt < now AND task was not executed)
  │
  ├─ Read global catchUpPolicy setting
  │
  ├─ 'skip' → update nextRunAt to next valid window, log as 'skipped'
  │
  ├─ 'run-once' → execute task once immediately, then advance schedule
  │
  ├─ 'run-all' → execute for each missed occurrence sequentially
  │
  └─ 'ask' → show batch catch-up panel:
        ┌─────────────────────────────────────────────┐
        │  Missed Scheduled Tasks                      │
        │                                              │
        │  ☐ "Daily code review" — missed morning      │
        │    [Run] [Skip]                              │
        │                                              │
        │  ☐ "Dependency check" — missed morning       │
        │    [Run] [Skip]                              │
        │                                              │
        │  ☐ "Git pull" — missed morning               │
        │    [Run] [Skip]                              │
        │                                              │
        │  ─────────────────────────────────           │
        │  [Run All]  [Skip All]                       │
        └─────────────────────────────────────────────┘
```

### 5.3 Config Set Invalidation

```
User deletes/renames config set "my-fast-model"
  │
  ├─ Scheduler scans all tasks for configSetId = "my-fast-model"
  │
  ├─ For each affected task:
  │     ├─ Set enabled = false
  │     ├─ Set lastError = "Config set 'my-fast-model' no longer exists"
  │     └─ Emit 'scheduled-task.config-invalid' event to renderer
  │
  └─ UI shows warning badge on affected tasks with option to:
        ├─ Edit task → pick new config set → re-enable
        └─ Delete task
```

---

## 6. Permission Model for Autonomous Tasks

When `executionMode: 'auto'`:

1. The session is created with the same `installPermissionHook` as interactive sessions.
2. `decidePermission()` runs normally against global bash trust/denylist.
3. If decision is `'allow'` → command executes.
4. If decision is `'ask'` → command is **blocked** (not queued for user input).
   - The blocked command is logged in the run's `blockedCommands` array.
   - The agent receives a tool result: `"Command blocked by permission policy (autonomous mode). Command: <cmd>"`
   - The agent can try alternative approaches or fail gracefully.
5. If decision is `'deny'` → command is blocked (same as interactive).

**Implication:** Users who want autonomous scheduled tasks to run `git push` must add
`git *` to their global trusted commands list. This is intentional — it keeps the
security boundary simple and auditable.

---

## 7. SQLite Schema Changes

### New table: `scheduled_task_runs`

```sql
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,          -- 'success' | 'failed' | 'timeout' | 'blocked' | 'skipped'
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  tokens_used INTEGER,
  blocked_commands TEXT,          -- JSON array of blocked command strings
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_runs_task_id ON scheduled_task_runs(task_id);
CREATE INDEX idx_task_runs_started_at ON scheduled_task_runs(started_at);
```

### Alter table: `scheduled_tasks` (new columns)

```sql
ALTER TABLE scheduled_tasks ADD COLUMN config_set_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE scheduled_tasks ADD COLUMN time_window TEXT;          -- NULL = use exact time
ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER;
ALTER TABLE scheduled_tasks ADD COLUMN max_tokens INTEGER;
ALTER TABLE scheduled_tasks ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'inherit';
```

---

## 8. Config Store Changes

Add to `AppConfig` (persisted via electron-store):

```typescript
// In src/main/config/config-store.ts
interface AppConfig {
  // ... existing fields ...

  // Scheduler settings (new)
  schedulerCatchUpPolicy: 'skip' | 'run-once' | 'run-all' | 'ask';
  schedulerConflictPolicy: 'queue' | 'skip-if-busy';
  schedulerRunHistoryDepth: number;
}
```

Defaults:

```typescript
schedulerCatchUpPolicy: 'ask',
schedulerConflictPolicy: 'queue',
schedulerRunHistoryDepth: 10,
```

---

## 9. IPC Events (Main ↔ Renderer)

### New server events (main → renderer)

| Event                            | Payload                                     | When                                           |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `scheduled-task.catch-up`        | `{ tasks: MissedTask[] }`                   | App opens with missed tasks and policy = 'ask' |
| `scheduled-task.started`         | `{ taskId, sessionId, runId }`              | Autonomous task begins execution               |
| `scheduled-task.completed`       | `{ taskId, runId, status, tokensUsed }`     | Task run finishes                              |
| `scheduled-task.config-invalid`  | `{ taskId, configSetId, error }`            | Referenced config set deleted                  |
| `scheduled-task.budget-exceeded` | `{ taskId, runId, type: 'time'\|'tokens' }` | Budget limit hit                               |

### New client events (renderer → main)

| Event                              | Payload                                      | When                         |
| ---------------------------------- | -------------------------------------------- | ---------------------------- |
| `scheduled-task.catch-up-response` | `{ decisions: { taskId: 'run'\|'skip' }[] }` | User responds to batch panel |
| `scheduled-task.get-history`       | `{ taskId }`                                 | UI requests run history      |

---

## 10. UI Components

### 10.1 Task Creation/Edit Form

Extend the existing scheduled task form with:

- **Config Set selector** (dropdown, required) — lists available config sets
- **Execution Mode toggle** — "Ask before running" / "Run automatically"
- **Time Window selector** — "Morning (09–11)" / "Afternoon (13–15)" / "Evening (17–19)" / "Night (21–23)" / "Exact time" (falls back to existing HH:MM picker)
- **Budget section** (collapsible):
  - Max duration: number input + unit (minutes)
  - Max tokens: number input (optional)

### 10.2 Scheduler Settings Panel

New section in Settings → Scheduler:

- **When tasks miss their window:** radio group (Skip / Run once / Run all / Ask me)
- **When agent is busy:** radio group (Queue / Skip)
- **Run history depth:** number input (default 10)

### 10.3 Task List View

Extend existing task list with:

- Config set badge (shows which model/provider)
- Execution mode indicator (🔒 ask / ⚡ auto)
- Last run status with expandable history
- Warning badge when config set is invalid

### 10.4 Catch-Up Batch Panel

Modal/panel shown on app open when `catchUpPolicy = 'ask'`:

- List of missed tasks with window info
- Per-task [Run] / [Skip] buttons
- Bulk [Run All] / [Skip All] at bottom
- Dismissing the panel = skip all

---

## 11. Implementation Plan

### Phase 1: Data Model & Storage (no UI changes)

1. Add new columns to `scheduled_tasks` table (migration)
2. Create `scheduled_task_runs` table
3. Extend `ScheduledTask` interface and `ScheduledTaskStore`
4. Add `SchedulerSettings` to config store
5. Add run history CRUD to database layer

### Phase 2: Scheduler Engine

1. Implement time window resolution (window → random timestamp)
2. Implement catch-up detection on `start()`
3. Implement conflict policy (queue/skip-if-busy)
4. Implement config set validation (on task fire + on config set delete)
5. Implement budget monitoring (duration timeout + token tracking)
6. Implement permission blocking for `executionMode: 'auto'`
7. Implement run history recording + pruning

### Phase 3: IPC & Events

1. Add new server/client events
2. Wire catch-up flow to renderer
3. Wire config set invalidation notifications
4. Wire run history queries

### Phase 4: UI

1. Extend task creation/edit form
2. Add scheduler settings panel
3. Add catch-up batch panel (modal)
4. Extend task list view with new indicators
5. Add run history expandable section per task

### Phase 5: Testing

1. Unit tests for time window resolution
2. Unit tests for catch-up detection logic
3. Unit tests for conflict policy
4. Unit tests for permission blocking in auto mode
5. Unit tests for budget enforcement
6. Unit tests for config set invalidation
7. Integration test: full lifecycle (create → fire → record → prune)

---

## 12. Migration Strategy

The existing `ScheduledTaskManager` and `ScheduledTaskStore` remain functional.
New fields have sensible defaults:

- `configSetId: 'default'` — existing tasks use the default config set
- `executionMode: 'ask'` — existing tasks keep current behavior (no silent execution)
- `timeWindow: null` — existing tasks keep their exact-time scheduling
- `maxDurationMs: null` — no limit (backward compatible)
- `maxTokens: null` — no limit (backward compatible)
- `sandboxMode: 'inherit'` — follows app-wide setting (no behavior change)

No existing behavior changes. All new features are opt-in per task.

---

## 13. Sandbox Integration (future-proofing)

The `sandboxMode` field is included in the schema now but **not implemented** in Phase 1–5.
It exists to avoid a schema migration when sandbox stabilization ships.

```typescript
export type SandboxMode = 'inherit' | 'require' | 'skip';
```

| Value     | Behavior (when sandbox is available)                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `inherit` | Use the app-wide `sandboxEnabled` setting. If sandbox is on globally, task runs sandboxed. If off, runs native.                |
| `require` | Task refuses to execute unless sandbox is active. Logs as `'blocked'` with error "Sandbox required but not available."         |
| `skip`    | Task always runs native, even if sandbox is globally enabled. For tasks that need host access (e.g., GUI automation triggers). |

**Default: `'inherit'`** — existing behavior, no user action needed.

**Why now:** Once autonomous scheduled tasks are in production, users will want isolation
guarantees for `executionMode: 'auto'` tasks. Having the field already in the schema means
we can wire it up when sandbox ships without touching the database or breaking existing tasks.

**Implementation trigger:** When `sandboxEnabled` toggle is un-gated in the Settings UI
(currently hidden behind "Coming soon"), wire `sandboxMode` into the execution flow in
`ScheduledTaskManager.handleTrigger()`.

---

## 14. Future Considerations (not in scope)

- **Idle detection** — fire at first idle moment within window (v2 optimization)
- **Per-task bash overrides** — task-specific trust list beyond global (complexity concern)
- **Inter-task dependencies** — "run B after A completes" (orchestration territory)
- **Remote/cloud execution** — run tasks even when app is closed (architectural shift)
- **Webhook triggers** — fire task on external event (different trigger type)
- **User-configurable time window ranges** — let users redefine what "morning" means

---

## 15. References

- Existing implementation: `src/main/schedule/scheduled-task-manager.ts`
- Bash permission engine: `src/main/config/permission-rules-store.ts`
- Config sets: `src/main/config/config-store.ts` (`ApiConfigSet`, `ConfigSetId`)
- Session creation: `src/main/session/session-manager.ts`
- Architecture: `ARCHITECTURE.md` (Section 7: Schedule system marked ⚠️ Experimental)
- Claude Code Routines (reference): https://code.claude.com/docs/en/routines
- Community discussion: https://github.com/anthropics/claude-code/issues/28229
