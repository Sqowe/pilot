# Chat Export to Markdown — Design & Implementation Plan

**Created:** 2026-05-23
**Status:** Draft
**Author:** AI-assisted brainstorm session

---

## 1. Overview

Add the ability to export chat conversations as markdown files. Users can export
an entire session or cherry-pick specific messages. The feature targets users who
want to save conversations for knowledge bases (Obsidian, Notion, Gitbook), share
with colleagues, or archive important interactions.

### Goals

- Export full conversation as a single `.md` file with one click
- Selectively export chosen messages (V2)
- Configurable content inclusion (tool calls, thinking, timestamps) (V2/V3)
- Handle images and file attachments gracefully
- Follow existing IPC + dialog patterns (same as `logs.export`)

### Non-Goals (for now)

- JSON/machine-readable export
- PDF export
- Real-time sync to external tools
- Batch export of multiple sessions in one action

---

## 2. UX Research Summary

### Industry Patterns

| App/Tool                         | Export Modes                                                                | Selection UX           |
| -------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| **Msty**                         | Full branch as Markdown, Cherry-pick individual messages, Full tree as JSON | Checkboxes on messages |
| **ChatGPT Exporter** (extension) | PDF, Markdown, Text, JSON, CSV                                              | Full conversation only |
| **OpenAI built-in**              | Full data export (JSON, 7-day wait)                                         | No selection           |
| **Obsidian ChatGPT plugin**      | Markdown with metadata frontmatter                                          | Full conversation      |
| **Cursor**                       | `@` mentions for context                                                    | No export feature      |

### Key Insight

Users overwhelmingly want **selective export** — "only the useful parts" — because
full conversations contain noise (tool calls, errors, retries, thinking blocks).
The MVP should still export everything meaningful (text + code), with selective
export as a fast follow.

---

## 3. UI Placement & Interaction Design

### 3.1 Entry Points

#### A. Chat Header — Primary action (MVP)

The header uses a 3-column grid: `[brand label] [session title] [connector badge]`.
Add a download button to the left column area (replacing or alongside the brand label):

```
┌─────────────────────────────────────────────────────────────┐
│  📥 Sqowe Pilot  │     Session Title      │  🔌 3 connectors │
└─────────────────────────────────────────────────────────────┘
```

Or as a dropdown menu button (`⋮` or `Download` icon) with options:

- **Export full chat** → immediate save dialog
- **Export selected…** → enters selection mode (V2)

**Recommended for MVP:** Single `Download` icon button (lucide `Download`) in the
header left area. Click triggers full export with default options.

#### B. Sidebar — Session hover action (MVP)

Currently shows only a delete button (Trash2) on hover. Add a second icon:

```
┌──────────────────────────────────────────┐
│  Session Title                    📥  🗑  │
└──────────────────────────────────────────┘
```

The `📥` (Download icon) exports that session without needing to open it first.
Useful for exporting old conversations.

#### C. Selection Mode (V2)

Triggered by "Export selected…" from the header dropdown:

1. Floating toolbar at top of message area: `"Select messages to export" [Select All] [Cancel]`
2. Each message gets a checkbox (left margin for user, left margin for assistant)
3. Clicking a message toggles selection
4. Floating bottom bar: `"N messages selected" [Export] [Cancel]`
5. Selection works at **message level**, with "select entire turn" shortcut

**Interaction details:**

- Checkboxes fade in (same animation as sidebar select mode)
- Selected messages get `border-l-2 border-accent` highlight
- Floating bottom bar mirrors sidebar's batch-delete confirmation pattern
- `Escape` exits selection mode, `Ctrl/Cmd+A` selects all
- Streaming messages cannot be selected

### 3.2 Export Options Dialog (V2/V3)

Shown after clicking "Export" (either full or selected):

```
┌─────────────────────────────────────────┐
│  Export Chat                            │
│                                         │
│  Include:                               │
│  ☑ Text messages                        │
│  ☑ Code blocks                          │
│  ☐ Tool calls (collapsed)              │
│  ☐ Thinking/reasoning blocks           │
│  ☐ Timestamps                          │
│  ☐ Token usage                         │
│  ☐ Images (as file references)         │
│                                         │
│  [Cancel]              [Save as .md]    │
└─────────────────────────────────────────┘
```

