# Chat Export — Multi-Format (DOCX + PDF) Design & Implementation Plan

**Created:** 2026-06-20
**Status:** ✅ Shipped (Phases 1 + 2 complete — 2026-07-01)
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
  scope/selection/options scaffolding. ✅
- **Zero new menu items** — format chosen via the native save dialog's "Save as
  type" filter (Option A from review). ✅
- One shared HTML serializer feeding **both** DOCX and PDF for consistent output. ✅
- Keep the shipped Markdown path byte-for-byte unchanged. ✅
- Pure-JS dependencies only — no native modules, no Electron ABI rebuild, no
  bundled Chromium download. ✅

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

The save dialog lists all supported formats. The chosen extension (or the `format`
field in `ExportRequest` when the UI knows the intended format) drives dispatch.

```
                          ┌──────────────────────────────┐
chat.export(scope,opts) → │ ONE native save dialog        │
                          │ filters: .md / .docx / .pdf   │
                          │ (preferred format pre-selected)│
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

**Extension normalisation** (shipped): if the user types a bare filename with no
extension, the router appends the extension from `request.format` (default `'md'`).
This prevents a PDF-intent export from silently becoming Markdown.

### 3.2 The reuse insight: one HTML core for DOCX **and** PDF

PDF generation needs HTML (to feed `printToPDF`). DOCX can be produced from that
**same** HTML via an HTML→docx converter. So instead of three bespoke emitters, we
build **one** `serializeMessagesToHtml()` and fan out. The Markdown serializer is
left untouched because Markdown is its own target.

The existing message-walking + `ExportOptions` block-inclusion logic is extracted
once into a shared helper so all serializers apply identical include/exclude rules.

---

## 4. Serialization

### 4.1 Shared core (`export-common.ts`) ✅

Extracted from `export-markdown.ts`, unchanged in behavior. Ships:

- `ExportOptions` interface + `DEFAULT_OPTIONS`
- `ExportFormat` type (`'md' | 'docx' | 'pdf'`)
- `ExportRequest` (includes optional `format` field) / `ExportResult` types
- `sanitizeFilename()` — preserves Unicode, removes unsafe chars, strips trailing
  dots/spaces, guards Windows reserved device names including with extensions
  (`CON.txt`, `LPT1.pdf`, etc.), falls back to `'chat'` on empty result
- `formatSize()`
- `blockIsVisible()` — per-block visibility predicate
- `filterExportableMessages()` — strips partial/system/invisible messages

### 4.2 HTML serializer (`export-html.ts`) ✅

`serializeMessagesToHtml(messages, session, options): Promise<string>`

- Mirrors `serializeMessagesToMarkdown()` block-for-block, emitting semantic HTML.
- **Markdown text blocks rendered via an isolated `Marked` instance** (dynamic
  import — `marked@15` is ESM-only; dynamic import avoids CJS/ESM crash in the
  Electron main process). The instance is cached after first call.
- Does **not** mutate the global `marked` singleton.
- Ships with an embedded print stylesheet and a restrictive **CSP meta tag**
  (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`) as
  defence-in-depth against external resource loads in HTML consumers.
- See §7 for the full security model.

### 4.3 DOCX (`export-docx.ts`) ✅

`serializeMessagesToHtml(...)` → `@turbodocx/html-to-docx` → `Buffer` → write.

- Dynamic import supports both `default` and named (`HtmlToDocx`, `convert`) export
  shapes — guards against version/build differences.
- Return type handled correctly for both `ArrayBuffer` and `ArrayBufferView`
  (e.g. `Uint8Array`), respecting `byteOffset`/`byteLength` to prevent corrupt output.

### 4.4 PDF (`export-pdf.ts`) ✅

`serializeMessagesToHtml(...)` → offscreen `BrowserWindow` → `printToPDF` →
`Buffer` → write. See §7 for the locked-down window configuration.

---

## 5. Dependencies

| Package                   | Purpose                    | License | Native? | Notes                                                                             |
| ------------------------- | -------------------------- | ------- | ------- | --------------------------------------------------------------------------------- |
| `marked@15`               | Markdown text-block → HTML | MIT     | No      | ESM-only; loaded via dynamic import to avoid CJS crash                            |
| `@turbodocx/html-to-docx` | HTML → `.docx` buffer      | MIT     | No      | Actively maintained successor of `html-to-docx`; has postinstall script — see §15 |
| _(PDF)_                   | `webContents.printToPDF`   | —       | No      | **Built into Electron** — no dependency, reuses bundled Chromium                  |

