/**
 * Chat Export to Markdown
 *
 * Serializes chat messages into a well-formatted markdown document.
 * Handles all content block types: text, thinking, tool_use, tool_result,
 * image, and file_attachment.
 */

import {
  type Message,
  type Session,
  type ExportOptions,
  type ExportRequest,
  type ExportResult,
  type TextContent,
  type ThinkingContent,
  type ToolUseContent,
  type ToolResultContent,
  type ImageContent,
  type FileAttachmentContent,
  formatSize,
  blockIsVisible,
} from './export-common';

export type { ExportOptions, ExportRequest, ExportResult };

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
    const hasVisibleContent = contentBlocks.some((block) => blockIsVisible(block, options));

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
