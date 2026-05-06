# Frontend Implementation Rules

Rules for all code under `src/renderer/`. Derived from existing patterns,
real bugs, and architectural decisions in this project.

---

## 1. Tech Stack (locked)

| Layer      | Choice                                                                     | Notes                                         |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Framework  | React 18 (functional components only)                                      | React 19 upgrade planned but not started      |
| State      | Zustand 5                                                                  | Single store in `store/index.ts`              |
| Styling    | Tailwind CSS 3                                                             | `tailwind.config.js`; no CSS Modules, no SASS |
| Icons      | Lucide React                                                               | `lucide-react` — no other icon libraries      |
| i18n       | i18next + react-i18next                                                    | EN + ZH; see Section 7                        |
| Markdown   | react-markdown + remark-gfm + remark-math + rehype-katex + rehype-sanitize | See Section 8                                 |
| Build      | Vite 7 + vite-plugin-electron                                              | `vite.config.ts`                              |
| Test       | Vitest + (React Testing Library if needed)                                 | `vitest.config.mts`                           |
| TypeScript | Strict mode                                                                | No implicit `any`                             |

Do not introduce new UI libraries without explicit approval.

---

## 2. Architecture Boundary — The IPC Bridge

**The renderer MUST NEVER import from `electron`, `fs`, `path`, `child_process`,
or any Node.js built-in module.**

All main-process communication goes through `window.electronAPI`, defined in
`src/preload/index.ts`. The renderer uses three primitives:

```typescript
window.electronAPI.send(event: ClientEvent)        // fire-and-forget to main
window.electronAPI.on(callback: (e: ServerEvent) => void)  // subscribe to main events
window.electronAPI.invoke(channel, ...args)        // request/response (typed per channel)
```

**Rules:**

- Guard every call: `if (window.electronAPI) { ... }` — the renderer should
  degrade gracefully if the bridge is unavailable.
- New `ClientEvent` types must be added to `ALLOWED_CLIENT_EVENTS` in
  `src/preload/index.ts` or they'll be silently dropped.
- New `ServerEvent` types must be added to the discriminated union in
  `src/renderer/types/index.ts`.
- Never store `window.electronAPI` in a variable at module scope — access it
  at call time (the reference is stable but this pattern prevents test mocking issues).

**Future note:** This boundary is the seam for a potential web port. Preserving
it means the renderer stays portable. Do not introduce new Electron coupling paths.

---

## 3. Project Structure

```
src/renderer/
├── App.tsx                 # Root component, mounts dialogs/toasts/panels
├── main.tsx                # Entry point (React root + i18n init)
├── components/             # All UI components (flat + subdirectories)
│   ├── settings/          # Settings panel tabs
│   ├── message/           # Message rendering components
│   ├── remote/            # Remote control UI
│   ├── ChatView.tsx       # Main chat interface
│   ├── Sidebar.tsx        # Session list
│   ├── MessageCard.tsx    # Single message rendering
│   ├── PermissionDialog.tsx
│   └── ...
├── hooks/                  # Custom hooks
│   ├── useIPC.ts          # Central IPC event handler (THE critical hook)
│   ├── useApiConfigState.ts
│   └── useWindowSize.ts
├── store/                  # Zustand state
│   ├── index.ts           # Store definition + actions
│   └── selectors.ts       # All selector hooks (useXxx pattern)
├── i18n/                   # Localization
│   ├── config.ts          # i18next setup
│   └── locales/           # en.json, zh.json
├── types/                  # TypeScript types (shared with preload)
├── styles/                 # Global CSS + Tailwind base
└── utils/                  # Pure utility functions
```

**Rules:**

- Components go in `components/` — use subdirectories only for logical grouping
  (settings, message, remote). Do not create feature-oriented folders.
- Shared hooks go in `hooks/`. Component-specific logic stays in the component.
- All types shared with preload/main go in `types/index.ts`.
- No `utils/` dumping ground — if a utility is domain-specific, co-locate it.

