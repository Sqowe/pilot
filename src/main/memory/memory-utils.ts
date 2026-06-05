import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentBlock, Message } from '../../renderer/types';
import type {
  AppliedCoreMemoryAction,
  CoreMemoryActionInput,
  CoreMemoryCategory,
  CoreMemoryEntry,
  MemoryTranscriptTurn,
} from './memory-types';

const EN_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'have',
  'will',
  'into',
  'about',
  'please',
  'using',
  'user',
  'assistant',
  'need',
  'want',
  'help',
  'make',
  'just',
  'then',
  'than',
  'them',
  'they',
  'their',
  'there',
  'here',
  'been',
  'were',
  'when',
  'what',
  'which',
  'where',
  'while',
  'after',
  'before',
  'should',
  'could',
  'would',
  'current',
  'project',
  'workspace',
  'session',
  'continue',
  'based',
]);

const ZH_STOP_WORDS = [
  '我们',
  '你们',
  '他们',
  '进行',
  '一个',
  '这个',
  '那个',
  '需要',
  '可以',
  '已经',
];
const CORE_CATEGORIES = new Set<CoreMemoryCategory>([
  'identity',
  'preferences',
  'skills',
  'interests',
]);

/**
 * Sentinel workspace key for sessions without a specific workspace.
 * Entries tagged with this are treated as globally-scoped.
 */
export const GLOBAL_WORKSPACE_SENTINEL = '__global__';

export function normalizeWorkspaceKey(cwd?: string | null): string | null {
  if (!cwd) {
    return null;
  }
  try {
    return path.resolve(cwd);
  } catch {
    return cwd;
  }
}

export function hashWorkspaceKey(workspaceKey: string): string {
  return crypto.createHash('sha1').update(workspaceKey).digest('hex').slice(0, 16);
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

export function loadJsonFile<T>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) {
      return defaultValue;
    }
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function saveJsonFile(filePath: string, data: unknown): void {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function safeRemoveFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function isoNow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 19);
}