**MVP skips this dialog** — uses sensible defaults (text + code, no tool calls,
no thinking blocks).

---

## 4. Markdown Serialization Logic

### 4.1 Content Block Mapping

Each `ContentBlock` type serializes differently:

#### TextContent

Direct passthrough — LLM output is already markdown-compatible:

```typescript
(block: TextContent) => block.text;
```

#### ThinkingContent (optional, off by default)

```markdown
<details>
<summary>💭 Thinking</summary>

{thinking text}

</details>
```

#### ToolUseContent + ToolResultContent (optional, off by default)

Paired tool call + result as collapsed details:

````markdown
<details>
<summary>🔧 Tool: {tool_name}</summary>

**Input:**

```json
{JSON.stringify(input, null, 2)}
```
````

**Output:**
{tool_result.content (truncated to 500 chars)}

</details>
```

#### ImageContent

Default (MVP): placeholder text

```markdown
_[Image was attached]_
```

V2 folder export: relative path reference

```markdown
![Image](./images/img-001.png)
```

#### FileAttachmentContent

```markdown
📎 **Attached:** `{filename}` ({formatted size})
```

### 4.2 Document Structure

```markdown
# {session_title}

**Exported:** {YYYY-MM-DD HH:mm}
**Model:** {model_name}
**Messages:** {count}

---

## 👤 User

{user message content blocks}

---

## 🤖 Assistant

{assistant message content blocks}

---

## 👤 User

{next user message}

---
```

### 4.3 Serialization Interface

```typescript
interface ExportOptions {
  includeToolCalls: boolean; // default: false
  includeThinking: boolean; // default: false
  includeTimestamps: boolean; // default: false
  includeTokenUsage: boolean; // default: false
  imageHandling: 'skip' | 'placeholder' | 'inline' | 'files'; // default: 'placeholder'
}

interface ExportRequest {
  sessionId: string;
  messageIds?: string[]; // undefined = all messages
  options: ExportOptions;
}

interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
}
```

### 4.4 Serialization Function (Core Logic)

````typescript
function serializeMessagesToMarkdown(
  messages: Message[],
  session: Session,
  options: ExportOptions
): string {
  const lines: string[] = [];

  // --- Header ---
  lines.push(`# ${session.title || 'Untitled Chat'}`);
  lines.push('');
  lines.push(`**Exported:** ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`);
  if (session.model) lines.push(`**Model:** ${session.model}`);
  lines.push(`**Messages:** ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Messages ---
  for (const msg of messages) {
    if (msg.role === 'system') continue; // skip system messages

    const roleHeader = msg.role === 'user' ? '## 👤 User' : '## 🤖 Assistant';
    lines.push(roleHeader);

    if (options.includeTimestamps && msg.timestamp) {
      lines.push(`*${new Date(msg.timestamp).toLocaleString()}*`);
    }
    lines.push('');

    const contentBlocks = Array.isArray(msg.content) ? msg.content : [];

    for (const block of contentBlocks) {
      switch (block.type) {
        case 'text':
          lines.push(block.text);
          lines.push('');
          break;

        case 'thinking':
          if (options.includeThinking) {
            lines.push('<details>');
            lines.push('<summary>💭 Thinking</summary>');
            lines.push('');
            lines.push(block.thinking);
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
          break;

        case 'tool_use':
          if (options.includeToolCalls) {
            lines.push('<details>');
            lines.push(`<summary>🔧 Tool: ${block.name}</summary>`);
            lines.push('');
            lines.push('```json');
            lines.push(JSON.stringify(block.input, null, 2));
            lines.push('```');
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
          break;

        case 'tool_result':
          if (options.includeToolCalls) {
            const prefix = block.isError ? '⚠️ **Error:**' : '**Result:**';
            const content =
              typeof block.content === 'string'
                ? block.content.slice(0, 500)
                : JSON.stringify(block.content).slice(0, 500);
            lines.push(`${prefix} ${content}`);
            lines.push('');
          }
          break;

        case 'image':
          if (options.imageHandling === 'placeholder') {
            lines.push('*[Image was attached]*');
            lines.push('');
          } else if (options.imageHandling === 'inline') {
            lines.push(`![Image](data:${block.source.media_type};base64,${block.source.data})`);
            lines.push('');
          }
          // 'skip' and 'files' handled elsewhere
          break;

        case 'file_attachment':
          const sizeStr =
            block.size > 1024 ? `${(block.size / 1024).toFixed(1)} KB` : `${block.size} bytes`;
          lines.push(`📎 **Attached:** \`${block.filename}\` (${sizeStr})`);
          lines.push('');
          break;
      }
    }

    if (options.includeTokenUsage && msg.tokenUsage) {
      lines.push(`*Tokens: ${msg.tokenUsage.input} in / ${msg.tokenUsage.output} out*`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
````

---

## 5. Image & Attachment Handling

### Strategy Comparison

| Strategy                                 | File Size  | Compatibility              | Fidelity                     | Complexity |
| ---------------------------------------- | ---------- | -------------------------- | ---------------------------- | ---------- |
| **Skip**                                 | Smallest   | Universal                  | None                         | Trivial    |
| **Placeholder** `*[Image was attached]*` | Small      | Universal                  | Low (acknowledges existence) | Trivial    |
| **Inline base64** `![](data:...)`        | Very large | Poor (many renderers fail) | Full                         | Low        |
| **Folder export** with separate files    | Medium     | Excellent                  | Full                         | Medium     |

### Recommended Approach

**MVP:** Placeholder text. Simple, clean, universal.

**V2 — Folder export:**
When conversation contains images, offer "Export as folder":

```
exports/
└── {session-title}-{date}/
    ├── chat.md              (references ./images/img-001.png)
    └── images/
        ├── img-001.png
        ├── img-002.png
        └── ...
```

Implementation:

1. Show directory picker (`dialog.showOpenDialog` with `properties: ['openDirectory', 'createDirectory']`)
2. Create subfolder with session title + date
3. Decode base64 images → write as PNG/JPEG files
4. Generate markdown with relative `./images/` paths
5. Write `chat.md`

---

## 6. Architecture & Implementation

### 6.1 Component Diagram

```
Renderer                          Main Process
────────                          ────────────

[ChatView]                        [ipcMain handler]
  │ click export                    │
  ▼                                 │
[window.electronAPI                 │
  .chat.exportMarkdown({           │
    sessionId,                      │
    messageIds?,                    │
    options                         │
  })]                               │
  │                                 ▼
  │ ──── IPC ────────────────►  [chat.exportMarkdown]
  │                                 │
  │                                 ├─ fetch messages from SQLite
  │                                 ├─ serialize to markdown
  │                                 ├─ show save dialog
  │                                 ├─ write file
  │                                 │
  │ ◄─── IPC result ───────────  { success, path }
  ▼
[show toast notification]
```

### 6.2 Files to Create/Modify

| File                                   | Action     | Description                                          |
| -------------------------------------- | ---------- | ---------------------------------------------------- |
| `src/main/chat/export-markdown.ts`     | **Create** | Serialization logic + file writing                   |
| `src/main/index.ts`                    | Modify     | Add `ipcMain.handle('chat.exportMarkdown', ...)`     |
| `src/preload/index.ts`                 | Modify     | Expose `chat.exportMarkdown` on `window.electronAPI` |
| `src/renderer/components/ChatView.tsx` | Modify     | Add export button to header                          |
| `src/renderer/components/Sidebar.tsx`  | Modify     | Add export icon to session hover                     |
| `src/renderer/i18n/locales/en.json`    | Modify     | Add export-related strings                           |
| `src/renderer/i18n/locales/zh.json`    | Modify     | Add export-related strings (Chinese)                 |

### 6.3 IPC Contract

```typescript
// Preload exposure
chat: {
  exportMarkdown: (request: {
    sessionId: string;
    messageIds?: string[];
    options?: Partial<ExportOptions>;
  }) => Promise<{ success: boolean; path?: string; error?: string }>;
}

// Main process handler
ipcMain.handle('chat.exportMarkdown', async (_event, request) => {
  // 1. Validate sessionId
  // 2. Fetch messages (all or filtered by messageIds)
  // 3. Fetch session metadata (title, model)
  // 4. Serialize to markdown
  // 5. Show save dialog with default filename: {title}-{date}.md
  // 6. Write file
  // 7. Return result
});
```

### 6.4 Default Filename

```typescript
const sanitize = (str: string) =>
  str
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
const defaultName = `${sanitize(session.title || 'chat')}-${new Date().toISOString().split('T')[0]}.md`;
```

---

## 7. Implementation Phases

### Phase 1 — MVP (Full Export) ✅ DONE

**Scope:** One-click full session export as `.md` file.

**Tasks:**

1. ✅ Create `src/main/chat/export-markdown.ts` with serialization function
2. ✅ Add IPC handler in `src/main/index.ts`
3. ✅ Expose in preload
4. ✅ Add `Download` button to ChatView header (left of title)
5. ✅ Add `Download` icon to Sidebar session hover (left of delete)
6. ✅ Add i18n strings (en + zh)
7. ✅ Default options: text + code only, images as placeholders, no tool calls/thinking

**Completed:** 2026-05-23
**Effort:** ~2-3 hours
**Dependencies:** None

### Phase 2 — Selective Export

**Scope:** Cherry-pick messages with checkboxes, export options dialog.

**Tasks:**

1. Add selection mode state to ChatView (or a new `useExportSelection` hook)
2. Create `ExportSelectionBar` component (top toolbar + bottom action bar)
3. Modify `MessageCard` to accept `selectable` + `selected` props, render checkbox
4. Create `ExportOptionsDialog` component
5. Pass selected message IDs to the IPC handler
6. Add "Export selected…" option to header dropdown

**Effort:** ~4-6 hours
**Dependencies:** Phase 1

### Phase 3 — Rich Export

**Scope:** Folder export with images, configurable content, batch export.

**Tasks:**

1. Implement folder export mode (directory picker + image extraction)
2. Add all export options (tool calls, thinking, timestamps, token usage)
3. Persist user's last-used export options in electron-store
4. Add batch export from sidebar (select multiple sessions → export all)
5. Add keyboard shortcut (`Cmd+Shift+E` for export)

**Effort:** ~3-4 hours
**Dependencies:** Phase 2

---

## 8. Edge Cases & Considerations

### Empty Sessions

- If session has no messages, show a toast "Nothing to export" instead of opening save dialog

### Streaming Messages

- Don't include partial/streaming messages in export (filter out `id.startsWith('partial-')`)
- Disable export button while session is actively streaming (or export only completed messages)

### Very Long Conversations

- No hard limit on export size — markdown is lightweight
- For conversations with 100+ messages, the file may be large but still manageable
- Consider adding a progress indicator for folder export with many images

### Unicode & Special Characters

- Session titles may contain Chinese characters, emoji, special chars
- Sanitize for filename but preserve in document header
- Use UTF-8 encoding for the markdown file

### Tool Result Truncation

- Tool results can be very long (file contents, search results)
- Default: truncate to 500 characters with `...` suffix
- V2 option: "Include full tool results" (off by default)

### Concurrent Exports

- Allow multiple exports simultaneously (each gets its own save dialog)
- No locking needed — reads are non-destructive

---

## 9. Testing Strategy

### Unit Tests (Vitest)

- `serializeMessagesToMarkdown()` with various content block combinations
- Empty messages, single message, mixed roles
- All options combinations (tool calls on/off, thinking on/off, etc.)
- Filename sanitization
- Image placeholder generation
- Tool result truncation

### Manual Testing

- Export a conversation with code blocks → verify markdown renders correctly
- Export with images → verify placeholders appear
- Export from sidebar (session not currently open)
- Export during streaming → verify partial messages excluded
- Export empty session → verify toast notification
- Verify Chinese characters in title/content
- Open exported file in VS Code, Obsidian, GitHub → verify rendering

---

## 10. Future Considerations

- **Auto-export hook:** A hook that automatically exports conversations on `agentStop`
  to `docs/chats/` (replacing the current manual process)
- **Template system:** User-defined markdown templates for export format
- **Clipboard export:** "Copy as markdown" without file save dialog
- **Share link:** Generate a shareable HTML page from the markdown
- **Diff export:** Export only messages since last export (incremental)
