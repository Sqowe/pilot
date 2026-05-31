# Chat Timestamps & Date Separators — Design

**Created:** 2026-05-31
**Status:** Draft
**Author:** AI-assisted design session

---

## 1. Problem Statement

The chat view currently shows no visible timestamps or date indicators in the
message flow. When a conversation spans days, weeks, or months, users cannot
tell when messages were sent without manually inferring from context.

This is especially problematic for:

- **Long-running conversations** resumed after days/weeks of inactivity
- **Archived/old chats** opened for reference — "when did this happen?"
- **Timeline reconstruction** — understanding the sequence of events
- **Multi-day debugging sessions** — "was this before or after the fix?"

### Evidence

- OpenClaw issue #69306: users explicitly requested day separators + timestamps
  on demand, citing Telegram's superior date visibility as the benchmark.
- Microsoft Teams users complain about relative-only labels ("Yesterday") that
  become meaningless for older conversations.
- UX StackExchange consensus: use progressive detail — relative for recent,
  absolute for older, full precision on hover.
- CometChat best practices: "For long conversations, implement visual cues to
  show message threads. Consider using separators, timestamps."
- PubNub: "Always include message timestamps. Not having them disrupts UX."
- NN/g (Nielsen Norman Group): "Show timestamps for messages to put response
  time in context."

---

## 2. Goals

- Show clear date context when scrolling through conversations
- Make archived/old chats immediately understandable ("when was this?")
- Keep the UI clean — timestamps should inform, not clutter
- Respect locale (language + date/time format) automatically
- Work consistently across active chats and archived history

### Non-Goals (for now)

- Timezone selector / manual timezone override
- "X minutes ago" live-updating relative timestamps (adds complexity, limited value)
- Timestamps on every individual assistant message within a turn

---

## 3. Design

### 3.1 Three Layers of Time Information

| Layer                | Visibility              | Purpose                     | Example (en-US)                    | Example (zh-CN)                   |
| -------------------- | ----------------------- | --------------------------- | ---------------------------------- | --------------------------------- |
| **Day separator**    | Always visible          | Orient user in timeline     | `── Today ──` / `── May 12 ──`     | `── 今天 ──` / `── 5月12日 ──`    |
| **Per-message time** | Always visible (subtle) | Know when within the day    | `2:34 PM`                          | `下午2:34`                        |
| **Full tooltip**     | On hover/focus          | Exact timestamp for records | `Monday, May 12, 2026, 2:34:12 PM` | `2026年5月12日星期一 下午2:34:12` |

### 3.2 Day Separators

A horizontal divider with a centered date label, inserted between messages
when the calendar day changes.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  [User message from May 11]                             │
│                                                         │
│  ─────────── Monday, 12 May 2026 ───────────           │
│                                                         │
│  [User message from May 12]                             │
│  [Assistant response]                                   │
│                                                         │
│  ─────────── Today ─────────────────────────           │
│                                                         │
│  [User message from today]                              │
│  [Assistant response]                                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Label logic (progressive detail):**

| Condition                | Label                                                   | Rationale                           |
| ------------------------ | ------------------------------------------------------- | ----------------------------------- |
| Same calendar day as now | `Today` / `今天`                                        | Relative — user knows what today is |
| Previous calendar day    | `Yesterday` / `昨天`                                    | Relative — universally understood   |
| Within last 7 days       | Weekday + date: `Wednesday, May 28` / `星期三，5月28日` | Weekday gives quick mental anchor   |
| Same year                | Month + day: `May 12` / `5月12日`                       | Year is redundant for current year  |
| Different year           | Full date: `May 12, 2024` / `2024年5月12日`             | Year is essential for old chats     |

**Placement:** Between turns (not between individual messages within a turn).
The separator appears before the first user message of a new day.

### 3.3 Per-Message Timestamp

A small, muted time label shown on user messages (the start of each turn).
Not repeated on every assistant message within the same turn — the day
separator already establishes the date, and the time on the user message
establishes the "when" for the entire exchange.

