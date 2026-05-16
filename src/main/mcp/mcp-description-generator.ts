/**
 * @module main/mcp/mcp-description-generator
 *
 * Generates server-level descriptions for MCP servers to help the LLM
 * choose the correct tool when multiple servers are connected.
 *
 * Two strategies:
 * 1. LLM one-shot — uses the user's configured model via runPiAiOneShot()
 * 2. Heuristic fallback — extracts verbs from tool names (no LLM needed)
 *
 * Also provides:
 * - computeToolsHash() for change detection
 * - sanitizeDescription() for system prompt injection safety
 */

import * as crypto from 'crypto';
import { runPiAiOneShot } from '../claude/claude-sdk-one-shot';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import type { MCPTool } from './mcp-manager';

// --- Constants ---

const GENERATION_SYSTEM_PROMPT = `You generate concise MCP server descriptions for LLM tool routing.
Given a server name and its tool list, write a single sentence (max 25 words) describing
what this server does. Focus on the domain and capabilities, not individual tools.

IMPORTANT: Your final answer must be plain text only — not inside any thinking or reasoning tags.
Reply with only the description text, no quotes, no prefix, no explanation.`;

/** Max tools to include in the LLM prompt (token budget). */
const MAX_TOOLS_FOR_LLM = 30;

/** Max description length after sanitization. */
const MAX_DESCRIPTION_LENGTH = 200;

// --- Public API ---

/**
 * Generate a server description using the user's configured LLM.
 * Returns null if the LLM call fails (caller should fall back to heuristic).
 */