---

## 4. Component Conventions

- **Functional components only** — no class components.
- **Props must be typed** with `interface` (preferred) or `type`:
  ```typescript
  interface ChatViewProps {
    sessionId: string;
    onSend: (text: string) => void;
  }
  ```
- **Use `React.memo`** for presentational components that receive stable props
  but sit in frequently-updating parent trees (e.g., `MessageMarkdown`).
- **File size soft limit: 300 lines.** If a component exceeds this, extract
  sub-components or hooks. Hard limit: 800 lines.
- **No direct DOM access** (`document.querySelector`, etc.) — use refs.
- **Side effects in hooks only** — never in the render path.
- **Export named components** — avoid default exports (better refactoring support).

---

## 5. State Management (Zustand)

### Store Structure

Single store in `src/renderer/store/index.ts` with a flat state shape:

```typescript
interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>; // per-session data
  settings: Settings;
  appConfig: AppConfig | null;
  // ... UI flags
}
```

### Selector Rules (`src/renderer/store/selectors.ts`)

- All selector hooks use the `use` prefix: `useCurrentSession()`, `useActiveSessionMessages()`.
- Per-session derived state always falls back to safe empty values — callers
  never guard against undefined.
- Multi-field selectors use `useShallow` from `zustand/react/shallow` to prevent
  unnecessary re-renders:
  ```typescript
  export function useLayoutState() {
    return useAppStore(
      useShallow((s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        contextPanelCollapsed: s.contextPanelCollapsed,
      }))
    );
  }
  ```
- **Never subscribe to the entire store** — always select the minimal slice.
- Add new selectors to `selectors.ts`, not inline in components.

### State Updates

- Actions are defined as methods on the store (inside `create()`).
- Use the `patchSession` helper for per-session state updates.
- Never mutate state directly — always return new objects via spread.

---

## 6. IPC Event Handling (`useIPC.ts`)

This is the most critical hook in the renderer. It:

1. Subscribes to `window.electronAPI.on(callback)` for all `ServerEvent`s
2. Dispatches to Zustand store actions based on `event.type`
3. Hydrates initial state from main process on mount

**Rules:**

- The switch on `event.type` must handle every `ServerEvent` variant.
- Never do async work inside the event handler — dispatch to store synchronously.
- On app bootstrap, push renderer settings to main via `settings.update` so the
  main process has permission rules before the first tool call.
- If adding a new event type: add to `ServerEvent` union in types, add case in
  `useIPC.ts`, add store action if state needs updating.

---

## 7. Internationalization (i18n)

- **All user-visible text must use `t()` from `useTranslation()`** — no hardcoded strings.
- Two locale files: `src/renderer/i18n/locales/en.json` and `zh.json`.
- Key naming: dot-separated, grouped by feature module:
  ```
  settings.general.title
  settings.bashCommands.trustedLabel
  chat.input.placeholder
  mcp.toolsAvailable
  ```
- **Always add both EN and ZH** when creating new keys. If you don't know the
  Chinese translation, add the English text as a placeholder with a `// TODO: translate`
  comment in the JSON (JSON doesn't support comments — add a `_todo` sibling key).
- Variables use `{{name}}` interpolation syntax.
- Plurals use `_plural` suffix (i18next convention).
- Language detection order: localStorage → browser navigator.

---

## 8. Markdown Rendering

The markdown stack renders LLM output. Configuration is in `MessageMarkdown.tsx`:

```
react-markdown
  → remark-gfm (tables, task lists, strikethrough)
  → remark-math (math block parsing)
  → rehype-katex (math rendering) — MUST run before rehype-sanitize
  → rehype-sanitize (XSS protection on LLM output)
```

**Rules:**

- Plugin arrays are hoisted to module scope (avoid re-creation on render).
- `rehype-sanitize` is a security boundary — never remove or weaken it.
- Plugin order matters: katex before sanitize, or math markup gets stripped.
- Upgrade the remark/rehype family as a group — they evolve together.
- Syntax highlighting uses `highlight.js` — imported in `MessageCard.tsx`.

---

## 9. Styling (Tailwind)

- Use Tailwind utility classes exclusively — no custom CSS unless truly necessary.
- Class ordering convention: layout → sizing → spacing → typography → colors → effects.
  Example: `flex items-center gap-2 px-4 py-2 text-sm text-text-primary bg-surface rounded-lg hover:bg-surface-hover`
- Custom design tokens are defined in `tailwind.config.js` (colors like
  `text-primary`, `bg-surface`, `bg-accent`, etc.).
- Use the project's semantic color names, not raw Tailwind colors (`text-text-primary`
  not `text-gray-900`).