export function extractJson(rawText: string): unknown {
  const text = rawText.trim();
  if (!text) {
    return null;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const match = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

export function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'thinking':
          return block.thinking;
        case 'tool_result':
          return block.content;
        case 'tool_use':
          return `${block.name} ${JSON.stringify(block.input)}`;
        case 'file_attachment':
          return `[file] ${block.filename}`;
        case 'image':
          return '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Options for filtering tool results during transcript construction for memory ingestion.
 */
export interface TranscriptFilterOptions {
  /**
   * Compiled RegExp patterns for tools whose results are included but workspace-pinned.
   * Tool results matching these patterns are included in the transcript.
   * All other tool_result/tool_use blocks are excluded.
   */
  pinnedToolPatterns: RegExp[];
}

/**
 * Result of building a filtered transcript for memory ingestion.
 */
export interface FilteredTranscriptResult {
  /** Turns from normal user/assistant text (no tool results). */
  normalTurns: MemoryTranscriptTurn[];
  /** Turns containing pinned tool results (workspace-scoped content). */
  pinnedTurns: MemoryTranscriptTurn[];
}

/** Safely test a tool name against patterns, resetting lastIndex for stateful regexes. */
function matchesPinnedPattern(toolName: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    p.lastIndex = 0;
    if (p.test(toolName)) return true;
  }
  return false;
}

export function messagesToTranscript(messages: Message[]): MemoryTranscriptTurn[] {
  return messages
    .map((message): MemoryTranscriptTurn | null => {
      const content = extractTextFromContent(message.content);
      if (!content) {
        return null;
      }
      return {
        role: message.role,
        content,
        messageId: message.id,
        timestamp: message.timestamp,
      };
    })
    .filter((item): item is MemoryTranscriptTurn => Boolean(item));
}

/**
 * Build a filtered transcript for memory ingestion with tool result scoping.
 * Produces two separate transcript streams:
 * - normalTurns: content from user/assistant text (no tool results)
 * - pinnedTurns: content from pinned tool results only
 *
 * This separation allows the caller to extract core memory from each stream
 * independently, applying workspacePinned only to entries from pinnedTurns.
 *
 * Assistant messages that immediately follow a pinned tool result are routed
 * to the pinned stream because they typically summarize/restate the tool content.
 * The taint window resets on the next independent user message.
 *
 * @param allMessages Full message list for the session (used to resolve
 *   tool_use → tool_result links even when processing a slice).
 * @param deltaMessages The message slice to extract turns from.
 * @param filterOptions Tool filtering configuration.
 */
export function messagesToTranscriptFiltered(
  allMessages: Message[],
  deltaMessages: Message[],
  filterOptions: TranscriptFilterOptions
): FilteredTranscriptResult {
  const pinnedPatterns = filterOptions.pinnedToolPatterns;

  // Build a lookup map for O(1) tool name resolution from tool_use ID.
  const toolNameById = new Map<string, string>();
  for (const msg of allMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  const normalTurns: MemoryTranscriptTurn[] = [];
  const pinnedTurns: MemoryTranscriptTurn[] = [];

  // Taint state tracks whether subsequent assistant messages should be:
  // - 'none': no taint, route to normalTurns
  // - 'pinned': route to pinnedTurns (after pinned tool results)
  // - 'excluded': drop entirely (after non-pinned tool results)
  type TaintState = 'none' | 'pinned' | 'excluded';

  // Compute initial taint state from messages before the delta range.
  let taint: TaintState = 'none';
  const deltaIds = new Set(deltaMessages.map((m) => m.id));
  for (const msg of allMessages) {
    if (deltaIds.has(msg.id)) break; // Reached the delta range
    const hasToolResult = msg.content.some((block) => block.type === 'tool_result');
    if (hasToolResult) {
      const hasPinnedResult = msg.content.some((block) => {
        if (block.type !== 'tool_result') return false;
        const toolName = toolNameById.get(block.toolUseId);
        return toolName != null && matchesPinnedPattern(toolName, pinnedPatterns);
      });
      const hasNonPinnedResult = msg.content.some((block) => {
        if (block.type !== 'tool_result') return false;
        const toolName = toolNameById.get(block.toolUseId);
        return !toolName || !matchesPinnedPattern(toolName, pinnedPatterns);
      });
      if (hasPinnedResult && !hasNonPinnedResult) {
        taint = 'pinned';
      } else {
        taint = 'excluded'; // Non-pinned or mixed
      }
    } else if (msg.role === 'user') {
      taint = 'none';
    }
  }

  for (const message of deltaMessages) {
    const normalParts: string[] = [];
    const pinnedParts: string[] = [];
    let messageHasPinnedResult = false;
    let messageHasAnyToolResult = false;

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          normalParts.push(block.text);
          break;
        case 'thinking':
          normalParts.push(block.thinking);
          break;
        case 'tool_result': {
          messageHasAnyToolResult = true;
          const toolName = toolNameById.get(block.toolUseId);
          if (toolName && matchesPinnedPattern(toolName, pinnedPatterns)) {
            pinnedParts.push(block.content);
            messageHasPinnedResult = true;
          }
          // All other tool results excluded from both streams
          break;
        }
        case 'tool_use': {
          // tool_use inputs excluded from both streams
          break;
        }
        case 'file_attachment':
          normalParts.push(`[file] ${block.filename}`);
          break;
        case 'image':
          normalParts.push('[image]');
          break;
        default:
          break;
      }
    }

    // Update taint based on tool results in this message.
    // If message has any non-pinned tool result, prefer 'excluded' (safety first).
    // Only set 'pinned' if ALL tool results in the message are pinned.
    if (messageHasAnyToolResult) {
      if (
        messageHasPinnedResult &&
        !message.content.some(
          (block) =>
            block.type === 'tool_result' &&
            !matchesPinnedPattern(toolNameById.get(block.toolUseId) || '', pinnedPatterns)
        )
      ) {
        taint = 'pinned'; // All tool results are pinned
      } else if (messageHasPinnedResult) {
        taint = 'excluded'; // Mixed — prefer exclusion for safety
      } else {
        taint = 'excluded'; // Only non-pinned tool results
      }
    }

    // Route normal text based on taint state:
    // - 'pinned' + assistant: route to pinned stream (restates pinned tool content)
    // - 'excluded' + assistant: drop (restates non-pinned tool content)
    // - 'none' or user message: route to normal stream
    const normalText = normalParts.filter(Boolean).join('\n').trim();
    if (normalText) {
      if (taint === 'pinned' && message.role === 'assistant') {
        pinnedParts.push(normalText);
      } else if (taint === 'excluded' && message.role === 'assistant') {
        // Drop — assistant is likely restating non-pinned tool results
      } else {
        normalTurns.push({
          role: message.role,
          content: normalText,
          messageId: message.id,
          timestamp: message.timestamp,
        });
      }
    }

    // Clear taint when an independent user message arrives (no tool results)
    if (message.role === 'user' && !messageHasAnyToolResult) {
      taint = 'none';
    }

    const pinnedText = pinnedParts.filter(Boolean).join('\n').trim();
    if (pinnedText) {
      pinnedTurns.push({
        role: message.role,
        content: pinnedText,
        messageId: message.id,
        timestamp: message.timestamp,
      });
    }
  }

  return { normalTurns, pinnedTurns };
}

