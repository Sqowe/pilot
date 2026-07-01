/**
 * Chat Export — HTML Serializer
 *
 * Produces a self-contained HTML document from chat messages.
 * Shared by both the DOCX and PDF export paths.
 *
 * Security model:
 *   - All non-markdown content (tool names, filenames, JSON, tool results) is
 *     HTML-escaped before insertion — it never passes through a renderer.
 *   - Markdown text blocks are rendered via an isolated `Marked` instance
 *     (does NOT mutate the global `marked` singleton) with a hardened renderer
 *     that:
 *       1. Escapes raw HTML tokens instead of passing them through
 *          (blocks <script>, <img onerror=…>, etc.)
 *       2. Replaces all image tokens with a safe placeholder (prevents SSRF /
 *          network fetches in the DOCX path where html-to-docx/axios fetches
 *          referenced images, and in the PDF renderer)
 *       3. Strips hrefs from links (renders text only) to prevent external
 *          navigation and SSRF
 *       4. Restricts inline data-URI images to a safe raster MIME whitelist
 *          (blocks SVG and other script-capable types)
 *   - A restrictive CSP meta tag is embedded in every generated document as a
 *     defence-in-depth measure for consumers that render the HTML in a browser.
 */

import { type Token } from 'marked';
import {
  type Message,
  type Session,
  type ExportOptions,
  type TextContent,
  type ThinkingContent,
  type ToolUseContent,
  type ToolResultContent,
  type ImageContent,
  type FileAttachmentContent,
  formatSize,
  blockIsVisible,
} from './export-common';

// ---------------------------------------------------------------------------
// HTML escaping — used for all non-markdown content (tool names, filenames,
// tool result text, JSON, etc.) that must never be interpreted as markup.
// ---------------------------------------------------------------------------
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Isolated, hardened Marked instance for export use only.
//
// marked@15 is ESM-only. The Electron main process bundle is CJS, so a static
// import would crash at runtime. We use a dynamic import and cache the result
// so the overhead is paid only once per process lifetime.
//
// We create a new Marked instance (NOT mutating the global `marked` singleton)
// so this config cannot affect other main-process code that imports marked.
//
// Renderer overrides use the marked v15 token-object signature. Each method
// receives a token object; child inline tokens are re-parsed via
// `this.parser.parseInline(token.tokens)` to preserve inline formatting while
// keeping our security overrides in effect for nested content.
//
// Threats addressed:
//   1. Raw HTML passthrough — `html` token handler escapes instead of emitting.
//   2. External images — `image` token handler emits a text placeholder.
//   3. External links — `link` token handler renders text only (no href).
// ---------------------------------------------------------------------------
let _exportMarkedCache: import('marked').Marked | null = null;

async function getExportMarked(): Promise<import('marked').Marked> {
  if (_exportMarkedCache) return _exportMarkedCache;
  const { Marked } = await import('marked');
  _exportMarkedCache = new Marked({
    renderer: {
      // Raw HTML blocks and spans — escape as literal text, never pass through
      html(token: { text: string }): string {
        return escapeHtml(token.text);
      },

      // Images — replace with a safe text placeholder regardless of src
      image(token: { text?: string; title?: string | null }): string {
        const alt = escapeHtml(token.text || token.title || 'image');
        return `<span class="image-placeholder">[Image: ${alt}]</span>`;
      },

      // Links — render inline content only, drop href entirely
      link(token: { tokens?: Token[]; text?: string }): string {
        // Re-parse inline children so nested formatting (bold, code, etc.) is
        // preserved. The recursive call still uses our hardened renderer.
        const inner = token.tokens
          ? this.parser.parseInline(token.tokens)
          : escapeHtml(token.text ?? '');
        return `<span>${inner}</span>`;
      },
    },
  });
  return _exportMarkedCache;
}

