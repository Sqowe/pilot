# Chat Smart Scrolling — Design

**Created:** 2026-05-31
**Status:** Concept
**Author:** AI-assisted design session

---

## 1. Overview

Enhance chat scroll behavior for long conversations spanning days, weeks, or
months. The goal is to help users navigate large message histories efficiently
without losing context.

---

## 2. Ideas

### 2.1 Sticky Day Separator While Scrolling

Like iOS Messages — when scrolling through a long conversation, the current
day separator "sticks" to the top of the viewport so the user always knows
what date they're looking at.

**Behavior:**

- As user scrolls up through messages, the day separator for the currently
  visible section pins to the top of the scroll container
- When the next day separator scrolls into view, it pushes the previous one
  out (smooth transition)
- Only visible while actively scrolling or when not at the bottom

**Implementation considerations:**

- Use `IntersectionObserver` on each `DateSeparator` to detect which is
  currently at the top
- Render a fixed-position overlay separator that mirrors the current date
- Fade in/out based on scroll activity

---

### 2.2 Scroll-to-Date (Click Separator to Jump)

Clicking a day separator could open a mini date picker or list of available
dates in the conversation, allowing quick jumps to specific days.

**Behavior:**

- Click on any day separator → shows a dropdown/popover with all dates that
  have messages in this conversation
- Select a date → smooth scroll to that day's first message
- Keyboard accessible (Enter to open, arrow keys to navigate dates)

---

### 2.3 Jump-to-Date Picker for Very Long Conversations

For conversations with 100+ messages spanning weeks/months, a dedicated
"jump to date" control (calendar icon in the header or scroll gutter) that
lets users pick any date and jump directly there.

**Possible UI:**

- Small calendar icon in the chat header or floating at the scroll edge
- Opens a compact calendar/date list showing only dates with messages
- Highlights the currently visible date

---

## 3. Implementation Plan

| #   | Feature                 | Priority | Complexity                                    |
| --- | ----------------------- | -------- | --------------------------------------------- |
| 1   | Sticky day separator    | Medium   | Medium — IntersectionObserver + fixed overlay |
| 2   | Click separator to jump | Low      | Low — popover with date list                  |
| 3   | Jump-to-date picker     | Low      | Medium — calendar component + scroll logic    |

---

## 4. Dependencies

- Requires Phase 1 of `chat-timestamps.md` (day separators must exist first) ✅
- Scroll container ref is already available in `ChatView.tsx` (`scrollContainerRef`)

---

## 5. Open Questions

- Should the sticky separator be always visible or only appear during active
  scrolling (auto-hide after idle)?
- For jump-to-date, should it show a full calendar or just a flat list of
  dates with message counts?
- Performance: for very long chats (1000+ messages), should we virtualize
  the message list first before adding scroll features?