All additions are pure JS — no `better-sqlite3`-style ABI rebuild, no Chromium
download. No bundling/packaging changes required beyond the two `npm install`s.

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

### 7.4 Hardened `marked` renderer (shipped) ✅

The HTML serializer uses an **isolated `Marked` instance** (not the global singleton)
with a hardened renderer that addresses two threats:

1. **Raw HTML passthrough** — `html` token handler escapes instead of emitting, so
   `<script>`, `<img onerror=…>` etc. in message text appear as literal characters.
2. **External resource references** — `image` tokens are replaced with a static
   placeholder; `link` tokens render text only (href stripped). This prevents SSRF
   via `html-to-docx`/axios fetching remote URLs, and privacy leaks in the PDF
   renderer.

Additionally, inline `data:` images are restricted to a **safe raster MIME
whitelist** (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`).
`image/svg+xml` and other non-raster types fall back to placeholder — SVG can contain
scripts that execute in some consumers even when JS is disabled at the outer level.

Base64 image data is validated against `/^[A-Za-z0-9+/]*={0,2}$/` before embedding
to prevent attribute injection via malformed data strings.

### 7.5 Locked-down offscreen window ✅

```js
const win = new BrowserWindow({
  show: false,
  webPreferences: {
    javascript: false, // injected <script>/onerror never runs
    sandbox: true, // Electron renderer sandbox (NOT the app's exec sandbox)
    nodeIntegration: false,
    contextIsolation: true,
  },
});
try {
  // HTML is written to a temp .html and loaded via loadFile() (not a data: URI)
  // so large chats / inline images don't hit Chromium's navigation URL limit.
  await win.loadFile(tmpFile); // wrapped in a 30s timeout guard
  const pdf = await win.webContents.printToPDF({ printBackground: true });
  await fs.promises.writeFile(filePath, pdf);
} finally {
  win.destroy();
  fs.promises.unlink(tmpFile).catch(() => {}); // best-effort temp cleanup
}
```

Defence in depth: `javascript: false` + sandbox + CSP meta tag + hardened renderer +
base64 validation + safe MIME whitelist.

---

## 8. Files Created / Modified ✅

| File                                           | Action      | Description                                                                                          |
| ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `src/main/chat/export-common.ts`               | **Created** | `ExportOptions`, `ExportFormat`, `ExportRequest/Result`, filtering, `sanitizeFilename`, `formatSize` |
| `src/main/chat/export-html.ts`                 | **Created** | `serializeMessagesToHtml()` — async, isolated Marked, hardened renderer, print stylesheet, CSP       |
| `src/main/chat/export-docx.ts`                 | **Created** | HTML → `@turbodocx/html-to-docx` → Buffer (handles ArrayBuffer + ArrayBufferView correctly)          |
| `src/main/chat/export-pdf.ts`                  | **Created** | HTML → locked-down offscreen window → `printToPDF` → Buffer                                          |
| `src/main/chat/export-router.ts`               | **Created** | Format router: one dialog, preferred format pre-selected, extension enforced, dispatch on extname    |
| `src/main/chat/export-markdown.ts`             | Modified    | Imports shared bits from `export-common.ts`; serializer behavior unchanged                           |
| `src/main/index.ts`                            | Modified    | `chat.export` handler + `chat.exportMarkdown` alias; both accept `format` field                      |
| `src/preload/index.ts`                         | Modified    | Exposes `chat.export` (with `format`); keeps `exportMarkdown` alias; Window type updated             |
| `src/renderer/components/ChatView.tsx`         | Modified    | Both call sites use `chat.export`; tooltip uses `chat.exportChat` i18n key                           |
| `src/renderer/i18n/locales/{en,zh,ru,hu}.json` | Modified    | `exportMarkdown` relabeled; `exportChat` key added ("Export chat…")                                  |
| `src/tests/chat-export-multiformat.test.ts`    | **Created** | 64 tests — see §12                                                                                   |
| `package.json`                                 | Modified    | Added `marked@15.0.12`, `@turbodocx/html-to-docx@1.22.0`                                             |

---

## 9. IPC Contract (as shipped)

```typescript
type ExportFormat = 'md' | 'docx' | 'pdf';

// Preload exposure
chat: {
  export: (request: {
    sessionId: string;
    messageIds?: string[];           // undefined = all messages
    format?: ExportFormat;           // pre-selects dialog filter; enforced on missing ext
    options?: Partial<ExportOptions>;
  }) => Promise<{ success: boolean; path?: string; error?: string }>;

  // Backward-compat alias — same router, both IPC routes show full dialog
  exportMarkdown: (request: { ... same shape ... }) => Promise<...>;
}

// Main process handler (chat.export + chat.exportMarkdown alias)
ipcMain.handle('chat.export', async (_event, request) => {
  // 1. Validate sessionId; fetch session + messages
  // 2. filterExportableMessages() — strip partial/system/invisible
  // 3. Show ONE save dialog; preferred format pre-selected from request.format
  // 4. If no extension typed: append request.format ext (not always .md)
  // 5. Dispatch on path.extname(filePath):
  //      .md   → serializeMessagesToMarkdown → write utf-8 string
  //      .docx → serializeMessagesToHtml → html-to-docx → write buffer
  //      .pdf  → serializeMessagesToHtml → printToPDF (locked-down window) → write buffer
  //      other → fall back to markdown
  // 6. Return { success, path }
});
```

---

## 10. Implementation Phases

### Phase 1 — Shared core + format router + DOCX ✅ (2026-07-01)

1. ✅ Create `export-common.ts`; refactor `export-markdown.ts` to consume it.
2. ✅ Create `export-html.ts` with hardened Marked instance + print stylesheet + CSP.
3. ✅ Create `export-docx.ts` (HTML → `@turbodocx/html-to-docx`; robust buffer conversion).
4. ✅ Create `export-router.ts` with multi-filter dialog + `ExportFormat` + extension enforcement.
5. ✅ Generalize IPC to `chat.export`; keep `chat.exportMarkdown` alias.
6. ✅ Update preload + ChatView; relabel i18n to "Export chat…".
7. ✅ 64 unit tests.

**Dependencies:** `marked@15`, `@turbodocx/html-to-docx@1.22.0`.

### Phase 2 — PDF ✅ (2026-07-01)

1. ✅ Create `export-pdf.ts` (locked-down offscreen window per §7.5).
2. ✅ `.pdf` filter + dispatch case in router.

**Additive only** — no UI change, no new dependency.

### Future formats

A 4th format = one filter entry + one serializer + one dispatch case + one
`ExportFormat` union member. Menu and pipeline untouched.

---

## 11. Edge Cases & Considerations

- **Empty / nothing-after-filtering** — `filterExportableMessages` applied in router
  before dialog; returns `'No messages to export'` without opening dialog. ✅
- **Streaming/partial messages** — filtered by `id.startsWith('partial-')`. ✅
- **Unicode titles** — preserved in document body; sanitized for filename. ✅
- **Large conversations** — no truncation in HTML/DOCX/PDF export (full tool results
  preserved for archival fidelity). ⚠️ **Note:** the shipped Markdown path still
  truncates each tool result to 500 chars (`raw.slice(0, 500)` in `export-markdown.ts`).
  This divergence is intentional for now — the Markdown serializer is kept byte-for-byte
  unchanged (see §Goals). Flagged in §15.4 to reconcile in the next refactor cycle. ✅
- **Concurrent exports** — each PDF export owns its offscreen window; no shared state. ✅
- **Offscreen window lifecycle** — `destroy()` in `finally`; never leaked. ✅
- **Extension omitted** — appends `request.format` extension, not always `.md`. ✅
- **macOS save panel** — "Save as type" popup near the filename field; acceptable
  per review (Option A chosen over an in-app toggle).

---

## 12. Testing (64 unit tests in `src/tests/chat-export-multiformat.test.ts`)

### Helpers (`export-common`)

- `sanitizeFilename` — alphanumeric, CJK, unsafe chars, whitespace, control chars,
  truncation, empty input fallback, trailing dots/spaces, Windows reserved names
  (bare + with extension: `CON`, `LPT1.pdf`, etc.)
- `formatSize` — bytes / KB / MB
- `blockIsVisible` — all block types × option combinations
- `filterExportableMessages` — system, partial, invisible blocks

### HTML serializer (`export-html`)

- Document structure, print stylesheet, role badges
- All block types: text (markdown rendered), thinking, tool_use, tool_result,
  image (placeholder / skip / inline / SVG fallback), file_attachment
- Timestamps, token usage
- **Security / escaping:**
  - `<script>` in tool names → escaped
  - `onerror` payload in tool results → escaped
  - `<evil>` in filenames → escaped
  - Script tag in text block → not executable
  - `<img onerror>` in text block → not executable
  - Markdown remote image → no `src="https://…"` in output
  - Markdown link → no `href=` in output; link text preserved
  - Markdown link with HTML label → not executable
  - Raw HTML block in text → escaped
  - SVG inline image → falls back to placeholder
  - Invalid base64 data → falls back to placeholder
  - No external `href=` or `src=http/https/file` anywhere in output
  - CSP meta tag present with `default-src 'none'` and `img-src data:`

### DOCX buffer conversion

- `ArrayBuffer` → `Buffer` correct
- `ArrayBufferView` (Uint8Array with byteOffset) → `Buffer` correct
- Regression proof that naive `Buffer.from(ab)` ignores byteOffset

### Format + extension dispatch

- `.md` / `.docx` / `.pdf` recognised
- Unknown extension not in supported set
- `appendIfMissing` logic: bare filename + format → correct extension
- PDF format with no extension → `.pdf`, not `.md`

---

## 13. Open Questions (resolved)

1. ✅ **Doc-then-code** confirmed.
2. ✅ **Dependencies** — `marked` + `@turbodocx/html-to-docx` accepted (both MIT,
   pure JS). See §15 for outstanding supply-chain note.
3. ✅ **Sidebar export** — routes through `chat.export` for consistency (sidebar
   export button not yet implemented; when added, use `chat.export`).

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
- **Large-chat PDF stability** — ✅ resolved: the PDF path writes the HTML to a temp
  `.html` file and uses `win.loadFile()` (with a 30s load/print timeout guard and
  best-effort temp-file cleanup) instead of a `data:` URL, so large chats with inline
  images no longer risk hitting Chromium's navigation URL length limit.

---

## 15. Technical Debt & Next Refactor Cycle

These items were flagged during the review loop but are **not blocking** the shipped
feature. Track for the next refactor cycle.

### 15.1 Shared message/content types (`src/shared/`) — MEDIUM

**Problem:** `Message`, `Session`, and all `ContentBlock` interfaces are duplicated
in `src/main/chat/export-common.ts` from `src/renderer/types/index.ts`. If renderer
types gain new content block variants (or rename fields), exports break silently at
runtime — the TypeScript compiler cannot catch cross-process drift.

**Proposed fix:** Move the shared types to `src/shared/chat-types.ts` and import
from both `src/main/` and `src/renderer/`. This is a larger refactor touching both
process boundaries; it needs care around the renderer bundle and any
`contextBridge`-serialized types.

**Interim guard:** The TODO comment in `export-common.ts` is intentional. Until the
migration happens, treat any renderer-side `ContentBlock` change as requiring a
matching update in `export-common.ts`.

### 15.2 `@turbodocx/html-to-docx` supply-chain audit — MEDIUM

**Problem:** `@turbodocx/html-to-docx@1.22.0` has `hasInstallScript: true`
(postinstall). It pulls in `axios` and an HTML parsing/minification toolchain into
the main process. This increases the supply-chain surface and means a future
dependency compromise could affect the export pipeline.

**Proposed fix:**

1. Add `@turbodocx/html-to-docx` to the project's dependency audit policy (CI
   `npm audit` gate or equivalent).
2. Consider `--ignore-scripts` in CI for non-native deps and document the exception
   for this package.
3. The shipped HTML preprocessing (no external URLs, CSP meta tag, base64 validation)
   already prevents the most dangerous SSRF vector (axios fetching remote images).
   This defence is tested and should be kept even if the library is swapped out.

### 15.3 Export-router Electron mock tests — LOW

**Problem:** The `export-router.ts` dispatch path uses `electron.dialog`,
`BrowserWindow`, and `fs.promises.writeFile` — none of which run in Vitest's Node
environment. The current tests exercise the dispatch _logic_ (extension mapping,
`appendIfMissing`) in isolation, but do not exercise the full router end-to-end with
mocked Electron APIs.

**Proposed fix:** Add a focused integration test suite that mocks `electron` (via
`vi.mock('electron', ...)`) and `fs.promises.writeFile`, asserting that `.md`/
`.docx`/`.pdf` paths each call the correct serializer and write the correct bytes.
This is straightforward but requires setting up the Electron mock pattern — defer
until the test infrastructure has a standard pattern for it.

### 15.4 Tool-result truncation divergence across formats — LOW

**Problem:** The Markdown serializer truncates each tool result to 500 chars
(`raw.slice(0, 500)` in `export-markdown.ts`), while the HTML/DOCX/PDF path emits the
full content. The same conversation therefore exports with different tool-result
fidelity depending on the chosen format.

**Why not fixed now:** The design's "keep the shipped Markdown path byte-for-byte
unchanged" goal (see §Goals) takes precedence for this release, so the Markdown
output was left as-is.

**Proposed fix:** Reconcile the two paths — either lift the 500-char cap in Markdown
for full archival parity, or make the cap a shared, configurable `ExportOptions`
field applied by all serializers. Pick one in the next refactor cycle.