export function compactTranscript(turns: MemoryTranscriptTurn[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.content.trim()}`).join('\n');
}

export function summarizeText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function tokenizeSearchQuery(query: string): string[] {
  return Array.from(new Set(simpleTokenize(query))).slice(0, 16);
}

export function simpleTokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || []).filter(
    (token) => !EN_STOP_WORDS.has(token) && !ZH_STOP_WORDS.includes(token)
  );
}

export function lexicalScore(query: string, text: string): number {
  const queryTerms = new Map<string, number>();
  for (const token of simpleTokenize(query)) {
    queryTerms.set(token, (queryTerms.get(token) || 0) + 1);
  }
  const itemTerms = new Map<string, number>();
  for (const token of simpleTokenize(text)) {
    itemTerms.set(token, (itemTerms.get(token) || 0) + 1);
  }
  if (!queryTerms.size || !itemTerms.size) {
    return 0;
  }
  let overlap = 0;
  let queryCount = 0;
  let itemCount = 0;
  for (const value of queryTerms.values()) {
    queryCount += value;
  }
  for (const value of itemTerms.values()) {
    itemCount += value;
  }
  for (const [term, count] of queryTerms.entries()) {
    overlap += Math.min(count, itemTerms.get(term) || 0);
  }
  return overlap / Math.sqrt(queryCount * Math.max(itemCount, 1));
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA.length || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function extractKeywords(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const token of simpleTokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

export function stripTrailingSlashes(value?: string): string | undefined {
  return value?.trim().replace(/\/+$/, '') || undefined;
}

export function resolveCoreCombinedKey(
  category: CoreMemoryCategory | undefined,
  key: string
): string {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return '';
  }
  if (category && CORE_CATEGORIES.has(category)) {
    return `${category}.${trimmedKey}`;
  }
  return trimmedKey;
}

export function parseCoreCombinedKey(combinedKey: string): CoreMemoryEntry {
  const trimmed = combinedKey.trim();
  const separator = trimmed.indexOf('.');
  if (separator > 0) {
    const category = trimmed.slice(0, separator) as CoreMemoryCategory;
    if (CORE_CATEGORIES.has(category)) {
      return {
        combinedKey: trimmed,
        category,
        key: trimmed.slice(separator + 1),
        value: '',
      };
    }
  }
  return {
    combinedKey: trimmed,
    key: trimmed,
    value: '',
  };
}

export function applyCoreMemoryActions(
  existingMemory: Record<
    string,
    { value: string; sourceWorkspaces: string[]; workspacePinned?: boolean; scopeHash?: string }
  >,
  actions: CoreMemoryActionInput[],
  sourceWorkspace: string | null,
  options?: { workspacePinned?: boolean }
): {
  nextMemory: Record<
    string,
    { value: string; sourceWorkspaces: string[]; workspacePinned?: boolean; scopeHash?: string }
  >;
  applied: AppliedCoreMemoryAction[];
} {
  // Pinned actions require a concrete workspace — reject early if missing.
  if (options?.workspacePinned && !sourceWorkspace) {
    return { nextMemory: { ...existingMemory }, applied: [] };
  }

  const nextMemory = { ...existingMemory };
  // Deep-copy entries preserving all fields including workspacePinned and scopeHash
  for (const key of Object.keys(nextMemory)) {
    const entry = nextMemory[key];
    nextMemory[key] = {
      value: entry.value,
      sourceWorkspaces: [...entry.sourceWorkspaces],
      ...(entry.workspacePinned ? { workspacePinned: true } : {}),
      ...(entry.scopeHash ? { scopeHash: entry.scopeHash } : {}),
    };
  }
  const applied: AppliedCoreMemoryAction[] = [];

  for (const action of actions) {
    const op = action.op;
    const baseCombinedKey = resolveCoreCombinedKey(action.category, action.key);
    if (!baseCombinedKey) {
      continue;
    }

    // For workspace-pinned actions, namespace the key with the workspace hash
    // to prevent conflicts with unpinned entries or pinned entries from other workspaces.
    const scopeHash =
      options?.workspacePinned && sourceWorkspace
        ? hashWorkspaceKey(normalizeWorkspaceKey(sourceWorkspace) || sourceWorkspace)
        : undefined;
    const combinedKey = scopeHash ? `${baseCombinedKey}@${scopeHash}` : baseCombinedKey;

    if (op === 'delete') {
      // Pinned actions can only delete pinned entries (namespaced key ensures this)
      if (options?.workspacePinned && !nextMemory[combinedKey]?.workspacePinned) {
        continue; // Don't delete unpinned entries from pinned transcripts
      }
      delete nextMemory[combinedKey];
      applied.push({
        op,
        category: action.category,
        key: action.key,
        combinedKey,
      });
      continue;
    }

    const value = typeof action.value === 'string' ? action.value.trim() : '';
    if (!value) {
      continue;
    }

    // Merge workspace into sourceWorkspaces
    const existing = nextMemory[combinedKey];
    const existingWorkspaces = existing?.sourceWorkspaces || [];
    const effectiveWorkspace = sourceWorkspace
      ? normalizeWorkspaceKey(sourceWorkspace)
      : GLOBAL_WORKSPACE_SENTINEL;
    const mergedWorkspaces =
      effectiveWorkspace && !existingWorkspaces.includes(effectiveWorkspace)
        ? [...existingWorkspaces, effectiveWorkspace]
        : [...existingWorkspaces];

    nextMemory[combinedKey] = {
      value,
      sourceWorkspaces: mergedWorkspaces,
      ...(options?.workspacePinned ? { workspacePinned: true } : {}),
      ...(scopeHash ? { scopeHash } : {}),
    };
    applied.push({
      op,
      category: action.category,
      key: action.key,
      value,
      combinedKey,
    });
  }

  return { nextMemory, applied };
}

export function coreMemoryToPromptBlock(
  memory: Record<
    string,
    string | { value: string; sourceWorkspaces?: string[]; scopeHash?: string }
  >
): string {
  const entries = Object.entries(memory);
  if (!entries.length) {
    return 'None';
  }
  return entries
    .map(([key, stored]) => {
      const value = typeof stored === 'string' ? stored : stored.value;
      // For pinned entries with scopeHash, strip the @hash suffix using safe string ops
      let displayKey = key;
      if (typeof stored === 'object' && stored.scopeHash && key.endsWith(`@${stored.scopeHash}`)) {
        displayKey = key.slice(0, -(stored.scopeHash.length + 1));
        displayKey = `${displayKey} [workspace-scoped]`;
      }
      return `- ${displayKey}: ${value}`;
    })
    .join('\n');
}

export function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function getFileTimestampMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function getFileSizeBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function isSubPath(filePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
