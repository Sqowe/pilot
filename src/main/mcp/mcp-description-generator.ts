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
Reply with only the description text, no quotes, no prefix.`;

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
      return null;
    }

    const result = await runPiAiOneShot(userPrompt, GENERATION_SYSTEM_PROMPT, config, {
      temperature: 0,
      maxTokens: 100,
    });

    const description = sanitizeDescription(result.text);
    if (!description) {
      logWarn('[MCPDescriptionGenerator] LLM returned empty description for:', serverName);
      return null;
    }

    log('[MCPDescriptionGenerator] Generated description for', serverName, ':', description);
    return description;
  } catch (error) {
    logWarn('[MCPDescriptionGenerator] LLM generation failed for', serverName, ':', error);
    return null;
  }
}

/**
 * Generate a heuristic description from tool names when LLM is unavailable.
 * Always returns a non-empty string.
 */
export function generateHeuristicDescription(serverName: string, tools: MCPTool[]): string {
  if (tools.length === 0) {
    return `${cleanServerName(serverName)} (no tools discovered)`;
  }

  // Extract unique action words from tool names
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
  const cleanName = cleanServerName(serverName);

  return verbList ? `${cleanName}: ${verbList}` : `${cleanName} (${tools.length} tools)`;
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
