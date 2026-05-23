/**
 * Chat Export to Markdown
 *
 * Serializes chat messages into a well-formatted markdown document.
 * Handles all content block types: text, thinking, tool_use, tool_result,
 * image, and file_attachment.
 *
 * NOTE: Content block interfaces are duplicated here from src/renderer/types/index.ts
 * to avoid cross-process import issues (main cannot import from renderer).
 * If the renderer types change, these must be updated to match.
 * TODO: Move shared message/content types to src/shared/ for single-source-of-truth.
 */

import { dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import { log, logError } from '../utils/logger';

// Re-use the same content block types from the renderer
interface TextContent {
  type: 'text';
  text: string;
}

interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface FileAttachmentContent {
  type: 'file_attachment';
  filename: string;
  relativePath: string;
  size: number;
  mimeType?: string;
}

type ContentBlock =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent
  | FileAttachmentContent;

interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: number;
  tokenUsage?: { input: number; output: number };
  executionTimeMs?: number;
}

interface Session {
  id: string;
  title: string;
  model?: string;
  createdAt: number;
}

export interface ExportOptions {
  includeToolCalls: boolean;
  includeThinking: boolean;
  includeTimestamps: boolean;
  includeTokenUsage: boolean;
  imageHandling: 'skip' | 'placeholder' | 'inline';
}

export interface ExportRequest {
  sessionId: string;
  messageIds?: string[];
  options?: Partial<ExportOptions>;
}

export interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

const DEFAULT_OPTIONS: ExportOptions = {
  includeToolCalls: false,
  includeThinking: false,
  includeTimestamps: false,
  includeTokenUsage: false,
  imageHandling: 'placeholder',
};

/**
 * Sanitize a string for use as a filename.
 * Preserves unicode letters (Chinese, etc.) but removes dangerous chars.
 */
function sanitizeFilename(str: string): string {
  // Remove characters unsafe for filenames and control characters
  const unsafe = new Set('<>:"/\\|?*'.split(''));
  const cleaned = Array.from(str)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (code <= 0x1f) return false; // control characters
      if (unsafe.has(ch)) return false;
      return true;
    })
    .join('');
  return cleaned.trim().replace(/\s+/g, '-').slice(0, 100);
}

/**
 * Format file size for display.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Serialize an array of messages into a markdown string.
 */