// ---------------------------------------------------------------------------
// Print stylesheet — embedded in the <head> of every exported document.
// ---------------------------------------------------------------------------
const PRINT_STYLESHEET = `
  *, *::before, *::after { box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 860px;
    margin: 0 auto;
    padding: 32px 24px;
  }

  h1 { font-size: 22px; margin: 0 0 8px; color: #111; }
  h2 { font-size: 16px; margin: 24px 0 4px; color: #333; }
  h3, h4, h5, h6 { font-size: 14px; margin: 16px 0 4px; color: #444; }

  .doc-meta {
    font-size: 12px;
    color: #666;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 2px solid #e5e7eb;
  }
  .doc-meta span { margin-right: 16px; }

  .message { margin-bottom: 24px; }

  .message-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }

  .role-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .role-user   { background: #eff6ff; color: #1d4ed8; }
  .role-assistant { background: #f0fdf4; color: #15803d; }

  .timestamp {
    font-size: 11px;
    color: #9ca3af;
  }

  .message-body { margin: 0; }

  /* User messages: subtle left-border blockquote style */
  .message-user .message-body {
    border-left: 3px solid #bfdbfe;
    padding-left: 12px;
    color: #374151;
  }

  p { margin: 0 0 8px; }
  p:last-child { margin-bottom: 0; }

  pre {
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 12px 14px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
    margin: 8px 0;
  }
  code {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
    background: #f3f4f6;
    padding: 1px 4px;
    border-radius: 3px;
  }
  pre code { background: none; padding: 0; }

  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-left: 3px solid #d1d5db;
    color: #6b7280;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 8px 0;
    font-size: 13px;
  }
  th, td {
    border: 1px solid #e5e7eb;
    padding: 6px 10px;
    text-align: left;
  }
  th { background: #f9fafb; font-weight: 600; }

  ul, ol { margin: 4px 0 8px; padding-left: 20px; }
  li { margin-bottom: 2px; }

  .details-block {
    margin: 8px 0;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    overflow: hidden;
  }
  .details-summary {
    background: #f9fafb;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    color: #374151;
    cursor: default;
  }
  .details-body {
    padding: 10px 14px;
    font-size: 12px;
  }
  .details-body pre { margin: 0; }

  .tool-error { color: #b91c1c; }

  .file-attachment {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 4px 10px;
    margin: 4px 0;
  }

  .image-placeholder {
    font-size: 12px;
    color: #6b7280;
    font-style: italic;
  }

  .token-usage {
    font-size: 11px;
    color: #9ca3af;
    margin-top: 4px;
  }

  .message-divider {
    border: none;
    border-top: 1px solid #f3f4f6;
    margin: 20px 0;
  }

  @media print {
    body { padding: 0; }
    pre { white-space: pre-wrap; word-break: break-all; }
  }
`;

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize an array of messages into a self-contained HTML string.
 * All untrusted content (tool names, filenames, tool results, etc.) is
 * HTML-escaped. Markdown text blocks are rendered via `marked`.
 */
