import type { SkillSource } from '../../shared/skill-conflict-types';
import type { TokenUsage } from '../../shared/token-usage';
import type { SharedModelThinkingLevel } from '../../shared/thinking-levels';
import type { PermissionAskReason } from '../../shared/permission-reason';
export type { TokenUsage } from '../../shared/token-usage';

// Session types
export interface Session {
  id: string;
  title: string;
  claudeSessionId?: string;
  openaiThreadId?: string;
  status: SessionStatus;
  cwd?: string;
  mountedPaths: MountedPath[];
  allowedTools: string[];
  memoryEnabled: boolean;
  model?: string;
  configSetId?: string;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface MountedPath {
  virtual: string;
  real: string;
}

// Message types
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: ContentBlock[];
  timestamp: number;
  tokenUsage?: TokenUsage;
  localStatus?: 'queued' | 'cancelled';
  executionTimeMs?: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type ContentBlock =
  | TextContent
  | ImageContent
  | FileAttachmentContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface FileAttachmentContent {
  type: 'file_attachment';
  filename: string;
  relativePath: string; // Path relative to session's .tmp folder
  size: number;
  mimeType?: string;
  inlineDataBase64?: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  images?: Array<{
    data: string; // base64 encoded image data
    mimeType: string; // e.g., 'image/png'
  }>;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

// Trace types for visualization
export interface TraceStep {
  id: string;
  type: TraceStepType;
  status: TraceStepStatus;
  title: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  timestamp: number;
  duration?: number;
}

export type TraceStepType = 'thinking' | 'text' | 'tool_call' | 'tool_result';
export type TraceStepStatus = 'pending' | 'running' | 'completed' | 'error';

export type ScheduleRepeatUnit = 'minute' | 'hour' | 'day';
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Scheduler v2 types — imported from shared module for local use and re-exported
import type {
  TimeWindow,
  ExecutionMode,
  CatchUpPolicy,
  ConflictPolicy,
  SandboxMode,
  ScheduledTaskRunStatus,
} from '../../shared/schedule/types';
export type {
  TimeWindow,
  ExecutionMode,
  CatchUpPolicy,
  ConflictPolicy,
  SandboxMode,
  ScheduledTaskRunStatus,
};

export interface DailyScheduleConfig {
  kind: 'daily';
  times: string[];
}

export interface WeeklyScheduleConfig {
  kind: 'weekly';
  weekdays: ScheduleWeekday[];
  times: string[];
}

export type ScheduleConfig = DailyScheduleConfig | WeeklyScheduleConfig;

export interface ScheduleTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  runAt: number;
  nextRunAt: number | null;
  scheduleConfig: ScheduleConfig | null;
  repeatEvery: number | null;
  repeatUnit: ScheduleRepeatUnit | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  // v2 fields
  configSetId: string;
  executionMode: ExecutionMode;
  timeWindow: TimeWindow | null;
  maxDurationMs: number | null;
  maxTokens: number | null;
  sandboxMode: SandboxMode;
}

export interface ScheduleTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: ScheduledTaskRunStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  tokensUsed: number | null;
  blockedCommands: string[] | null;
}

export interface SchedulerSettings {
  catchUpPolicy: CatchUpPolicy;
  conflictPolicy: ConflictPolicy;
  runHistoryDepth: number;
}

export interface MissedTaskInfo {
  taskId: string;
  title: string;
  timeWindow: TimeWindow | null;
  scheduledFor: number;
}

export interface CatchUpDecision {
  taskId: string;
  action: 'run' | 'skip';
}

export interface ScheduleCreateInput {
  title?: string;
  prompt: string;
  cwd: string;
  runAt: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
  // v2 fields
  configSetId?: string;
  executionMode?: ExecutionMode;
  timeWindow?: TimeWindow | null;
  maxDurationMs?: number | null;
  maxTokens?: number | null;
  sandboxMode?: SandboxMode;
}

export interface ScheduleUpdateInput {
  title?: string;
  prompt?: string;
  cwd?: string;
  runAt?: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastRunSessionId?: string | null;
  lastError?: string | null;
  // v2 fields
  configSetId?: string;
  executionMode?: ExecutionMode;
  timeWindow?: TimeWindow | null;
  maxDurationMs?: number | null;
  maxTokens?: number | null;
  sandboxMode?: SandboxMode;
}

