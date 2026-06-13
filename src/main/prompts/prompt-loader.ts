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
 * Workspace overrides: {cwd}/.cowork/prompts/
 *   - If a file with the same name exists here, it completely replaces
 *     the global section for sessions in that workspace.
 *
 * Template variables (resolved at assembly time):
 *   - {{cwd}} — current working directory
 *   - {{project_name}} — basename of cwd
 *   - {{date}} — current date (YYYY-MM-DD)
 *   - {{model}} — active model name
 *
 * Dynamic sections (workspace info, bundled path hints) remain in code
 * because they depend on runtime state.
 *
 * Performance: Uses mtime+size fingerprinting — checks file stats (fast
 * syscall) and only re-reads content when files have changed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { log, logWarn, logError } from '../utils/logger';

// --- Default prompt content (shipped with the app) ---

const DEFAULT_SECTIONS: Record<string, string> = {
  'identity.md': `You are Sqowe Pilot (Open Cowork fork) — a desktop AI assistant for information research, analysis, and local productivity tasks.
You are honest, direct, and non-sycophantic. You do not flatter the user or soften your assessments to be polite. If something is wrong, you say so plainly. If you don't know something, you say "I don't know" rather than guessing.
Current date: {{date}}. Use this as the reference point for all time-related reasoning.`,

  'behavioral-rules.md': `CRITICAL BEHAVIORAL RULES:
1. VERIFY BEFORE CLAIMING: Before stating facts, check using available tools in this order:
   a) MCP servers and local tools (codebase search, file reading)
   b) Web search (if local context is insufficient)
   Never present unverified information as fact. If you cannot verify, explicitly say so.
2. CHAT FIRST: Respond in plain text unless the user explicitly asks to create/edit files.
3. NO FILLER: Do not open with praise ("Great question!", "That's a fantastic idea!"). Start with substance.
4. DISAGREE WHEN WARRANTED: If the user's approach has flaws, say so directly with reasoning. Do not agree just to be agreeable.
5. CALIBRATE LENGTH TO TASK: Short questions get short answers. Complex analysis gets thorough treatment. Never pad responses.
6. When a request is actionable, proceed immediately. If you need clarification, ask briefly.
7. When given a task, execute it. Do not restate the task or list what you will do.
8. BASH SAFETY: Never construct commands with newlines, command substitution, or
   process substitution. Write scripts to files instead of inline code.`,

  'citations.md': `<citation_requirements>
If your answer uses linkable content from MCP tools, include a "Sources:" section and otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL).
</citation_requirements>`,

  'tool-routing.md': `<tool_behavior>
Tool routing:
- If user explicitly asks to use Chrome/browser/web navigation, prioritize Chrome MCP tools (mcp__Chrome__*) over generic WebSearch/WebFetch.
- Use WebSearch/WebFetch only when Chrome MCP is unavailable or the user explicitly asks for generic web search.

Skill preference:
- When a task can be accomplished by an installed Skill, ALWAYS use the Skill first. Do not write custom Python scripts, bash pipelines, or manual file manipulation for tasks that Skills handle.
- Skills are purpose-built, tested workflows. Custom code is a fallback, not a first choice.
- If a Skill execution fails, do NOT silently switch to a custom approach. Instead:
  1. Report the failure clearly to the user (what failed and why).
  2. Ask: "Would you like me to try fixing the Skill issue, or take a different approach?"
  3. Wait for the user's decision before proceeding.

Bash command policy:
- NEVER use inline code via \`python3 -c "..."\` or \`bash -c "..."\` with multi-line content.
  Newlines in commands trigger the permission dialog regardless of trust settings.
- Instead, write the code to a script file in \`scripts/helpers/\` first, then invoke it:
  \`python3 scripts/helpers/<name>.py\` or \`bash scripts/helpers/<name>.sh\`
- For pipelines, ensure every sub-command (split on |, &&, ||, ;) matches a trusted prefix.
  Common safe tails: head, tail, jq, grep, wc, sort, cut, tr, column.
- Prefer single commands over pipelines when possible.
- If a command would require shell constructs that always ask ($(...), backticks, &,
  process substitution), restructure as a script file.
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
  assembledPromptCacheKey = '';
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
let assembledPromptCacheKey: string = '';
let assembledPromptMtimes: Map<string, string> = new Map();

/** Build a fingerprint combining mtime + size for robust change detection. */
function getFileFingerprints(cwd?: string): Map<string, string> {
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
  // Check workspace override files
  if (cwd) {
    const wsDir = path.join(cwd, '.cowork', 'prompts');
    for (const filename of SECTION_ORDER) {
      try {
        const stat = fs.statSync(path.join(wsDir, filename));
        fingerprints.set(`ws:${filename}`, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        fingerprints.set(`ws:${filename}`, '0:0');
      }
    }
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

// --- Workspace overrides ---

/**
 * Read a workspace-level prompt override file.
 * Returns file content if it exists, null otherwise.
 */
function readWorkspaceOverride(workspacePromptsDir: string, filename: string): string | null {
  try {
    const filePath = path.join(workspacePromptsDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Workspace override not readable — fall through to global
  }
  return null;
}

// --- Template variables ---

/**
 * Resolve template variables in prompt content.
 * Supported: {{cwd}}, {{project_name}}, {{date}}, {{model}}
 */
function resolveTemplateVariables(content: string, ctx?: PromptAssemblyContext): string {
  if (!content.includes('{{')) return content;

  const cwd = ctx?.cwd || '';
  const projectName = cwd ? path.basename(cwd) : '';
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const model = ctx?.model || '';

  return content
    .replace(/\{\{cwd\}\}/g, cwd)
    .replace(/\{\{project_name\}\}/g, projectName)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{model\}\}/g, model);
}

export interface PromptAssemblyContext {
  cwd?: string;
  model?: string;
}

export function assembleUserPrompt(ctx?: PromptAssemblyContext): string {
  const cwd = ctx?.cwd || '';
  const model = ctx?.model || '';
  const currentFingerprints = getFileFingerprints(cwd);
  const cacheKey = `${cwd}:${model}`;

  if (
    assembledPromptCache !== null &&
    assembledPromptCacheKey === cacheKey &&
    !fingerprintsChanged(currentFingerprints)
  ) {
    return assembledPromptCache;
  }

  // Files changed or first call — re-read
  if (!ensurePromptFiles()) {
    // Directory unavailable — use in-memory defaults for all enabled sections
    const meta = loadMeta();
    const parts = SECTION_ORDER.filter((f) => !meta.disabled.includes(f))
      .map((f) => DEFAULT_SECTIONS[f] ?? '')
      .filter((c) => c.trim());
    return resolveTemplateVariables(parts.join('\n\n'), ctx);
  }

  const dir = getPromptsDir();
  const meta = loadMeta();
  const workspacePromptsDir = cwd ? path.join(cwd, '.cowork', 'prompts') : null;

  const parts: string[] = [];
  for (const filename of SECTION_ORDER) {
    if (meta.disabled.includes(filename)) continue;

    // Check workspace override first (Option A: full replace)
    let content: string | null = null;
    if (workspacePromptsDir) {
      content = readWorkspaceOverride(workspacePromptsDir, filename);
    }

    // Fall back to global section
    if (content === null) {
      const filePath = path.join(dir, filename);
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        content = DEFAULT_SECTIONS[filename] ?? '';
      }
    }

    if (content.trim()) {
      parts.push(content);
    }
  }

  const assembled = resolveTemplateVariables(parts.join('\n\n'), ctx);
  assembledPromptCache = assembled;
  assembledPromptCacheKey = cacheKey;
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
 * Reset ALL sections to factory defaults and re-enable all.
 * Uses backup-and-rollback: reads current state into memory before writing.
 * If any backup read fails, aborts immediately (no writes).
 * If any write fails mid-operation, restores previous content/state.
 * Returns success/error for IPC callers.
 */
export function resetAllPromptSections(): { success: boolean; error?: string } {
  try {
    if (!ensurePromptsDir()) {
      return { success: false, error: 'Cannot access prompts directory' };
    }
    const dir = getPromptsDir();
    const metaPath = getMetaPath();

    // Phase 1: Snapshot current state for rollback.
    // Fail fast if any existing file cannot be read.
    const backups: Map<string, string | null> = new Map(); // null = file did not exist
    for (const filename of SECTION_ORDER) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        try {
          backups.set(filename, fs.readFileSync(filePath, 'utf-8'));
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : 'Unknown read error';
          logError('[PromptLoader] Cannot snapshot section for rollback:', filename, readErr);
          return {
            success: false,
            error: `Cannot snapshot current prompt state (${filename}): ${msg}. Aborting reset.`,
          };
        }
      } else {
        backups.set(filename, null);
      }
    }

    let metaBackup: string | null = null; // null = file did not exist
    if (fs.existsSync(metaPath)) {
      try {
        metaBackup = fs.readFileSync(metaPath, 'utf-8');
      } catch (readErr) {
        const msg = readErr instanceof Error ? readErr.message : 'Unknown read error';
        logError('[PromptLoader] Cannot snapshot _meta.json for rollback:', readErr);
        return {
          success: false,
          error: `Cannot snapshot current prompt state (_meta.json): ${msg}. Aborting reset.`,
        };
      }
    }

    // Phase 2: Write all defaults
    const writtenFiles: string[] = [];
    let currentlyWriting: string | null = null;
    try {
      for (const [filename, defaultContent] of Object.entries(DEFAULT_SECTIONS)) {
        currentlyWriting = filename;
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, defaultContent, 'utf-8');
        writtenFiles.push(filename);
      }
      // Clear disabled state (re-enable all)
      currentlyWriting = '_meta.json';
      fs.writeFileSync(metaPath, JSON.stringify({ disabled: [] }, null, 2), 'utf-8');
      currentlyWriting = null;
    } catch (writeErr) {
      // Phase 3: Rollback — restore or delete files to match pre-reset state.
      // Include the file that was being written when the error occurred.
      logError('[PromptLoader] resetAll write failed, rolling back:', writeErr);

      const filesToRollback = [...writtenFiles];
      if (
        currentlyWriting &&
        currentlyWriting !== '_meta.json' &&
        !filesToRollback.includes(currentlyWriting)
      ) {
        filesToRollback.push(currentlyWriting);
      }

      for (const filename of filesToRollback) {
        const backup = backups.get(filename);
        const filePath = path.join(dir, filename);
        try {
          if (backup !== null && backup !== undefined) {
            fs.writeFileSync(filePath, backup, 'utf-8');
          } else {
            // File didn't exist before — remove it
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        } catch {
          logError('[PromptLoader] Rollback failed for:', filename);
        }
      }

      // Always attempt meta restore (regardless of whether meta write succeeded,
      // failed, or was never reached — the file may have been truncated)
      try {
        if (metaBackup !== null) {
          fs.writeFileSync(metaPath, metaBackup, 'utf-8');
        } else {
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        }
      } catch {
        logError('[PromptLoader] Rollback failed for _meta.json');
      }

      const msg = writeErr instanceof Error ? writeErr.message : 'Unknown write error';
      return { success: false, error: `Reset failed (rolled back): ${msg}` };
    }

    invalidateCache();
    log('[PromptLoader] Reset ALL sections to factory defaults');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logError('[PromptLoader] Failed to reset all sections:', err);
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