```
┌─────────────────────────────────────────────────────────┐
│  ─────────── Today ─────────────────────────           │
│                                                         │
│  You                                        2:34 PM    │
│  How do I configure the API?                            │
│                                                         │
│  Assistant                                              │
│  Here's how to set it up...                             │
│                                                         │
│  You                                        4:12 PM    │
│  I got an error when deploying                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Styling:**

- Font size: 11px (matches existing execution timer style)
- Color: `text-text-muted` (same as existing metadata)
- Position: right-aligned on the same line as the role label, or below it

### 3.4 Hover Tooltip (Full Precision)

On hover (or long-press on touch), show the complete timestamp with:

- Full weekday name
- Full date
- Time with seconds
- Timezone (if relevant)

Uses the HTML `title` attribute or a custom tooltip component.

Format: `Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' })`

### 3.5 Session Date Range (Header Metadata)

For archived/old chats, show a date range in the session header or metadata
area indicating when the conversation took place:

- Single-day conversation: `May 12, 2026`
- Multi-day conversation: `May 12 – May 28, 2026`
- Cross-year: `Dec 28, 2025 – Jan 3, 2026`

This gives immediate context when opening an old chat without scrolling.

---

## 4. Locale & Internationalization

### 4.1 Principles

1. **Never hardcode date format strings** — always use `Intl.DateTimeFormat`
2. **Relative labels use translation keys** — `sidebar.today`, `sidebar.yesterday`
   (already exist in en.json / zh.json)
3. **Absolute dates use `Intl.DateTimeFormat(getAppLocale(), options)`** — handles
   day/month order, month names, year placement automatically per locale
4. **Time format follows locale** — 12h for en-US, locale-appropriate for zh-CN
5. **Future locales work automatically** — adding `de-DE` or `ja-JP` requires
   zero changes to date formatting logic

### 4.2 Existing Infrastructure

The app already has:

```typescript
// src/renderer/utils/i18n-format.ts
function getAppLocale(): string; // → 'zh-CN' | 'en-US'
function formatAppDateTime(value): string; // dateStyle: 'medium', timeStyle: 'short'
function formatAppDate(value, options?): string; // customizable Intl options
```

Translation keys already available:

- `sidebar.today` → "Today" / "今天"
- `sidebar.yesterday` → "Yesterday" / "昨天"
- `sidebar.previousWeek` → "Previous 7 Days" / "最近 7 天"

### 4.3 New Utility Functions

Add to `src/renderer/utils/i18n-format.ts`:

```typescript
/**
 * Format a timestamp for use as a day separator label.
 * Progressive detail: Today → Yesterday → Weekday, Date → Date → Date, Year
 */
export function formatChatDaySeparator(timestamp: number): string;

/**
 * Format a timestamp as time-only for per-message display.
 * e.g., "2:34 PM" or "下午2:34"
 */
export function formatChatTime(timestamp: number): string;

/**
 * Format a full timestamp for tooltip/hover display.
 * e.g., "Monday, May 12, 2026, 2:34:12 PM"
 */
export function formatChatTooltip(timestamp: number): string;

/**
 * Format a date range for session header metadata.
 * e.g., "May 12 – May 28, 2026" or single date if same day.
 */
export function formatSessionDateRange(startTs: number, endTs: number): string;
```

### 4.4 New Translation Keys

```json
{
  "chat": {
    "daySeparator": {
      "today": "Today",
      "yesterday": "Yesterday"
    }
  }
}
```

Note: We can reuse `sidebar.today` / `sidebar.yesterday` directly, or create
dedicated keys under `chat.` namespace for flexibility. Prefer reuse unless
the label needs to differ (e.g., sidebar says "Today" but separator says
"Today, May 31").

---

## 5. Component Design

### 5.1 `DateSeparator` Component