// Skills types
export interface Skill {
  id: string;
  name: string;
  description?: string;
  type: SkillType;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt: number;

  // Conflict resolution fields (Phase 0)
  /** Where this skill was loaded from. */
  source?: SkillSource;
  /** Actual file path of this skill on disk. */
  sourcePath?: string;
  /** Whether another source has a skill with the same name. */
  hasConflict?: boolean;
  /** Other sources where this skill name exists (when conflict detected). */
  conflictSources?: SkillSource[];
  /** Whether this version is the one currently being used by the agent. */
  isActive?: boolean;
}

export type SkillType = 'builtin' | 'mcp' | 'custom';

export interface BuiltinSkillStatus {
  skillName: string;
  bundledHash: string;
  runtimeHash: string;
  isSymlink: boolean;
  isUserModified: boolean;
  isUpToDate: boolean;
  isLegacy: boolean;
  isInstalled: boolean;
  lastUpdated: number | null;
}

export type PluginComponentKind = 'skills' | 'commands' | 'agents' | 'hooks' | 'mcp';

export interface PluginComponentCounts {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  mcp: number;
}

export interface PluginComponentEnabledState {
  skills: boolean;
  commands: boolean;
  agents: boolean;
  hooks: boolean;
  mcp: boolean;
}

export interface PluginCatalogItemV2 {
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  installable: boolean;
  hasManifest: boolean;
  componentCounts: PluginComponentCounts;
  pluginId?: string;
  installCommand?: string;
  detailUrl?: string;
  catalogSource?: 'claude-marketplace';
}

export interface PluginCatalogItem extends PluginCatalogItemV2 {
  skillCount: number;
  hasSkills: boolean;
}

export interface InstalledPlugin {
  pluginId: string;
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  enabled: boolean;
  sourcePath: string;
  runtimePath: string;
  componentCounts: PluginComponentCounts;
  componentsEnabled: PluginComponentEnabledState;
  installedAt: number;
  updatedAt: number;
  orchestratorSkill?: string | null;
}

export interface PluginInstallResultV2 {
  plugin: InstalledPlugin;
  installedSkills: string[];
  warnings: string[];
}

export interface PluginToggleResult {
  success: boolean;
  plugin: InstalledPlugin;
}

export interface PluginInstallResult {
  pluginName: string;
  installedSkills: string[];
  skippedSkills: string[];
  errors: string[];
}

export interface SkillsStorageChangeEvent {
  path: string;
  reason: 'updated' | 'path_changed' | 'fallback' | 'watcher_error';
  message?: string;
}

// Memory types
export interface MemoryEntry {
  id: string;
  sessionId: string;
  content: string;
  metadata: MemoryMetadata;
  createdAt: number;
}

export interface MemoryMetadata {
  source: string;
  timestamp: number;
  tags: string[];
}

export type MemorySearchScope = 'workspace' | 'global' | 'all';
export type MemorySearchKind = 'core' | 'experience_session' | 'experience_chunk' | 'raw_session';

export interface MemoryTranscriptTurn {
  role: string;
  content: string;
  messageId?: string;
  timestamp?: number;
}

export interface ChunkMemoryItem {
  id: string;
  sessionId: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId: string;
  sourceSessionTitle?: string;
  sourceSessionDate?: string;
  summary: string;
  details: string;
  keywords: string[];
  sourceTurns: number[];
  rawText: string;
  sessionDate: string;
  createdAt: string;
  ingestedAt: string;
  embedding: number[];
}

export interface SessionMemoryItem {
  id: string;
  sessionId: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId: string;
  sourceSessionTitle?: string;
  sourceSessionDate?: string;
  summary: string;
  keywords: string[];
  chunkIds: string[];
  rawSession: MemoryTranscriptTurn[];
  sessionDate: string;
  createdAt: string;
  ingestedAt: string;
  embedding: number[];
}

export interface MemoryDebugFileInfo {
  kind: 'core' | 'experience' | 'state' | 'artifacts';
  /** 'sqlite' for memory.db, 'file' (default) for JSON/dir entries. */
  storage?: 'file' | 'sqlite';
  label: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: number | null;
  sessionCount?: number;
  chunkCount?: number;
}

