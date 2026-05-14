/**
 * System Prompt Loader
 *
 * Loads user-editable system prompt sections from the prompts directory.
 * Each section is a separate markdown file that can be independently
 * edited, disabled, or reset to default.
 *
 * Storage: {userData}/prompts/
 *   - identity.md
 *   - behavioral-rules.md
 *   - citations.md
 *   - tool-routing.md
 *   - _meta.json (tracks enabled/disabled state)
 *
 * Dynamic sections (workspace info, bundled path hints) remain in code
 * because they depend on runtime state.
 *
 * Performance: Sections are cached in memory after first load. Cache is
 * invalidated on update/reset/toggle operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { log, logWarn, logError } from '../utils/logger';

// --- Default prompt content (shipped with the app) ---

const DEFAULT_SECTIONS: Record<string, string> = {
  'identity.md': 'You are an Open Cowork assistant. Be concise, accurate, and tool-capable.',

  'behavioral-rules.md': `CRITICAL BEHAVIORAL RULES:
1. CHAT FIRST: By default, respond to the user in plain text within the conversation. Do NOT create, write, or edit files unless the user explicitly asks you to (e.g., "create a file", "write this to...", "edit the code", "save as...", mentions a specific file path, or describes code changes they want applied). For questions, summaries, explanations, analysis, and general conversation — always reply directly in chat text.
2. When a request is actionable, proceed immediately with reasonable assumptions. If you need clarification, ask briefly in plain text.
3. For relative time windows like "within two days" in browsing or research tasks, assume the most recent two relevant publication days unless the user explicitly defines another date range.
4. For bracketed placeholders like [Agent], [Topic], etc., treat the word inside brackets as the literal search keyword unless the user says otherwise.
5. When given a task, START DOING IT. Do not restate the task, do not list what you will do, do not ask for confirmation. Just execute.`,

  'citations.md': `<citation_requirements>
If your answer uses linkable content from MCP tools, include a "Sources:" section and otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL).
</citation_requirements>`,

  'tool-routing.md': `<tool_behavior>
Tool routing:
- If user explicitly asks to use Chrome/browser/web navigation, prioritize Chrome MCP tools (mcp__Chrome__*) over generic WebSearch/WebFetch.
- Use WebSearch/WebFetch only when Chrome MCP is unavailable or the user explicitly asks for generic web search.
</tool_behavior>`,
};

/** Ordered list of section filenames (assembly order). */
const SECTION_ORDER = ['identity.md', 'behavioral-rules.md', 'citations.md', 'tool-routing.md'];

export interface PromptSection {
  id: string;
  filename: string;
  content: string;
  enabled: boolean;
  isDefault: boolean;
}

// --- In-memory cache ---
// Prompt sections for the settings UI are cached until explicitly invalidated
// (via update/reset/toggle or invalidatePromptCache()).
// The assembled prompt uses mtime+size fingerprinting: on each call it checks
// file stats (fast syscall) and only re-reads content when files have changed.
// This balances performance (no full reads on every message) with correctness
// (external edits via "Open folder" are detected within one message cycle).

let cachedSections: PromptSection[] | null = null;

function invalidateCache(): void {
  cachedSections = null;
  assembledPromptCache = null;
  assembledPromptMtimes = new Map();
}

/**
 * Explicitly invalidate the prompt cache.
 * Call this before loading sections in UI contexts where the user may
 * have edited files externally (via "Open folder").
 */
export function invalidatePromptCache(): void {
  invalidateCache();
}

// --- Path resolution ---

function getPromptsDir(): string {
  return path.join(app.getPath('userData'), 'prompts');
}

function getMetaPath(): string {
  return path.join(getPromptsDir(), '_meta.json');
}

// --- Meta file (tracks enabled/disabled state) ---

interface PromptMeta {
  disabled: string[]; // filenames of disabled sections
}

function loadMeta(): PromptMeta {
  try {
    const metaPath = getMetaPath();
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      };
    }
  } catch (err) {
    logWarn('[PromptLoader] Failed to read _meta.json, using defaults:', err);
  }
  return { disabled: [] };
}