```tsx
// src/renderer/components/message/DateSeparator.tsx
interface DateSeparatorProps {
  timestamp: number;
}

export function DateSeparator({ timestamp }: DateSeparatorProps) {
  const label = formatChatDaySeparator(timestamp);
  const tooltip = formatChatTooltip(timestamp);

  return (
    <div className="flex items-center gap-3 py-2" title={tooltip}>
      <div className="flex-1 h-px bg-border-subtle" />
      <span className="text-[11px] text-text-muted whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  );
}
```

### 5.2 Integration Point: `GroupedMessages`

The `GroupedMessages` component iterates over turns. The day separator should
be inserted **between turns** where the calendar day changes:

```tsx
{turns.map((turn, turnIndex) => {
  const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
  const currentDay = getDayKey(turn.userMessage?.timestamp || turn.assistantMessages[0]?.timestamp);
  const prevDay = prevTurn
    ? getDayKey(prevTurn.userMessage?.timestamp || prevTurn.assistantMessages[0]?.timestamp)
    : null;
  const showSeparator = turnIndex === 0 || currentDay !== prevDay;

  return (
    <div key={...}>
      {showSeparator && <DateSeparator timestamp={...} />}
      {/* existing turn rendering */}
    </div>
  );
})}
```

### 5.3 Per-Message Time on `MessageCard`

Add an optional time display to the `MessageCard` component for user messages:

```tsx
// Only on user messages (turn starters)
{
  message.role === 'user' && (
    <time
      className="text-[11px] text-text-muted"
      dateTime={new Date(message.timestamp).toISOString()}
      title={formatChatTooltip(message.timestamp)}
    >
      {formatChatTime(message.timestamp)}
    </time>
  );
}
```

---

## 6. Behavior Details

### 6.1 First Message of Chat

Always show a day separator before the very first message, even if there's
only one day in the conversation. This ensures archived chats always show
their date.

### 6.2 Streaming / Active Turn

The current (streaming) turn does not need special handling — it inherits
the day separator from when the user message was sent. If the user sends a
message at 11:59 PM and the response completes at 12:01 AM, the separator
stays with the user message's date.

### 6.3 Partial Messages

Partial/streaming messages (id starts with `partial-`) should not trigger
day separators. Only committed messages participate in date logic.

### 6.4 System Messages

System messages (role === 'system') are typically hidden from the user.
They should not trigger day separators.

---

## 7. Accessibility

- Day separator uses semantic `<time>` element with `datetime` attribute
- Tooltip text available via `title` for screen readers
- Sufficient contrast for muted timestamp text (meets WCAG AA at 11px)
- Day separator is decorative — use `role="separator"` with `aria-label`
  containing the date text for screen reader announcement

---

## 8. Implementation Plan

### Phase 1: Core (MVP)

1. Add formatting utilities to `i18n-format.ts`
2. Create `DateSeparator` component
3. Integrate into `GroupedMessages` — show day separators between turns
4. Add per-message time on user messages
5. Add hover tooltip with full timestamp

### Phase 2: Session Metadata

6. Add date range display to session header/metadata
7. Show conversation date range in sidebar session items (for old chats)

### Phase 3: Polish

8. Smooth scroll-to-date (click separator to jump)
9. Sticky day separator while scrolling (like iOS Messages)
10. Consider "jump to date" picker for very long conversations

---

## 9. References

- [UX StackExchange: How to display date and time](https://ux.stackexchange.com/questions/16095/how-to-display-date-and-time)
- [PubNub: How to manage chat message timestamps](https://www.pubnub.com/how-to/message-timestamps/)
- [CometChat: UI/UX Best Practices for Chat App Design](https://www.cometchat.com/blog/chat-app-design-best-practices)
- [TheFrontKit: AI Chat UI Best Practices 2026](https://thefrontkit.com/blogs/ai-chat-ui-best-practices)
- [OpenClaw Issue #69306: Show clear message dates or day separators](https://github.com/openclaw/openclaw/issues/69306)
- [Microsoft Teams: Display chat message with date stamp](https://techcommunity.microsoft.com/discussions/microsoftteams/display-teams-chat-message-with-date-stamp-rather-than-relative-day/4230119)