export async function generateServerDescription(
  serverName: string,
  tools: MCPTool[]
): Promise<string | null> {
  if (tools.length === 0) {
    return null;
  }

  const toolList = tools
    .slice(0, MAX_TOOLS_FOR_LLM)
    .map((t) => `- ${stripMcpPrefix(t.name)}: ${t.description || '(no description)'}`)
    .join('\n');

  const truncationNote =
    tools.length > MAX_TOOLS_FOR_LLM
      ? `\n(${tools.length - MAX_TOOLS_FOR_LLM} more tools omitted)`
      : '';

  const userPrompt = `Server name: "${serverName}"\nTools:\n${toolList}${truncationNote}`;

  try {
    const config = configStore.getAll();

    // Check if API key is configured — skip LLM call if not
    if (!config.apiKey?.trim()) {
      log(
        '[MCPDescriptionGenerator] No API key configured, skipping LLM generation for:',
        serverName
      );
      return null;
    }

    log(
      '[MCPDescriptionGenerator] Calling LLM for description of:',
      serverName,
      'provider:',
      config.provider,
      'model:',
      config.model
    );

    const result = await runPiAiOneShot(userPrompt, GENERATION_SYSTEM_PROMPT, config, {
      temperature: 0,
      maxTokens: 100,
    });

    const rawText: string | null = result.text || null;

    // If LLM returned no text (e.g., thinking-only model), fall back to template.
    // Do NOT use thinking content as description — it's reasoning, not a final answer.
    if (!rawText) {
      if (result.hasThinking) {
        log(
          '[MCPDescriptionGenerator] Model produced thinking only (no text block) for:',
          serverName,
          '— using template fallback'
        );
      } else {
        logWarn('[MCPDescriptionGenerator] LLM returned no usable text for:', serverName);
      }
      return null;
    }

    const description = sanitizeDescription(rawText);
    if (!description) {
      logWarn(
        '[MCPDescriptionGenerator] LLM returned empty description after sanitization for:',
        serverName
      );
      return null;
    }

    log('[MCPDescriptionGenerator] Generated description for', serverName, ':', description);
    return description;
  } catch (error) {
    logWarn(
      '[MCPDescriptionGenerator] LLM generation failed for',
      serverName,
      ':',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Generate a description from tool names and descriptions using template-based summarization.
 * No LLM needed — uses the tool metadata directly to compose a meaningful summary.
 * Always returns a non-empty string.
 */
export function generateHeuristicDescription(serverName: string, tools: MCPTool[]): string {
  if (tools.length === 0) {
    return `${cleanServerName(serverName)} (no tools discovered)`;
  }

  const cleanName = cleanServerName(serverName);

  // Strategy 1: If tools have good descriptions, summarize from them
  const toolsWithDescriptions = tools.filter((t) => t.description && t.description.length > 5);
  if (toolsWithDescriptions.length >= Math.min(2, tools.length)) {
    const result = buildFromDescriptions(cleanName, toolsWithDescriptions);
    // If description extraction produced a meaningful result (not just "name (N tools)"), use it
    if (!result.endsWith('tools)')) {
      return result;
    }
  }

  // Strategy 2: Fall back to tool name analysis
  return buildFromToolNames(cleanName, tools);
}

/**
 * Build a description by extracting key capabilities from tool descriptions.
 * Finds common themes/actions across tool descriptions and composes a summary.
 */
function buildFromDescriptions(serverName: string, tools: MCPTool[]): string {
  // Extract the core action/capability from each tool description
  const capabilities: string[] = [];

  for (const tool of tools.slice(0, 10)) {
    const cap = extractCapability(tool.description);
    if (cap && !capabilities.some((c) => c.toLowerCase() === cap.toLowerCase())) {
      capabilities.push(cap);
    }
  }

  if (capabilities.length === 0) {
    return `${serverName} (${tools.length} tools)`;
  }

  // Compose: take up to 4 capabilities, join naturally
  const selected = capabilities.slice(0, 4);
  const joined =
    selected.length <= 2
      ? selected.join(' and ')
      : selected.slice(0, -1).join(', ') + ', and ' + selected[selected.length - 1];

  // Capitalize first letter
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1) + '.';

  // Keep under 200 chars
  if (sentence.length > 180) {
    return `${serverName}: ${selected.slice(0, 3).join(', ')}.`;
  }

  return sentence;
}

/**
 * Extract a short capability phrase from a tool description.
 * E.g., "Search for Eurostat datasets by keyword" → "search for Eurostat datasets by keyword"
 *       "\nGet detailed information about a dataset.\n\nArgs:..." → "get detailed information about a dataset"
 */
function extractCapability(description: string): string | null {
  if (!description || description.length < 5) return null;

  // Trim leading/trailing whitespace and newlines
  const trimmed = description.trim();

  // Take the first sentence/clause (before period, semicolon, or double-newline)
  let phrase = trimmed.split(/[.;\n\n]/)[0].trim();

  // If first split was empty (e.g., started with delimiter), try next non-empty segment
  if (!phrase) {
    const segments = trimmed.split(/[.;\n]/).filter((s) => s.trim().length > 3);
    phrase = segments[0]?.trim() || '';
  }

  if (!phrase || phrase.length < 5) return null;

  // Remove common prefixes that don't add meaning
  phrase = phrase
    .replace(/^(This tool |Tool to |Used to |Use this to |Allows you to |A tool that )/i, '')
    .replace(/^(Provides |Enables |Performs |Executes |Runs |Returns )/i, '')
    .trim();

  // Lowercase the first word (it's now a verb or noun phrase)
  if (phrase.length > 0) {
    phrase = phrase.charAt(0).toLowerCase() + phrase.slice(1);
  }

  // Truncate if too long — take first meaningful clause
  if (phrase.length > 60) {
    // Try to cut at a natural boundary
    const cutPoints = [' - ', ' — ', ', ', ' with ', ' for '];
    for (const cut of cutPoints) {
      const idx = phrase.indexOf(cut);
      if (idx > 15 && idx < 55) {
        phrase = phrase.slice(0, idx);
        break;
      }
    }
    if (phrase.length > 60) {
      const words = phrase.split(/\s+/).slice(0, 8);
      phrase = words.join(' ');
    }
  }

  // Skip if too short or just the tool name repeated
  if (phrase.length < 4) return null;

  return phrase;
}

/**
 * Build a description from tool names when descriptions are unavailable.
 */
function buildFromToolNames(serverName: string, tools: MCPTool[]): string {
  const toolNames = tools.map((t) => stripMcpPrefix(t.name));
  const prefix = findCommonPrefix(toolNames);
  const verbs = new Set<string>();

  for (const name of toolNames) {
    const stripped = name.replace(prefix, '').replace(/^[_-]/, '');
    const firstWord = stripped.split(/[_-]/)[0];
    if (firstWord && firstWord.length > 2) {
      verbs.add(firstWord);
    }
  }

  const verbList = Array.from(verbs).slice(0, 5).join(', ');
  return verbList ? `${serverName}: ${verbList}` : `${serverName} (${tools.length} tools)`;
}

/**
 * Compute a deterministic hash of a tool list for change detection.
 * Only includes tool names and descriptions (not schemas — too volatile).
 */
export function computeToolsHash(tools: MCPTool[]): string {
  const payload = tools
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/**
 * Sanitize a description for safe injection into the system prompt.
 * Strips control characters, escapes XML-like delimiters, limits length, trims whitespace.
 */
export function sanitizeDescription(raw: string): string {
  // Strip control characters (except newline/tab which we also strip)
  // eslint-disable-next-line no-control-regex
  let cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ');
  // Escape angle brackets to prevent prompt structure poisoning
  cleaned = cleaned.replace(/</g, '＜').replace(/>/g, '＞');
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // Limit length
  if (cleaned.length > MAX_DESCRIPTION_LENGTH) {
    cleaned = cleaned.slice(0, MAX_DESCRIPTION_LENGTH - 1) + '…';
  }
  return cleaned;
}

/**
 * Sanitize a server name for safe use in the system prompt directory.
 */
export function sanitizeServerName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '');
  cleaned = cleaned.replace(/</g, '').replace(/>/g, '');
  return cleaned.trim().slice(0, 60);
}

// --- Internal helpers ---

/**
 * Strip the `mcp__ServerName__` prefix from a tool name for cleaner display.
 */
function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const remainder = toolName.slice('mcp__'.length);
    const separatorIndex = remainder.indexOf('__');
    if (separatorIndex !== -1) {
      return remainder.slice(separatorIndex + 2);
    }
  }
  return toolName;
}

/**
 * Find the longest common prefix among tool names (at a word boundary).
 */
function findCommonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const sorted = [...names].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  // Only use prefix if it ends at a word boundary
  const prefix = first.slice(0, i);
  const lastSep = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'));
  return lastSep > 0 ? prefix.slice(0, lastSep + 1) : '';
}

/**
 * Clean a server name for display (replace separators with spaces).
 */
function cleanServerName(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim();
}
