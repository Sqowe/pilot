<!-- sources: src/renderer/components/SearchOverlay.tsx, src/renderer/components/Sidebar.tsx, src/renderer/i18n/locales/en.json (searchOverlay) -->

# Search conversations

## What it is / when to use it

Press `Ctrl`/`Cmd`+`K` anywhere to open a search box over **all your past conversations**.
Type a few words and jump straight to the matching session. With [Memory](memory.md) enabled,
search is semantic (it matches meaning, not just keywords); with it off, search is limited to
session titles.

Reach for this when: you remember a chat from days or weeks ago and want to get back to it
without scrolling the sidebar.

## How to use it

1. Press **`Ctrl`/`Cmd`+`K`** (or click the search icon in the Sidebar).
2. Type your query — results appear as you type.
3. Use **↑ / ↓** to move the selection and **Enter** to open a session (or click it).
4. Press **Esc** to close.

If memory is off, you'll see a note that search is titles-only; enable Memory for deeper,
semantic search.

![Search overlay](../assets/search-overlay.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/search-overlay.png

## Commands & settings

| Action           | How to run                               |
| ---------------- | ---------------------------------------- |
| Open search      | `Ctrl`/`Cmd`+`K`, or Sidebar search icon |
| Navigate results | **↑ / ↓**                                |
| Open a result    | **Enter** (or click)                     |
| Close            | **Esc**                                  |

Deeper semantic search depends on [Memory](memory.md) being enabled.

---

[← All docs](../index.md)