function saveMeta(meta: PromptMeta): { success: boolean; error?: string } {
  try {
    ensurePromptsDir();
    const metaPath = getMetaPath();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown write error';
    logError('[PromptLoader] Failed to write _meta.json:', err);
    return { success: false, error: msg };
  }
}

// --- Directory management ---

function ensurePromptsDir(): boolean {
  const dir = getPromptsDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch (err) {
    logError('[PromptLoader] Failed to create prompts directory:', dir, err);
    return false;
  }
}

// --- Core functions ---

/**
 * Ensure the prompts directory exists and all default section files are present.
 * Missing files are recreated from defaults with a warning.
 * Returns false if the directory could not be created (app continues with in-memory defaults).
 */
export function ensurePromptFiles(): boolean {
  if (!ensurePromptsDir()) {
    logWarn(
      '[PromptLoader] Cannot ensure prompt files — directory creation failed. Using in-memory defaults.'
    );
    return false;
  }
  const dir = getPromptsDir();

  for (const [filename, defaultContent] of Object.entries(DEFAULT_SECTIONS)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, defaultContent, 'utf-8');
        log('[PromptLoader] Created default prompt section:', filename);
      } catch (err) {
        logError('[PromptLoader] Failed to create default section:', filename, err);
      }
    }
  }

  // Invalidate cache since files may have been recreated
  invalidateCache();
  return true;
}

/**
 * Load all prompt sections from disk.
 * Returns sections in assembly order with their enabled state.
 * Results are cached until invalidated by a write operation.
 */
export function loadPromptSections(): PromptSection[] {
  if (cachedSections) return cachedSections;

  ensurePromptFiles();
  const dir = getPromptsDir();
  const meta = loadMeta();

  const sections = SECTION_ORDER.map((filename) => {
    const filePath = path.join(dir, filename);
    let content: string;
    let isDefault = false;

    try {
      content = fs.readFileSync(filePath, 'utf-8');
      isDefault = content.trim() === (DEFAULT_SECTIONS[filename] ?? '').trim();
    } catch {
      // File was deleted after ensurePromptFiles — recreate
      logWarn('[PromptLoader] Section file missing, recreating:', filename);
      content = DEFAULT_SECTIONS[filename] ?? '';
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
      } catch (writeErr) {
        logError('[PromptLoader] Failed to recreate section:', filename, writeErr);
      }
      isDefault = true;
    }

    return {
      id: filename.replace('.md', ''),
      filename,
      content,
      enabled: !meta.disabled.includes(filename),
      isDefault,
    };
  });

  cachedSections = sections;
  return sections;
}

/**
 * Assemble the final user-editable portion of the system prompt.
 * Only includes enabled sections.
 *
 * Uses mtime-based cache invalidation: checks file modification times
 * (fast stat syscall) and only re-reads content when files have changed.
 * This avoids blocking the event loop with full reads on every message
 * while still reflecting external edits promptly.
 */
let assembledPromptCache: string | null = null;
let assembledPromptMtimes: Map<string, string> = new Map();

/** Build a fingerprint combining mtime + size for robust change detection. */
function getFileFingerprints(): Map<string, string> {
  const dir = getPromptsDir();
  const fingerprints = new Map<string, string>();
  for (const filename of SECTION_ORDER) {
    try {
      const stat = fs.statSync(path.join(dir, filename));
      fingerprints.set(filename, `${stat.mtimeMs}:${stat.size}`);
    } catch {
      fingerprints.set(filename, '0:0');
    }
  }
  // Also check _meta.json
  try {
    const metaStat = fs.statSync(getMetaPath());
    fingerprints.set('_meta.json', `${metaStat.mtimeMs}:${metaStat.size}`);
  } catch {
    fingerprints.set('_meta.json', '0:0');
  }
  return fingerprints;
}

function fingerprintsChanged(current: Map<string, string>): boolean {
  if (assembledPromptMtimes.size === 0) return true;
  for (const [key, fp] of current) {
    if (assembledPromptMtimes.get(key) !== fp) return true;
  }
  return false;
}