export interface ExperienceDbStatus {
  schemaVersion: number;
  sessionCount: number;
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDim: number | null;
  sizeBytes: number;
  journalMode?: string | null;
  integrityOk: boolean;
  workspaceBreakdown: Array<{
    workspaceKey: string;
    sessionCount: number;
    chunkCount: number;
  }>;
}

/** Result of the file-based experience memory export. */
export type ExperienceExportResult =
  | { success: false; canceled: true }
  | { success: true; path: string }
  | { success: false; error: string };

export interface MemoryDebugFileContent {
  kind: MemoryDebugFileInfo['kind'];
  filePath: string;
  text: string;
  parsed: unknown | null;
  sizeBytes: number;
  updatedAt: number | null;
}

export interface MemoryInspectSessionResult {
  sourceWorkspace?: string | null;
  filePath: string;
  session: SessionMemoryItem;
  chunks: ChunkMemoryItem[];
}

// Re-export from shared — single source of truth across main/preload/renderer.
export type {
  LocalEmbeddingProgress,
  LocalModelRuntimeStatus,
  LocalModelStatus,
  MemoryBackfillProgress,
} from '../../shared/local-embedding-types';

/** Result of the "Check models availability" probe (memory LLM + embedding). */
export interface MemoryModelCheckResult {
  llm: { ok: boolean; error?: string };
  /** `skipped` is true when embeddings are disabled (nothing to check). */
  embedding: { ok: boolean; error?: string; skipped?: boolean };
}

export interface MemoryPanelState {
  enabled: boolean;
  localModelDownloaded: boolean;
  coreEntries: Array<{ category: string; key: string; value: string; combinedKey: string }>;
  workspaceStats: {
    name: string;
    sessionCount: number;
    chunkCount: number;
    lastIngestedAt: number | null;
  } | null;
  totalStats: {
    coreCount: number;
    sessionCount: number;
    chunkCount: number;
    workspaceCount: number;
  };
  lastRetrieval: {
    coreMatched: number;
    chunksRetrieved: number;
    chunksExpanded: number;
    tokensInjected: number;
    sources: Array<{ workspace: string | null; summary: string; expanded: boolean }>;
    durationMs: number;
    timestamp: number;
  } | null;
}

export interface MemoryOverview {
  enabled: boolean;
  storageRoot: string;
  coreFilePath: string;
  experienceFilePath: string;
  stateFilePath: string;
  coreCount: number;
  experienceSessionCount: number;
  experienceChunkCount: number;
  sourceWorkspaceCount: number;
  failedSessionCount: number;
  latestIngestionAt: number | null;
  latestError: string | null;
  latestErrorAt: number | null;
  /** `memoryRuntime.useEmbedding` — when false the coverage fields are not meaningful. */
  embeddingEnabled: boolean;
  /** Chunks carrying a vector. Below `experienceChunkCount` means degraded semantic search. */
  embeddedChunkCount: number;
  /** Last embedding failure this process saw, or null. Not persisted across restarts. */
  embeddingError: string | null;
  embeddingErrorAt: number | null;
  currentWorkspace?: {
    workspaceKey: string;
    experienceSessionCount: number;
    experienceChunkCount: number;
  };
  topSourceWorkspaces: Array<{
    workspaceKey: string;
    sessionCount: number;
    chunkCount: number;
  }>;
}

export interface MemorySearchResult {
  id: string;
  recordId: string;
  kind: MemorySearchKind;
  title: string;
  summary: string;
  contentPreview: string;
  workspaceKey?: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
  sessionId?: string;
  sessionTitle?: string;
  category?: 'identity' | 'preferences' | 'skills' | 'interests';
  score: number;
  createdAt: number;
  updatedAt?: number;
  keywords?: string[];
  sourceFile?: string;
}

export interface MemoryReadResult extends MemorySearchResult {
  rawText?: string;
  details?: string;
  rawSession?: MemoryTranscriptTurn[];
  sourceTurns?: number[];
  chunkIds?: string[];
  sourceExcerpt?: string;
}

/** A referenced past conversation surfaced by workspace chat search tools. */
export interface MemorySource {
  /** Session or chunk title */
  title: string;
  /** Brief summary of what was found */
  summary?: string;
  /** The search query that found this */
  query?: string;
}