- Responsive: support at minimum desktop width. Mobile is not a target for this
  Electron app, but don't hardcode pixel widths where flex/grid works.
- Dark mode: handled via Tailwind's `dark:` variant, driven by the `theme` setting.

---

## 10. Performance

- `React.memo` for pure presentational components in hot paths (message list items).
- `useMemo` / `useCallback` only when they prevent measurable re-renders — don't
  sprinkle them everywhere prophylactically.
- Zustand selectors with `useShallow` are the primary re-render prevention tool.
- Lazy-load heavy components (settings panels, diagnostics) with `React.lazy` if
  they add significant bundle weight.
- The message list can grow large — virtualization may be needed in the future but
  is not implemented today. Don't add it speculatively.

---

## 11. Accessibility

- Use semantic HTML: `<button>` for actions, `<label>` for inputs, `<nav>`, `<main>`.
- Every interactive element must be keyboard-accessible.
- Inputs must have associated labels (visible or `aria-label`).
- Icons used as buttons need `aria-label` or adjacent text.
- Loading states must be announced (use `aria-live="polite"` for streaming regions).
- Color contrast: follow the project's design tokens which are chosen for readability.
- Full WCAG validation requires manual testing with assistive technologies.

---

## 12. Error Handling

- Wrap feature areas in `<ErrorBoundary>` (exists at `components/ErrorBoundary.tsx`
  and `PanelErrorBoundary.tsx`).
- Never show raw error messages from the backend to users.
- Map technical errors to user-friendly i18n keys.
- Log detailed errors to `console.error` for debugging.
- IPC errors should degrade gracefully — show a notice, don't crash the UI.

---

## 13. Testing

- Test runner: Vitest (`npm test`).
- Test files live in `src/tests/` (not co-located with components).
- Focus tests on:
  - Critical logic (store actions, selectors, utility functions)
  - IPC event handling (mock `window.electronAPI`, verify store updates)
  - Permission/security flows
- Component rendering tests are optional — prioritize logic over snapshots.
- Mock the IPC bridge in tests, never the Zustand store internals.

---

## 14. Common Pitfalls

| Issue                           | Cause                                               | Rule                                                                    |
| ------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Stale state in IPC handler      | Closure captures old store reference                | Use `useAppStore.getState()` for latest state in callbacks              |
| Re-render storm                 | Subscribing to entire store or large objects        | Use `useShallow` selectors, select minimal slices                       |
| Missing translations            | Added EN key but forgot ZH                          | Always add both locale files simultaneously                             |
| Event silently dropped          | New ClientEvent type not in preload allowlist       | Add to `ALLOWED_CLIENT_EVENTS` in `src/preload/index.ts`                |
| Markdown XSS                    | Removed or reordered rehype-sanitize                | Never remove; always keep it last in rehype chain                       |
| Dark mode broken                | Used raw Tailwind colors instead of semantic tokens | Use `text-text-primary`, `bg-surface`, etc.                             |
| Permission dialog doesn't clear | Store update races with IPC event ordering          | See `AI_MAIN_PROCESS.md` — the fix is in execute wrappers, not renderer |
