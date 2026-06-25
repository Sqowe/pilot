# Chat Export — Multi-Format (DOCX + PDF) Design & Implementation Plan

**Created:** 2026-06-20
**Status:** Draft
**Author:** AI-assisted design session
**Builds on:** [`chat-export-markdown.md`](./chat-export-markdown.md) (shipped — Markdown export, Phases 1–2)

---

## 1. Overview

Extend the existing chat-export feature so a conversation can be saved as **Word
(`.docx`)** and **PDF (`.pdf`)** in addition to the current **Markdown (`.md`)**.

The driving constraint from design review: **format must be a _parameter_ of the
export, not a separate menu action.** Treating each format as its own menu entry
causes a `scope × format` blow-up (2 → 4 → 6 menu items as formats are added). With
format-as-parameter, the dropdown stays at its current two scope actions ("Export
all" / "Export selected…") **no matter how many formats exist**, and adding a future
format (e.g. HTML, JSON) is purely additive.

### Goals

- Export full or selected conversation as `.docx` or `.pdf`, reusing all existing
  scope/selection/options scaffolding.
- **Zero new menu items** — format chosen via the native save dialog's "Save as
  type" filter (Option A from review).
- One shared HTML serializer feeding **both** DOCX and PDF for consistent output.
- Keep the shipped Markdown path byte-for-byte unchanged.
- Pure-JS dependencies only — no native modules, no Electron ABI rebuild, no
  bundled Chromium download.

### Non-Goals (for now)

- JSON/machine-readable export
- Folder/zip export with extracted image files (tracked in the markdown doc's Phase 3)
- Batch export of multiple sessions in one action
- Pixel-perfect Word fidelity (see §6.1 tradeoff)
- Reusing the renderer's live `react-markdown` DOM for export (see §11)

---

## 2. Why Not the Built-in `docx` / `pdf` Skills

The bundled [`.claude/skills/docx`](../../.claude/skills/docx/SKILL.md) and `pdf`
skills are **agent-facing instruction sets** — they tell the LLM how to hand-author
a bespoke document script and validate it with `uv` / `pandoc` / LibreOffice. That
mechanism is interactive, non-deterministic, slow (seconds–minutes, requires an LLM
turn), and cannot be driven reliably from a toolbar button.

Chat export is the opposite: a **deterministic, instant, one-click IPC call** with no
LLM in the loop. So we do **not** invoke the skills. We do, however, reuse the
_library_ the docx skill relies on under the hood (`docx-js`) as a fallback option
(see §6.1), and the idiomatic Electron API for PDF (`webContents.printToPDF`).

---

## 3. Architecture — Format as a Parameter

### 3.1 Single dialog, dispatch on chosen extension

The current handler already shows a native save dialog with a `filters` array
([`export-markdown.ts`](../../src/main/chat/export-markdown.ts) ~L383). That array
**is** the OS-native format picker ("Save as type:"). We widen it to list all
formats and dispatch on the extension of the path the user picked.

```
                          ┌──────────────────────────────┐
chat.export(scope,opts) → │ ONE native save dialog        │
                          │ filters: .md / .docx / .pdf   │
                          └───────────────┬───────────────┘
                       extname(filePath)  │ dispatch
            ┌──────────────────┬──────────┴────────────┬──────────────────┐
            ▼                  ▼                         ▼
          .md                .docx                     .pdf
   serializeMarkdown    serializeHtml ─┐          serializeHtml ─┐
   (exists, string)                    ▼                         ▼
                          @turbodocx/html-to-docx      offscreen BrowserWindow
                                → .docx buffer            → printToPDF → .pdf buffer
```

### 3.2 The reuse insight: one HTML core for DOCX **and** PDF

PDF generation needs HTML (to feed `printToPDF`). DOCX can be produced from that
**same** HTML via an HTML→docx converter. So instead of three bespoke emitters, we
build **one** `serializeMessagesToHtml()` and fan out. The Markdown serializer is
left untouched because Markdown is its own target.

The existing message-walking + `ExportOptions` block-inclusion logic is extracted
once into a shared helper so all serializers apply identical include/exclude rules.

---

## 4. Serialization

### 4.1 Shared core (`export-common.ts`)

Extract from the current `export-markdown.ts`, unchanged in behavior:

- The `ExportOptions` interface + `DEFAULT_OPTIONS`
- `ExportRequest` / `ExportResult` types
- `sanitizeFilename()`, `formatSize()`
- The per-message "does this block produce visible output under these options?"
  filtering predicate
- The partial/streaming/system message filtering

### 4.2 HTML serializer (`export-html.ts`) — new, shared by DOCX + PDF

`serializeMessagesToHtml(messages, session, options): string`

- Mirrors `serializeMessagesToMarkdown()` block-for-block, emitting semantic HTML.
- **Markdown inside text blocks is rendered to HTML via `marked`** (so `**bold**`,
  code fences, lists, and headings render properly instead of appearing as literal
  syntax — this is the key fidelity gain over a naive plain-text DOCX emitter).
- **All non-text, model-or-tool-derived strings are HTML-escaped** before insertion
  (see §7 — content is untrusted).
- Ships with an embedded print stylesheet: readable body font, shaded monospace code
  blocks, page-friendly margins, user vs. assistant visual distinction.
- Image handling mirrors the MD options (`skip` / `placeholder` / `inline`).

### 4.3 DOCX (`export-docx.ts`)

`serializeMessagesToHtml(...)` → `@turbodocx/html-to-docx` → `Buffer` → write.

### 4.4 PDF (`export-pdf.ts`)

`serializeMessagesToHtml(...)` → offscreen `BrowserWindow` → `printToPDF` →
`Buffer` → write. See §7 for the locked-down window configuration.

---

## 5. Dependencies

| Package                   | Purpose                    | License | Native? | Notes                                                            |
| ------------------------- | -------------------------- | ------- | ------- | ---------------------------------------------------------------- |
| `marked`                  | Markdown text-block → HTML | MIT     | No      | Tiny, zero-dep, synchronous                                      |
| `@turbodocx/html-to-docx` | HTML → `.docx` buffer      | MIT     | No      | Actively maintained successor of `html-to-docx`                  |
| _(PDF)_                   | `webContents.printToPDF`   | —       | No      | **Built into Electron** — no dependency, reuses bundled Chromium |

All additions are pure JS — no `better-sqlite3`-style ABI rebuild, no Chromium
download. No bundling/packaging changes expected beyond the two `npm install`s.

> Fallback: if maximum native-Word fidelity is later required, swap `export-docx.ts`
> to use `docx-js` (`docx`, MIT, the same library the bundled docx skill uses) and
> map blocks directly — **without touching the router, HTML core, or PDF path**.

---

## 6. Fidelity Tradeoff

### 6.1 HTML→DOCX vs. docx-js direct

`@turbodocx/html-to-docx` fidelity is good for chat content (headings, bold/italic,
code blocks, lists, tables, images) but is **not pixel-perfect** on exotic HTML. We
accept this for v1 because:

- It maximizes reuse (one HTML core for DOCX + PDF).
- Chat content is structurally simple.
- The emitter is swappable (see §5 fallback) with no ripple effect.

PDF fidelity is **excellent** — it renders in Electron's real Chromium engine, so the
print stylesheet fully applies.

---

## 7. Security — Untrusted Content & the Offscreen PDF Window

### 7.1 Why chat content is treated as untrusted

A chat's content is assembled from user messages, LLM output, and **tool results** —
bash output, file contents, MCP responses, and especially **web-scraped pages**
(Firecrawl). Any of these can contain hostile markup, e.g.:

```html
<img src="x" onerror="require('child_process').exec('…')" />
```

A malicious page the agent scraped could plant that, and a prompt-injected model
could echo it back. So when we turn chat content into HTML we **must** assume it may
contain executable markup.

### 7.2 The risk is isolated to the PDF path

Of the three formats, only PDF renders in a browser engine: `printToPDF` loads the
HTML into a Chromium renderer. **If that renderer had Node access, injected
`<script>`/`onerror` would execute with full OS privileges (RCE).** The Markdown and
DOCX paths are pure string/buffer transforms — they never spin up a renderer, so
embedded script is inert text there.

### 7.3 ⚠️ Terminology: "sandbox" here is **not** the app's execution sandbox

> **Read this before touching the PDF window.** The word "sandbox" in this section
> refers to **Electron's `webPreferences.sandbox`** — a built-in Chromium
> renderer-process flag that ships with Electron and is set per-`BrowserWindow`. It
> is **completely unrelated** to Open Cowork's own **Sandbox feature**
> (`src/main/sandbox/`, the WSL2/Lima/Native execution adapters), which is
> ⚠️ Experimental and **not enabled yet** (`sandboxEnabled: false`, UI-gated — see
> [ARCHITECTURE.md](../../ARCHITECTURE.md) §4.4).
>
> The PDF export window depends **only** on the Electron renderer flag, which has
> nothing to do with where agent tool/bash execution runs. The two are independent;
> do not assume this feature waits on the WSL/Lima sandbox.

This is not a new capability we implement — the Electron renderer sandbox is already
in use today on the main window ([`src/main/index.ts`](../../src/main/index.ts)
~L511–515: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`). The
PDF window simply mirrors that proven configuration.

### 7.4 Locked-down offscreen window

Because the print render is **static**, the window needs no JavaScript at all —
disabling JS is the strongest single mitigation:

```js
const win = new BrowserWindow({
  show: false, // offscreen; never displayed (UX, not security)
  webPreferences: {
    javascript: false, // strongest mitigation: injected <script>/onerror never runs
    sandbox: true, // Electron renderer sandbox (NOT the app's exec sandbox — see §7.3)
    nodeIntegration: false, // no require()/Node APIs reachable from the page
    contextIsolation: true, // page JS can't reach privileged contexts
  },
});
try {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); // local only, never remote
  const pdf = await win.webContents.printToPDF({ printBackground: true });
  await fs.promises.writeFile(filePath, pdf);
} finally {
  win.destroy(); // always tear down the hidden window/process
}
```

Defense in depth: `javascript: false` neutralizes script execution outright; the
sandbox/`nodeIntegration`/`contextIsolation` flags confine anything that somehow
runs; loading local content only prevents network-driven navigation; and text is
HTML-escaped at serialization time (§4.2) so markup renders as literal characters.

---

## 8. Files to Create / Modify

| File                                           | Action     | Description                                                                                           |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `src/main/chat/export-common.ts`               | **Create** | Shared `ExportOptions`, defaults, filtering, `sanitizeFilename`, `formatSize`                         |
| `src/main/chat/export-html.ts`                 | **Create** | `serializeMessagesToHtml()` + print stylesheet (shared by DOCX & PDF)                                 |
| `src/main/chat/export-docx.ts`                 | **Create** | HTML → `@turbodocx/html-to-docx` → buffer                                                             |
| `src/main/chat/export-pdf.ts`                  | **Create** | HTML → locked-down offscreen window → `printToPDF` → buffer                                           |
| `src/main/chat/export-markdown.ts`             | Modify     | Keep `serializeMessagesToMarkdown()`; import shared bits from `export-common.ts`                      |
| `src/main/index.ts`                            | Modify     | Generalize `chat.exportMarkdown` → `chat.export`; one multi-filter dialog; dispatch on `path.extname` |
| `src/preload/index.ts`                         | Modify     | Expose `chat.export`; keep `chat.exportMarkdown` as a thin alias                                      |
| `src/renderer/components/ChatView.tsx`         | Modify     | Point existing handlers at `chat.export`; **no new menu items**; relabel action to "Export chat…"     |
| `src/renderer/i18n/locales/{en,zh,ru,hu}.json` | Modify     | Relabel `exportMarkdown` → generic `exportChat`; drop format-specific wording                         |
| `src/tests/…`                                  | **Create** | Unit tests for `serializeMessagesToHtml` + extension→format dispatch                                  |
| `package.json`                                 | Modify     | Add `marked`, `@turbodocx/html-to-docx`                                                               |

All touched areas are ✅ Stable zones (renderer UI, IPC bridge, isolated new main
modules) per ARCHITECTURE.md §7 — low architectural risk.

---

## 9. IPC Contract

```typescript
// Preload exposure (chat.exportMarkdown kept as a thin alias → chat.export with .md)
chat: {
  export: (request: {
    sessionId: string;
    messageIds?: string[];          // undefined = all messages
    options?: Partial<ExportOptions>;
  }) => Promise<{ success: boolean; path?: string; error?: string }>;
}

// Main process handler
ipcMain.handle('chat.export', async (_event, request) => {
  // 1. Validate sessionId; fetch session + messages (all or filtered)
  // 2. Apply shared filtering (partial/system/empty)
  // 3. Show ONE save dialog: filters [Markdown .md, Word .docx, PDF .pdf]
  // 4. Dispatch on path.extname(result.filePath):
  //      .md   → serializeMessagesToMarkdown → write utf-8 string
  //      .docx → serializeMessagesToHtml → html-to-docx → write buffer
  //      .pdf  → serializeMessagesToHtml → printToPDF (locked-down window) → write buffer
  // 5. Return { success, path }
});
```

The renderer calls a single method; format selection happens entirely in the dialog.
The dropdown menu and selection-mode flow are unchanged except for relabeling.

---

## 10. Implementation Phases

Both formats share the HTML core, so it's built once and DOCX lands with it; PDF is a
thin additive follow-up.

### Phase 1 — Shared core + format router + DOCX

1. Create `export-common.ts`; refactor `export-markdown.ts` to consume it (no behavior change).
2. Create `export-html.ts` (`serializeMessagesToHtml` + print stylesheet + `marked` + HTML escaping).
3. Create `export-docx.ts` (HTML → `@turbodocx/html-to-docx`).
4. Generalize the IPC handler to `chat.export` with the multi-filter dialog + extension dispatch; keep `chat.exportMarkdown` alias.
5. Update preload + ChatView wiring; relabel i18n to "Export chat…".
6. Unit tests for HTML serialization + dispatch.

**Dependencies:** `marked`, `@turbodocx/html-to-docx`.

### Phase 2 — PDF

1. Create `export-pdf.ts` (locked-down offscreen window per §7.4).
2. Add the `.pdf` filter line + the `.pdf` dispatch case.
3. Manual verification across platforms (headless `show:false`).

**Additive only** — no UI change, no new dependency.

### Future formats

A 4th format = one filter entry + one serializer + one dispatch case. The menu and
the rest of the pipeline are untouched — the format-as-parameter design holds.

---

## 11. Edge Cases & Considerations

- **Empty / nothing-after-filtering** — reuse existing "Nothing to export" toast;
  don't open the dialog.
- **Streaming/partial messages** — already filtered (`id.startsWith('partial-')`).
- **Unicode titles** — sanitize for filename, preserve in document body; UTF-8
  throughout; `printToPDF` and `html-to-docx` both handle UTF-8.
- **Large conversations** — DOCX/PDF are heavier than MD; `printToPDF` handles long
  pages but very large chats may take a moment — acceptable for an explicit export.
- **Concurrent exports** — each PDF export creates and destroys its own offscreen
  window; no shared state, no locking needed.
- **Offscreen window lifecycle** — always `destroy()` in `finally`; never leak.
- **macOS save panel** — the "Save as type" popup is slightly subtle (near the
  filename field); acceptable per review (Option A chosen over an in-app toggle).

---

## 12. Testing Strategy

### Unit (Vitest)

- `serializeMessagesToHtml()` across all block types and option combinations.
- HTML escaping: a message containing `<script>` / `onerror=` renders as **literal
  text**, not structure.
- Extension→format dispatch (`.md` / `.docx` / `.pdf` / unknown).
- Shared filtering parity with the markdown path.

### Manual

- Export full + selected as DOCX → open in Word/LibreOffice/Google Docs; verify
  headings, code blocks, lists, tables, images.
- Export as PDF → verify layout, code-block shading, page breaks.
- Export a chat containing scraped HTML / a fake `<img onerror=…>` → confirm it is
  inert in the PDF (no execution) and shows as text.
- Export during streaming → partial messages excluded.
- Unicode (Chinese/emoji) in title and body.
- Confirm the existing `.md` export is byte-identical to pre-refactor output.

---

## 13. Open Questions

1. **Doc-then-code** confirmed (this document).
2. **Dependencies** — confirm `marked` + `@turbodocx/html-to-docx` are acceptable
   additions (both MIT, pure JS).
3. **Sidebar export** — the sidebar session-hover export currently implies Markdown;
   should it also route through the multi-format dialog, or stay MD-only for the
   quick path? (Proposed: route through `chat.export` for consistency.)

---

## 14. Future Considerations

- **Renderer-DOM PDF** — for pixel-perfect parity with what the user sees in-app, a
  future PDF mode could render a dedicated print route that reuses the renderer's
  `react-markdown` + app CSS, then `printToPDF` that. More complex (needs a print
  route + theme/session plumbing); the §4.2 `marked`-based HTML is the simpler v1.
- **docx-js direct emitter** — swap in for maximum native-Word fidelity (§5 fallback).
- **Persist last-used format** — remember the user's preferred extension in
  electron-store and pre-select that filter.
- **HTML as a first-class export** — the shared HTML core makes a standalone `.html`
  export nearly free (one filter + write the string).