// Permission types
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  /** What triggered the prompt, when the permission gate knows (bash lists, trusted directories). */
  reason?: PermissionAskReason;
}

export type PermissionResult = 'allow' | 'deny' | 'allow_always' | 'deny_with_suggestion';

export interface PermissionResponse {
  result: PermissionResult;
  suggestion?: string;
}

// Sudo password types
export interface SudoPasswordRequest {
  toolUseId: string;
  command: string;
  sessionId: string;
}

// AskUserQuestion display types - kept for rendering historical messages
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: 'allow' | 'deny' | 'ask';
}

// IPC Event types
export type ClientEvent =
  | {
      type: 'session.start';
      payload: {
        title: string;
        prompt: string;
        cwd?: string;
        allowedTools?: string[];
        content?: ContentBlock[];
        memoryEnabled?: boolean;
        initialDisabledMcpServers?: string[];
        initialPinnedSkills?: string[];
        initialDisabledSkills?: string[];
      };
    }
  | {
      type: 'session.continue';
      payload: { sessionId: string; prompt: string; content?: ContentBlock[] };
    }
  | { type: 'session.stop'; payload: { sessionId: string } }
  | { type: 'session.delete'; payload: { sessionId: string } }
  | { type: 'session.batchDelete'; payload: { sessionIds: string[] } }
  | { type: 'session.list'; payload: Record<string, never> }
  | { type: 'session.getMessages'; payload: { sessionId: string } }
  | { type: 'session.getTraceSteps'; payload: { sessionId: string } }
  | {
      type: 'permission.response';
      payload: { toolUseId: string; result: PermissionResult; suggestion?: string };
    }
  | { type: 'sudo.password.response'; payload: { toolUseId: string; password: string | null } }
  | { type: 'settings.update'; payload: Record<string, unknown> }
  | { type: 'folder.select'; payload: Record<string, never> }
  | { type: 'workdir.get'; payload: Record<string, never> }
  | { type: 'workdir.set'; payload: { path: string; sessionId?: string } }
  | { type: 'workdir.select'; payload: { sessionId?: string; currentPath?: string } }
  | { type: 'scheduled-task.catch-up-response'; payload: { decisions: CatchUpDecision[] } }
  | { type: 'prompt.getSections'; payload: Record<string, never> }
  | { type: 'prompt.updateSection'; payload: { filename: string; content: string } }
  | { type: 'prompt.resetSection'; payload: { filename: string } }
  | { type: 'prompt.resetAll'; payload: Record<string, never> }
  | { type: 'prompt.toggleSection'; payload: { filename: string; enabled: boolean } }
  | { type: 'prompt.getDir'; payload: Record<string, never> };

// Sandbox setup types (app startup)
export type SandboxSetupPhase =
  | 'checking' // Checking WSL/Lima availability
  | 'creating' // Creating Lima instance (macOS only)
  | 'starting' // Starting Lima instance (macOS only)
  | 'installing_node' // Installing Node.js
  | 'installing_python' // Installing Python
  | 'installing_pip' // Installing pip
  | 'installing_deps' // Installing skill dependencies (markitdown, pypdf, etc.)
  | 'ready' // Ready to use
  | 'skipped' // No sandbox needed (native mode)
  | 'error'; // Setup failed

export interface SandboxSetupProgress {
  phase: SandboxSetupPhase;
  message: string;
  detail?: string;
  progress?: number; // 0-100
  error?: string;
}

// Sandbox sync types (per-session file sync)
export type SandboxSyncPhase =
  | 'starting_agent' // Starting WSL/Lima agent
  | 'syncing_files' // Syncing files to sandbox
  | 'syncing_skills' // Copying skills
  | 'ready' // Sync complete
  | 'error'; // Sync failed

export interface SandboxSyncStatus {
  sessionId: string;
  phase: SandboxSyncPhase;
  message: string;
  detail?: string;
  fileCount?: number;
  totalSize?: number;
}