export function serializeMessagesToMarkdown(
  messages: Message[],
  session: Session,
  options: ExportOptions
): string {
  const lines: string[] = [];

  // --- Document header ---
  lines.push(`# ${session.title || 'Untitled Chat'}`);
  lines.push('');
  lines.push(`**Exported:** ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`);
  if (session.model) {
    lines.push(`**Model:** ${session.model}`);
  }
  lines.push(`**Messages:** ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Messages ---
  for (const msg of messages) {
    // Skip system messages
    if (msg.role === 'system') continue;

    // Content blocks
    const contentBlocks = Array.isArray(msg.content) ? msg.content : [];

    // Check if this message will produce any visible output with current options.
    // Skip empty assistant messages (e.g., tool-only turns when includeToolCalls is off).
    const hasVisibleContent = contentBlocks.some((block) => {
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
    });

    if (!hasVisibleContent) continue;

    // Role header
    const roleHeader = msg.role === 'user' ? '👤 **USER:**' : '## 🤖 Assistant';
    lines.push(roleHeader);

    if (options.includeTimestamps && msg.timestamp) {
      lines.push(`*${new Date(msg.timestamp).toLocaleString()}*`);
    }
    lines.push('');

    // For user messages, wrap content in blockquote for visual distinction
    const linePrefix = msg.role === 'user' ? '> ' : '';

    for (const block of contentBlocks) {
      switch (block.type) {
        case 'text': {
          const text = (block as TextContent).text;
          if (linePrefix) {
            // Wrap each line in blockquote for user messages
            const quoted = text
              .split('\n')
              .map((l) => `${linePrefix}${l}`)
              .join('\n');
            lines.push(quoted);
          } else {
            lines.push(text);
          }
          lines.push('');
          break;
        }

        case 'thinking':
          if (options.includeThinking) {
            lines.push('<details>');
            lines.push('<summary>💭 Thinking</summary>');
            lines.push('');
            lines.push((block as ThinkingContent).thinking);
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
          break;

        case 'tool_use':
          if (options.includeToolCalls) {
            const toolBlock = block as ToolUseContent;
            lines.push('<details>');
            lines.push(`<summary>🔧 Tool: ${toolBlock.name}</summary>`);
            lines.push('');
            lines.push('```json');
            try {
              lines.push(JSON.stringify(toolBlock.input, null, 2));
            } catch {
              lines.push('{}');
            }
            lines.push('```');
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
          break;

        case 'tool_result':
          if (options.includeToolCalls) {
            const resultBlock = block as ToolResultContent;
            const prefix = resultBlock.isError ? '⚠️ **Error:**' : '**Result:**';
            const raw =
              typeof resultBlock.content === 'string'
                ? resultBlock.content
                : resultBlock.content != null
                  ? String(resultBlock.content)
                  : '';
            if (raw) {
              lines.push(`${prefix}`);
              lines.push('```');
              lines.push(raw.slice(0, 500) + (raw.length > 500 ? '...' : ''));
              lines.push('```');
              lines.push('');
            }
          }
          break;

        case 'image':
          if (options.imageHandling === 'placeholder') {
            lines.push(`${linePrefix}*[Image was attached]*`);
            lines.push('');
          } else if (options.imageHandling === 'inline') {
            const imgBlock = block as ImageContent;
            lines.push(
              `${linePrefix}![Image](data:${imgBlock.source.media_type};base64,${imgBlock.source.data})`
            );
            lines.push('');
          }
          // 'skip' = do nothing
          break;

        case 'file_attachment': {
          const fileBlock = block as FileAttachmentContent;
          lines.push(
            `${linePrefix}📎 **Attached:** \`${fileBlock.filename}\` (${formatSize(fileBlock.size)})`
          );
          lines.push('');
          break;
        }
      }
    }

    // Token usage
    if (options.includeTokenUsage && msg.tokenUsage) {
      lines.push(`*Tokens: ${msg.tokenUsage.input} in / ${msg.tokenUsage.output} out*`);
      lines.push('');
    }

    // Execution time
    if (options.includeTimestamps && msg.executionTimeMs) {
      lines.push(`*Execution time: ${(msg.executionTimeMs / 1000).toFixed(1)}s*`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export a chat session to a markdown file.
 * Shows a native save dialog and writes the file.
 */
export async function exportChatToMarkdown(
  request: ExportRequest,
  getSession: (sessionId: string) => Session | undefined,
  getMessages: (sessionId: string) => Message[]
): Promise<ExportResult> {
  try {
    // Fetch session
    const session = getSession(request.sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    // Fetch messages
    let messages = getMessages(request.sessionId);
    if (!messages || messages.length === 0) {
      return { success: false, error: 'No messages to export' };
    }

    // Filter by message IDs if specified
    if (request.messageIds && request.messageIds.length > 0) {
      const idSet = new Set(request.messageIds);
      messages = messages.filter((m) => idSet.has(m.id));
    }

    // Filter out partial/streaming messages and system messages
    messages = messages.filter((m) => !m.id.startsWith('partial-') && m.role !== 'system');

    // Guard: nothing exportable after filtering
    if (messages.length === 0) {
      return { success: false, error: 'No messages to export' };
    }

    // Merge options with defaults
    const options: ExportOptions = { ...DEFAULT_OPTIONS, ...request.options };

    // Serialize
    const markdown = serializeMessagesToMarkdown(messages, session, options);

    // Build default filename
    const titleSlug = sanitizeFilename(session.title || 'chat');
    const dateStr = new Date().toISOString().split('T')[0];
    const defaultFilename = `${titleSlug}-${dateStr}.md`;

    // Show save dialog — handle case where no window is focused
    const dialogOptions = {
      title: 'Export Chat as Markdown',
      defaultPath: defaultFilename,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };
    const mainWindow = BrowserWindow.getFocusedWindow();
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    // Write file asynchronously to avoid blocking the event loop
    await fs.promises.writeFile(result.filePath, markdown, 'utf-8');
    log('[ChatExport] Exported chat to:', result.filePath);

    return { success: true, path: result.filePath };
  } catch (error) {
    logError('[ChatExport] Export failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