export async function serializeMessagesToHtml(
  messages: Message[],
  session: Session,
  options: ExportOptions
): Promise<string> {
  const parts: string[] = [];
  // Hoist the marked instance once — it's cached after first call so this is
  // just a microtask/promise resolution on subsequent exports.
  const exportMarked = await getExportMarked();

  // --- Document header ---
  const exportedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const titleEscaped = escapeHtml(session.title || 'Untitled Chat');
  const modelEscaped = session.model ? escapeHtml(session.model) : null;

  parts.push(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- CSP: block all external resource loads. data: images are allowed for
       inline imageHandling mode. No scripts, no external stylesheets, no
       network fetches. Defence-in-depth alongside the hardened marked renderer
       and the PDF window's javascript:false flag. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none';" />
  <title>${titleEscaped}</title>
  <style>${PRINT_STYLESHEET}</style>
</head>
<body>
  <h1>${titleEscaped}</h1>
  <div class="doc-meta">
    <span>Exported: ${escapeHtml(exportedAt)}</span>${modelEscaped ? `\n    <span>Model: ${modelEscaped}</span>` : ''}
    <span>Messages: ${messages.length}</span>
  </div>
`);

  // --- Messages ---
  for (const msg of messages) {
    if (msg.role === 'system') continue;

    const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
    const hasVisibleContent = contentBlocks.some((b) => blockIsVisible(b, options));
    if (!hasVisibleContent) continue;

    const isUser = msg.role === 'user';
    const roleLabel = isUser ? '👤 User' : '🤖 Assistant';
    const roleClass = isUser ? 'role-user' : 'role-assistant';
    const messageClass = isUser ? 'message message-user' : 'message message-assistant';

    parts.push(`  <div class="${messageClass}">\n`);
    parts.push(`    <div class="message-header">\n`);
    parts.push(`      <span class="role-badge ${roleClass}">${escapeHtml(roleLabel)}</span>\n`);

    if (options.includeTimestamps && msg.timestamp) {
      const ts = escapeHtml(new Date(msg.timestamp).toLocaleString());
      parts.push(`      <span class="timestamp">${ts}</span>\n`);
    }

    parts.push(`    </div>\n`);
    parts.push(`    <div class="message-body">\n`);

    for (const block of contentBlocks) {
      switch (block.type) {
        case 'text': {
          const text = (block as TextContent).text;
          // Use the isolated hardened Marked instance (hoisted above).
          const rendered = exportMarked.parse(text) as string;
          parts.push(`      <div class="text-block">${rendered}</div>\n`);
          break;
        }

        case 'thinking':
          if (options.includeThinking) {
            const thinkingText = (block as ThinkingContent).thinking;
            const renderedThinking = exportMarked.parse(thinkingText) as string;
            parts.push(`      <div class="details-block">\n`);
            parts.push(`        <div class="details-summary">💭 Thinking</div>\n`);
            parts.push(`        <div class="details-body">${renderedThinking}</div>\n`);
            parts.push(`      </div>\n`);
          }
          break;

        case 'tool_use':
          if (options.includeToolCalls) {
            const toolBlock = block as ToolUseContent;
            let inputJson = '{}';
            try {
              inputJson = JSON.stringify(toolBlock.input, null, 2);
            } catch {
              // leave as '{}'
            }
            parts.push(`      <div class="details-block">\n`);
            parts.push(
              `        <div class="details-summary">🔧 Tool: ${escapeHtml(toolBlock.name)}</div>\n`
            );
            parts.push(
              `        <div class="details-body"><pre><code>${escapeHtml(inputJson)}</code></pre></div>\n`
            );
            parts.push(`      </div>\n`);
          }
          break;

        case 'tool_result':
          if (options.includeToolCalls) {
            const resultBlock = block as ToolResultContent;
            const raw =
              typeof resultBlock.content === 'string'
                ? resultBlock.content
                : resultBlock.content != null
                  ? String(resultBlock.content)
                  : '';
            if (raw) {
              const errorClass = resultBlock.isError ? ' tool-error' : '';
              const label = resultBlock.isError ? '⚠️ Error' : 'Result';
              parts.push(`      <div class="details-block">\n`);
              parts.push(`        <div class="details-summary${errorClass}">${label}</div>\n`);
              // No truncation — full content for archival/debugging fidelity
              parts.push(
                `        <div class="details-body"><pre><code>${escapeHtml(raw)}</code></pre></div>\n`
              );
              parts.push(`      </div>\n`);
            }
          }
          break;

        case 'image': {
          if (options.imageHandling === 'placeholder') {
            parts.push(`      <p class="image-placeholder">[Image was attached]</p>\n`);
          } else if (options.imageHandling === 'inline') {
            const imgBlock = block as ImageContent;
            // Whitelist of safe raster MIME types for inline data-URI embedding.
            // SVG and other script-capable types are deliberately excluded — SVG
            // can contain scripts that execute in some consumers (browsers,
            // DOCX renderers) even when JS is disabled at the outer level.
            const SAFE_IMAGE_MIMES = new Set([
              'image/png',
              'image/jpeg',
              'image/jpg',
              'image/gif',
              'image/webp',
              'image/bmp',
            ]);
            const mime = imgBlock.source.media_type?.toLowerCase() ?? '';
            // Validate base64 data strictly — reject anything with quotes,
            // spaces, or non-base64 chars that could break out of the attribute.
            const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
            const isValidBase64 = BASE64_RE.test(imgBlock.source.data ?? '');
            if (SAFE_IMAGE_MIMES.has(mime) && isValidBase64) {
              parts.push(
                `      <img src="data:${escapeHtml(mime)};base64,${imgBlock.source.data}" alt="Attached image" style="max-width:100%;border-radius:6px;margin:4px 0;" />\n`
              );
            } else {
              // Unsupported or potentially unsafe MIME type — fall back to placeholder
              parts.push(`      <p class="image-placeholder">[Image was attached]</p>\n`);
            }
          }
          // 'skip' = do nothing
          break;
        }

        case 'file_attachment': {
          const fileBlock = block as FileAttachmentContent;
          parts.push(
            `      <div class="file-attachment">📎 ${escapeHtml(fileBlock.filename)} <span style="color:#9ca3af">(${escapeHtml(formatSize(fileBlock.size))})</span></div>\n`
          );
          break;
        }
      }
    }

    // Token usage
    if (options.includeTokenUsage && msg.tokenUsage) {
      parts.push(
        `      <p class="token-usage">Tokens: ${msg.tokenUsage.input} in / ${msg.tokenUsage.output} out</p>\n`
      );
    }

    // Execution time
    if (options.includeTimestamps && msg.executionTimeMs) {
      parts.push(
        `      <p class="token-usage">Execution time: ${(msg.executionTimeMs / 1000).toFixed(1)}s</p>\n`
      );
    }

    parts.push(`    </div>\n`); // .message-body
    parts.push(`  </div>\n`); // .message
    parts.push(`  <hr class="message-divider" />\n`);
  }

  parts.push(`</body>\n</html>\n`);
  return parts.join('');
}