export type ServerEvent =
  | { type: 'stream.message'; payload: { sessionId: string; message: Message } }
  | { type: 'stream.partial'; payload: { sessionId: string; delta: string } }
  | { type: 'stream.thinking'; payload: { sessionId: string; delta: string } }
  | {
      type: 'stream.executionTime';
      payload: { sessionId: string; messageId: string; executionTimeMs: number };
    }
  | {
      type: 'session.status';
      payload: { sessionId: string; status: SessionStatus; updatedAt?: number; error?: string };
    }
  | { type: 'session.update'; payload: { sessionId: string; updates: Partial<Session> } }
  | { type: 'session.list'; payload: { sessions: Session[] } }
  | { type: 'permission.request'; payload: PermissionRequest }
  | { type: 'permission.dismiss'; payload: { toolUseId: string } }
  | { type: 'sudo.password.request'; payload: SudoPasswordRequest }
  | { type: 'sudo.password.dismiss'; payload: { toolUseId: string } }
  | { type: 'trace.step'; payload: { sessionId: string; step: TraceStep } }
  | {
      type: 'trace.update';
      payload: { sessionId: string; stepId: string; updates: Partial<TraceStep> };
    }
  | { type: 'folder.selected'; payload: { path: string } }
  | { type: 'config.status'; payload: { isConfigured: boolean; config: AppConfig } }
  | { type: 'sandbox.progress'; payload: SandboxSetupProgress }
  | { type: 'sandbox.sync'; payload: SandboxSyncStatus }
  | { type: 'skills.storageChanged'; payload: SkillsStorageChangeEvent }
  | {
      type: 'skills.conflict-detected';
      payload: { skillName: string; builtinPath: string; customPath: string };
    }
  | { type: 'skills.conflict-resolved'; payload: { skillName: string; winner: string } }
  | {
      type: 'skills.session-disabled-changed';
      payload: { sessionId: string; disabledSkills: string[]; pinnedSkills?: string[] };
    }
  | {
      type: 'plugins.runtimeApplied';
      payload: { sessionId: string; plugins: Array<{ name: string; path: string }> };
    }
  | { type: 'workdir.changed'; payload: { path: string } }
  | {
      type: 'session.contextInfo';
      payload: {
        sessionId: string;
        contextWindow: number;
        toolSchemaTokens?: number;
        maxOutputTokens?: number;
        currentInputTokens?: number;
      };
    }
  | {
      type: 'navigate.to';
      payload: { page: 'welcome' | 'settings' | 'session'; tab?: string; sessionId?: string };
    }
  | { type: 'native-theme.changed'; payload: { shouldUseDarkColors: boolean } }
  | { type: 'new-session' }
  | { type: 'navigate'; payload: string }
  | { type: 'scheduled-task.error'; payload: { taskId: string; error: string } }
  | { type: 'scheduled-task.catch-up'; payload: { tasks: MissedTaskInfo[] } }
  | {
      type: 'scheduled-task.started';
      payload: { taskId: string; runId: string; sessionId: string };
    }
  | {
      type: 'scheduled-task.completed';
      payload: {
        taskId: string;
        runId: string;
        status: ScheduledTaskRunStatus;
        tokensUsed: number | null;
      };
    }
  | {
      type: 'scheduled-task.config-invalid';
      payload: { taskId: string; configSetId: string; error: string };
    }
  | {
      type: 'scheduled-task.budget-exceeded';
      payload: { taskId: string; runId: string; budgetType: 'time' | 'tokens' };
    }
  | {
      type: 'error';
      payload: {
        message: string;
        code?: 'CONFIG_REQUIRED_ACTIVE_SET';
        action?: 'open_api_settings';
      };
    }
  | {
      type: 'workspace.orphans_detected';
      payload: import('../../shared/workspace-orphan-types').OrphanDetectionResult;
    };

// Settings types
import type { SystemPromptFileChoice } from '../../shared/system-prompt-file-choices';
export type { SystemPromptFileChoice };

