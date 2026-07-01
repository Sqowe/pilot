# Chat Selection Copy Menu — Design

**Created:** 2026-07-01
**Status:** Done
**Author:** AI-assisted design session

---

## 1. Overview

Add a right-click (context menu) "Copy" action for **any** text the user
selects in the main chat window. Today users can only copy an entire message
via the hover copy button on `MessageCard`, or copy a link's URL via the
existing link context menu. There is no way to copy an arbitrary sub-selection
(a sentence, a phrase, part of a code block) with the mouse.

The goal is a small, native-feeling context menu that appears at the cursor
when the user right-clicks over a non-empty text selection inside the chat
message area.

---

## 2. Current Behavior

| Capability                     | Where                                                                       | Mechanism                                |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| Copy whole message             | `MessageCard.tsx` hover button (`handleCopy`)                               | `window.electronAPI.clipboard.writeText` |
| Copy a code block              | `CodeBlock.tsx` copy button                                                 | `window.electronAPI.clipboard.writeText` |
| Right-click a link → Copy Link | `LinkContextMenu.tsx` via `handleLinkContextMenu` in `ContentBlockView.tsx` | `window.electronAPI.clipboard.writeText` |
| **Copy arbitrary selection**   | — (missing)                                                                 | —                                        |

Messages render inside the scroll container at `ChatView.tsx` (the
`scrollContainerRef` div, `flex-1 overflow-y-auto`), which wraps
`GroupedMessages` → `MessageCard` → `ContentBlockView`.

The existing `LinkContextMenu` already establishes the reusable pattern we
want to follow:

- `fixed` positioning at cursor coordinates
- viewport-boundary clamping (repositions if it would overflow)
- dismiss on `Escape` and click-outside
- accessible roles (`role="menu"` / `role="menuitem"`)
- i18n labels
- unmount-safe timeout handling

---

## 3. Proposed Solution

Reuse the `LinkContextMenu` pattern with a new, minimal menu that operates on
the current DOM text selection.

### 3.1 New component — `SelectionContextMenu.tsx`

`src/renderer/components/message/SelectionContextMenu.tsx`

A stripped-down sibling of `LinkContextMenu` with a single **Copy** action.

**Props:**

```ts
export interface SelectionContextMenuProps {
  text: string; // the selected text to copy
  x: number;
  y: number;
  onClose: () => void;
}
```

**Behavior:**

- Renders a `fixed`, `z-[9999]` popup at `{x, y}`, clamped to the viewport
  (identical logic to `LinkContextMenu`).
- One menu item: **Copy** (lucide `Copy` icon). On click, calls
  `window.electronAPI.clipboard.writeText(text)`, shows a brief "Copied!"
  confirmation, then closes after ~600ms.
- Dismisses on `Escape` or click-outside.
- Copy-timeout stored in a ref and cleared on unmount (no stale timers).

### 3.2 Wire into `ChatView.tsx`

Add an `onContextMenu` handler on the scroll container div (the
`scrollContainerRef` element).

```tsx
const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(
  null
);

const handleSelectionContextMenu = useCallback((e: React.MouseEvent) => {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text) return; // nothing selected → normal behavior, no menu
  e.preventDefault();
  setSelectionMenu({ text, x: e.clientX, y: e.clientY });
}, []);
```

- Attached to `<div ref={scrollContainerRef} onContextMenu={handleSelectionContextMenu} …>`.
- If nothing is selected, the handler returns early and default browser
  behavior is preserved.
- The menu is rendered conditionally at the end of the component:
  `{selectionMenu && <SelectionContextMenu {...selectionMenu} onClose={() => setSelectionMenu(null)} />}`.

### 3.3 Conflict avoidance with the link menu

`handleLinkContextMenu` in `ContentBlockView.tsx` already calls
`e.stopPropagation()`. Because the link's `onContextMenu` fires first and stops
propagation, right-clicking a link surfaces **only** the `LinkContextMenu`, and
the container-level selection handler never runs. No additional coordination
needed.

### 3.4 i18n

Add a `selectionMenu` block to both locale files:

`en.json`

```json
"selectionMenu": {
  "title": "Selection options",
  "copy": "Copy",
  "copied": "Copied!"
}
```

`zh.json` — Chinese equivalents.

---

## 4. Files

| File                                                       | Change                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/renderer/components/message/SelectionContextMenu.tsx` | ✅ **New** — minimal copy-only context menu (based on `LinkContextMenu`) |
| `src/renderer/components/ChatView.tsx`                     | ✅ Add `onContextMenu` handler + menu state on scroll container          |
| `src/renderer/i18n/locales/en.json`                        | ✅ Add `selectionMenu` keys                                              |
| `src/renderer/i18n/locales/zh.json`                        | ✅ Add `selectionMenu` translations                                      |

**No main-process / preload / IPC changes** — `clipboard.writeText` already
exists (`preload/index.ts`).

---

## 5. UX Details

- Menu appears at the cursor position, matching the link menu look & feel.
- The selection is left visually intact while the menu is open (we do not
  clear `window.getSelection()`).
- Menu dismisses on: click a menu item, click outside, `Escape`, or scroll.
- Confirmation state ("Copied!") mirrors the link menu's 600ms pattern.

---

## 6. Open Questions

- Should we also add **"Copy as quote"** (prefix each line with `> `) as a
  second item? Useful for pasting into a reply. — Out of scope for v1.
- Should right-click over a selection inside the **input textarea** be handled
  too, or left to the OS-native editing menu? — v1 scopes to the message area
  only; the textarea keeps native behavior.
- Windows parity: the DOM-selection approach is platform-agnostic, so no
  platform-specific work is expected (unlike the browser-detection in the link
  menu). To be confirmed during implementation.

---

## 7. Dependencies

- `LinkContextMenu.tsx` — reference implementation for positioning, clamping,
  and dismissal logic.
- `scrollContainerRef` in `ChatView.tsx` — already available; the
  `onContextMenu` handler attaches here.
- `window.electronAPI.clipboard.writeText` — already exposed via preload.
