/**
 * Chat Export — Shared Types, Options, and Filtering
 *
 * Extracted from export-markdown.ts so all serializers (markdown, HTML→DOCX,
 * HTML→PDF) share identical types and message-inclusion logic.
 *
 * NOTE: Content block interfaces are duplicated here from src/renderer/types/index.ts
 * to avoid cross-process import issues (main cannot import from renderer).
 * If the renderer types change, these must be updated to match.
 * TODO: Move shared message/content types to src/shared/ for single-source-of-truth.
 */

// ---------------------------------------------------------------------------
// Content block types (mirrored from renderer)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
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
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface FileAttachmentContent {
  type: 'file_attachment';
  filename: string;
  relativePath: string;
  size: number;
  mimeType?: string;
}

export type ContentBlock =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent
  | FileAttachmentContent;

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: number;
  tokenUsage?: { input: number; output: number };
  executionTimeMs?: number;
}

export interface Session {
  id: string;
  title: string;
  model?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Export options
// ---------------------------------------------------------------------------

export interface ExportOptions {
  includeToolCalls: boolean;
  includeThinking: boolean;
  includeTimestamps: boolean;
  includeTokenUsage: boolean;
  imageHandling: 'skip' | 'placeholder' | 'inline';
}

export type ExportFormat = 'md' | 'docx' | 'pdf';

export interface ExportRequest {
  sessionId: string;
  messageIds?: string[];
  options?: Partial<ExportOptions>;
  /** Preferred export format. When provided, the save dialog pre-selects this
   * format's filter and the extension is enforced if the user omits one.
   * Defaults to 'md' if not specified. */
  format?: ExportFormat;
}

export interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  includeToolCalls: false,
  includeThinking: false,
  includeTimestamps: false,
  includeTokenUsage: false,
  imageHandling: 'placeholder',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a filename.
 * Preserves unicode letters (Chinese, etc.) but removes dangerous chars.
 * Also guards against Windows reserved device names and empty results.
 */
export function sanitizeFilename(str: string): string {
  const unsafe = new Set('<>:"/\\|?*'.split(''));
  const cleaned = Array.from(str)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (code <= 0x1f) return false; // control characters
      if (unsafe.has(ch)) return false;
      return true;
    })
    .join('');
  let result = cleaned
    .trim()
    .replace(/\s+/g, '-')
    // Strip trailing dots and spaces (invalid on Windows)
    .replace(/[. ]+$/, '')
    .slice(0, 100);

  // Fallback if sanitization produces an empty string
  if (!result) return 'chat';

  // Guard Windows reserved device names (case-insensitive).
  // Both bare names (CON) and names with extensions (CON.txt, LPT1.pdf) are
  // reserved on Windows and will fail to open/write.
  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  if (RESERVED.test(result)) {
    result = `_${result}`;
  }

  return result;
}

/**
 * Format file size for display.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Returns true if a content block produces visible output under the given options.
 * Used to skip messages that are entirely invisible (e.g. tool-only turns when
 * includeToolCalls is off).
 */
export function blockIsVisible(block: ContentBlock, options: ExportOptions): boolean {
  switch (block.type) {
    case 'text':
      return Boolean((block as TextContent).text.trim());
    case 'thinking':
      return options.includeThinking;
    case 'tool_use':
    case 'tool_result':
      return options.includeToolCalls;
    case 'image':
      return options.imageHandling !== 'skip';
    case 'file_attachment':
      return true;
    default:
      return false;
  }
}

/**
 * Filter a raw message list down to exportable messages:
 * - no partial/streaming messages
 * - no system messages
 * - at least one visible block under the given options
 */
export function filterExportableMessages(messages: Message[], options: ExportOptions): Message[] {
  return messages.filter((msg) => {
    if (msg.id.startsWith('partial-')) return false;
    if (msg.role === 'system') return false;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    return blocks.some((b) => blockIsVisible(b, options));
  });
}