export interface Settings {
  theme: AppTheme;
  apiKey?: string;
  defaultTools: string[];
  permissionRules: PermissionRule[];
  /**
   * Prefix patterns (with `*` wildcard) for bash commands that should be
   * auto-approved without prompting. Matched against each sub-command in a
   * chained command individually — see `decideBashPermission`.
   */
  bashTrustedCommands: string[];
  /**
   * Substring patterns for bash commands that must always require manual
   * approval, overriding any match in `bashTrustedCommands`.
   */
  bashDenylist: string[];
  /**
   * Directories the agent may write to without being asked — visible bash
   * write targets and the write/edit tools. Empty = the write checks are off.
   */
  trustedDirectories: string[];
  globalSkillsPath: string;
  systemPromptFileEnabled: boolean;
  systemPromptFilePriority: string[];
  memoryStrategy: 'auto' | 'manual' | 'rolling';
  maxContextTokens: number;
  // Scheduler settings (v2)
  schedulerCatchUpPolicy?: CatchUpPolicy;
  schedulerConflictPolicy?: ConflictPolicy;
  schedulerRunHistoryDepth?: number;
  // Permission dialog timeout in seconds. 0 = infinite (no timeout).
  permissionTimeoutSeconds?: number;
  // MCP tool execution timeout in seconds. 0 = no timeout (not recommended).
  mcpToolTimeoutSeconds?: number;
  // Native desktop notifications when the app is not focused.
  notificationsEnabled?: boolean;
}

// Tool types
export type ToolName =
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'bash'
  | 'webFetch'
  | 'webSearch';

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

// Execution context
export interface ExecutionContext {
  sessionId: string;
  cwd: string;
  mountedPaths: MountedPath[];
  allowedTools: string[];
}

// App Config types
/**
 * The 6 legacy builtin provider ids. Use for exhaustive switches over builtins.
 */
export type BuiltinProviderType =
  | 'openrouter'
  | 'anthropic'
  | 'custom'
  | 'openai'
  | 'gemini'
  | 'ollama';
/**
 * Open provider type — accepts any catalog id including native providers
 * (e.g. 'zai', 'minimax', 'deepseek') and the 6 legacy builtin ids.
 * Use BuiltinProviderType when you need exhaustive matching over the 6.
 */
export type ProviderType = string;
/**
 * Superset of ProviderType that additionally allows 'local' for the embedding sub-config only.
 * The 'local' value must never appear on the main LLM config or any ApiConfigSet provider field.
 */
export type EmbeddingProviderType = ProviderType | 'local';
export type CustomProtocolType = 'anthropic' | 'openai' | 'gemini';
export type AppTheme = 'dark' | 'light' | 'system';
/**
 * Builtin profile keys for the 6 legacy providers.
 */
export type BuiltinProfileKey =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'custom:anthropic'
  | 'custom:openai'
  | 'custom:gemini';
/**
 * Profile key — builtin slot or a native provider slot (`native:<piProvider>`).
 * Each native provider gets its own credential slot so switching between
 * providers preserves both saved keys.
 */
export type ProviderProfileKey = BuiltinProfileKey | `native:${string}`;
export type ConfigSetId = string;

/**
 * Mirrors `ProviderCredentials` in src/main/config/config-store.ts.
 * Credentials for one provider id — global, one slot per provider.
 */
export interface ProviderCredentials {
  apiKey: string;
  /** Endpoint override: ollama, or a native provider's own base URL. */
  baseUrl?: string;
}

/** Mirrors `ProviderCredentialMap` in main — one slot per provider id. */
export type ProviderCredentialMap = Partial<Record<ProviderProfileKey, ProviderCredentials>>;

/**
 * Mirrors `CustomEndpoint` in main. The only user-named credential object —
 * catalog providers are already named by the catalog itself.
 */
export interface CustomEndpoint {
  id: string;
  name: string;
  protocol: CustomProtocolType;
  baseUrl: string;
  apiKey: string;
  /** Pre-fills the model step when a set first points at this endpoint. */
  defaultModel?: string;
  updatedAt: string;
}

/**
 * Mirrors `CredentialConflict` in main: a credential the one-time migration
 * could not carry over, because two config sets held different keys for one
 * provider. Ids only, never a key — `target` is a credential slot or a custom
 * endpoint id, `setIds` the sets whose key was dropped.
 */
export interface CredentialConflict {
  target: string;
  setIds: string[];
}

/** Re-exported from shared/thinking-levels to keep renderer types consistent with main. */
export type ModelThinkingLevel = SharedModelThinkingLevel;

export interface ThinkingCapabilities {
  supportsThinking: boolean;
  levels: ModelThinkingLevel[];
}