export function assembleUserPrompt(): string {
  const currentFingerprints = getFileFingerprints();

  if (assembledPromptCache !== null && !fingerprintsChanged(currentFingerprints)) {
    return assembledPromptCache;
  }

  // Files changed or first call — re-read
  if (!ensurePromptFiles()) {
    // Directory unavailable — use in-memory defaults for all enabled sections
    const meta = loadMeta();
    const parts = SECTION_ORDER.filter((f) => !meta.disabled.includes(f))
      .map((f) => DEFAULT_SECTIONS[f] ?? '')
      .filter((c) => c.trim());
    return parts.join('\n\n');
  }

  const dir = getPromptsDir();
  const meta = loadMeta();

  const parts: string[] = [];
  for (const filename of SECTION_ORDER) {
    if (meta.disabled.includes(filename)) continue;
    const filePath = path.join(dir, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.trim()) {
        parts.push(content);
      }
    } catch {
      // File missing — use default
      const defaultContent = DEFAULT_SECTIONS[filename] ?? '';
      if (defaultContent.trim()) {
        parts.push(defaultContent);
      }
    }
  }

  assembledPromptCache = parts.join('\n\n');
  assembledPromptMtimes = currentFingerprints;
  return assembledPromptCache;
}

/**
 * Update a section's content on disk.
 * Returns success/error for IPC callers.
 */
export function updatePromptSection(
  filename: string,
  content: string
): { success: boolean; error?: string } {
  if (!SECTION_ORDER.includes(filename)) {
    logWarn('[PromptLoader] Attempted to update unknown section:', filename);
    return { success: false, error: `Unknown section: ${filename}` };
  }
  try {
    ensurePromptsDir();
    const filePath = path.join(getPromptsDir(), filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    invalidateCache();
    log('[PromptLoader] Updated section:', filename);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown write error';
    logError('[PromptLoader] Failed to update section:', filename, err);
    return { success: false, error: msg };
  }
}

/**
 * Reset a section to its default content.
 * Returns success/error for IPC callers.
 */
export function resetPromptSection(filename: string): { success: boolean; error?: string } {
  if (!SECTION_ORDER.includes(filename)) {
    logWarn('[PromptLoader] Attempted to reset unknown section:', filename);
    return { success: false, error: `Unknown section: ${filename}` };
  }
  try {
    ensurePromptsDir();
    const defaultContent = DEFAULT_SECTIONS[filename] ?? '';
    const filePath = path.join(getPromptsDir(), filename);
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
    invalidateCache();
    log('[PromptLoader] Reset section to default:', filename);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown write error';
    logError('[PromptLoader] Failed to reset section:', filename, err);
    return { success: false, error: msg };
  }
}

/**
 * Toggle a section's enabled state.
 * Returns success/error for IPC callers.
 */
export function togglePromptSection(
  filename: string,
  enabled: boolean
): { success: boolean; error?: string } {
  if (!SECTION_ORDER.includes(filename)) {
    return { success: false, error: `Unknown section: ${filename}` };
  }
  const meta = loadMeta();
  if (enabled) {
    meta.disabled = meta.disabled.filter((f) => f !== filename);
  } else {
    if (!meta.disabled.includes(filename)) {
      meta.disabled.push(filename);
    }
  }
  const result = saveMeta(meta);
  if (result.success) {
    invalidateCache();
    log('[PromptLoader] Toggled section:', filename, 'enabled:', enabled);
  }
  return result;
}

/**
 * Get the prompts directory path (for UI "Open folder" button).
 */
export function getPromptsDirPath(): string {
  return getPromptsDir();
}

/**
 * Open the prompts directory in the system file manager.
 */
export async function openPromptsDir(): Promise<{ success: boolean; error?: string }> {
  try {
    const { shell } = await import('electron');
    const dir = getPromptsDir();
    ensurePromptsDir();
    const errorMessage = await shell.openPath(dir);
    if (errorMessage) {
      logError('[PromptLoader] shell.openPath returned error:', errorMessage);
      return { success: false, error: errorMessage };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to open folder';
    logError('[PromptLoader] Failed to open prompts directory:', err);
    return { success: false, error: msg };
  }
}

/**
 * Get the default content for a section (for "Reset to default" comparison).
 */
export function getDefaultContent(filename: string): string | null {
  return DEFAULT_SECTIONS[filename] ?? null;
}

/**
 * Get the ordered list of section filenames.
 */
export function getSectionOrder(): string[] {
  return [...SECTION_ORDER];
}