export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  /** Which `customEndpoints` entry supplies the credential; custom sets only. */
  endpointId?: string;
  /** Model selection — a set picks a provider and a model, and holds no credential. */
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  enableThinking: boolean;
  /** Replaces enableThinking. Always a valid ModelThinkingLevel after normalization. */
  thinkingLevel: ModelThinkingLevel;
  updatedAt: string;
}

export interface CreateSetPayload {
  name: string;
  mode: 'blank' | 'clone';
  fromSetId?: string;
}

/**
 * Result of a config mutation that can fail **without throwing**.
 *
 * Only `config.save` needs this: it performs server-side `httpProxy` validation
 * and returns a structured rejection, because the renderer's own validation can
 * be bypassed via devtools or a corrupted config on disk
 * (`src/main/index.ts`, the `config.save` handler).
 *
 * A discriminated union rather than `{ success: boolean; config: AppConfig }`
 * because the failure branch carries **no `config`**. The old shape claimed one
 * was always present and let three call sites each get it wrong in a different
 * way — a dead `if (result.success)` with no catch, an ignored `success: false`
 * that reported "Saved", and an unguarded `result.config` read.
 */
export type ConfigSaveResult =
  | { success: true; config: AppConfig }
  | { success: false; error: string };

/**
 * Result of a config mutation whose only failure mode is a rejected promise.
 *
 * The config-set and custom-endpoint handlers validate by throwing (cap reached,
 * duplicate URL, endpoint in use, not found) and the renderer catches and
 * translates the message. They therefore carry no `success` flag: one that is
 * always `true` is an invitation to write a dead branch.
 */
export interface ConfigMutationResult {
  config: AppConfig;
}

/** Shared fields for both LLM and embedding memory runtime sub-configs. */
export interface MemoryModelRuntimeConfigBase {
  inheritFromActive: boolean;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}

/** LLM sub-config: provider is always a ProviderType (never 'local'). */
export interface MemoryLLMRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: ProviderType;
}

/** Embedding sub-config: provider may be 'local' for in-process ONNX inference. */
export interface MemoryEmbeddingRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: EmbeddingProviderType;
}

/**
 * @deprecated Use MemoryLLMRuntimeConfig or MemoryEmbeddingRuntimeConfig directly.
 * Kept as a union alias so existing consumers that reference MemoryModelRuntimeConfig
 * continue to compile during the transition.
 */
export type MemoryModelRuntimeConfig = MemoryLLMRuntimeConfig | MemoryEmbeddingRuntimeConfig;

export interface MemoryRuntimeConfig {
  llm: MemoryLLMRuntimeConfig;
  embedding: MemoryEmbeddingRuntimeConfig;
  useEmbedding: boolean;
  maxNavSteps: number;
  ingestionConcurrency: number;
  storageRoot?: string;
  evalEnabled?: boolean;
  evalWorkspaces?: string[];
  evalMaxRounds?: number;
  evalArtifactsRoot?: string;
  promptIterationRounds?: number;
  // Advanced retrieval scoring parameters
  recencyFloor?: number;
  recencyCeiling?: number;
  recencyDecayDays?: number;
  supersessionPenalty?: number;
  supersessionKeywordThreshold?: number;
  /** Tool name patterns whose results are included in extraction but workspace-pinned. */
  pinnedToolPatterns?: string[];
}

export interface AppConfig {
  provider: ProviderType;
  apiKey: string;
  baseUrl?: string;
  customProtocol?: CustomProtocolType;
  /** The custom endpoint the active set points at; custom sets only. */
  endpointId?: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  /**
   * Global credential map, one slot per provider id. Authoritative: this is
   * where a catalog provider's key and base URL live, and what the Settings
   * form hydrates from. Written through `config.setProviderCredential`.
   */
  providerCredentials: ProviderCredentialMap;
  /** User-created custom endpoints. Authoritative; written through the endpoint CRUD calls. */
  customEndpoints: CustomEndpoint[];
  /** Credentials the migration could not carry over. See `CredentialConflict`. */
  credentialConflicts: CredentialConflict[];
  activeConfigSetId: ConfigSetId;
  configSets: ApiConfigSet[];
  claudeCodePath?: string;
  defaultWorkdir?: string;
  globalSkillsPath?: string;
  localDevPath?: string;
  systemPromptFileEnabled?: boolean;
  systemPromptFilePriority?: string[];
  // Bash command trust list and denylist. Optional on the renderer side
  // because the Settings bootstrap hydrates them defensively via `?? []`.
  // Main's `AppConfig` keeps these required and always non-null.
  bashTrustedCommands?: string[];
  bashDenylist?: string[];
  trustedDirectories?: string[];
  theme?: AppTheme;
  sandboxEnabled?: boolean;
  memoryEnabled?: boolean;
  memoryRuntime?: MemoryRuntimeConfig;
  enableThinking?: boolean;
  /** Replaces enableThinking. Always a valid ModelThinkingLevel after normalization. */
  thinkingLevel?: ModelThinkingLevel;
  isConfigured: boolean;
  // Scheduler settings (v2)
  schedulerCatchUpPolicy?: CatchUpPolicy;
  schedulerConflictPolicy?: ConflictPolicy;
  schedulerRunHistoryDepth?: number;
  // Permission dialog timeout in seconds. 0 = infinite (no timeout).
  permissionTimeoutSeconds?: number;
  // MCP tool execution timeout in seconds. 0 = no timeout (not recommended).
  mcpToolTimeoutSeconds?: number;
  // Native desktop notifications when the app is not focused.
  notificationsEnabled?: boolean;
  // Optional HTTP proxy URL for all outbound API requests.
  httpProxy?: string;
}

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  models: { id: string; name: string }[];
  keyPlaceholder: string;
  keyHint: string;
}

export interface ProviderPresets {
  openrouter: ProviderPreset;
  anthropic: ProviderPreset;
  custom: ProviderPreset;
  openai: ProviderPreset;
  gemini: ProviderPreset;
  ollama: ProviderPreset;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
}

export interface ApiTestInput {
  provider: AppConfig['provider'];
  apiKey: string;
  baseUrl?: string;
  customProtocol?: AppConfig['customProtocol'];
  model?: string;
  useLiveRequest?: boolean;
  verificationLevel?: DiagnosticVerificationLevel;
}

export interface ApiTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  errorType?:
    | 'missing_key'
    | 'missing_base_url'
    | 'unauthorized'
    | 'not_found'
    | 'rate_limited'
    | 'server_error'
    | 'network_error'
    | 'ollama_not_running'
    | 'ollama_loading'
    | 'unknown';
  details?: string;
}

// API Diagnostics types
export type DiagnosticStepName = 'dns' | 'tcp' | 'tls' | 'auth' | 'model';
export type DiagnosticStepStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skip';
export type DiagnosticVerificationLevel = 'fast' | 'deep';
export type DiagnosticAdvisoryCode = 'not_deep_verified' | 'model_loading' | 'manual_model';

export interface DiagnosticStep {
  name: DiagnosticStepName;
  status: DiagnosticStepStatus;
  latencyMs?: number;
  error?: string;
  fix?: string;
}

export interface DiagnosticResult {
  steps: DiagnosticStep[];
  overallOk: boolean;
  /** Which step failed first (null if all ok) */
  failedAt?: DiagnosticStepName;
  totalLatencyMs: number;
  verificationLevel?: DiagnosticVerificationLevel;
  advisoryCode?: DiagnosticAdvisoryCode;
  advisoryText?: string;
  /** Present when the run was skipped (e.g. 'concurrent_run') */
  skippedReason?: string;
}

export interface DiagnosticInput {
  provider: AppConfig['provider'];
  apiKey: string;
  baseUrl?: string;
  customProtocol?: AppConfig['customProtocol'];
  model?: string;
  verificationLevel?: DiagnosticVerificationLevel;
}

export interface LocalServiceInfo {
  type: 'ollama';
  baseUrl: string;
  models?: string[];
}

export type LocalOllamaDiscoveryStatus = 'unavailable' | 'service_available' | 'models_available';

export interface LocalOllamaDiscoveryResult {
  available: boolean;
  baseUrl: string;
  models?: string[];
  status: LocalOllamaDiscoveryStatus;
}

// MCP types
export interface MCPServerInfo {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  tools?: MCPToolInfo[];
}

export interface MCPToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  /** MCP ToolAnnotations from the server (readOnlyHint, destructiveHint, etc.) */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}
