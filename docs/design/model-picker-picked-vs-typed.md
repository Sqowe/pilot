# Model picker — picked vs typed, and the two model lists

**Created:** 2026-10-23
**Status:** implemented
**Related:** [`pi-sdk-140-uplift-and-adoption-plan.md`](./pi-sdk-140-uplift-and-adoption-plan.md)
§7.1 and §7.3 — the two findings this note closes.

---

## 1. The problem

The app knows a provider's models in **two lists**, and they are not the same length:

| List                  | Where it comes from                                         | OpenRouter | Anthropic |
| --------------------- | ----------------------------------------------------------- | ---------- | --------- |
| The **catalogue**     | pi's model registry, over IPC (`config.getProviderCatalog`) | 401 models | 17 models |
| The **curated picks** | hand-written in `src/shared/api-model-presets.ts`           | 12 models  | 7 models  |

The picker shows the **catalogue** (`src/renderer/hooks/useModelSetForm.ts:142`). The
curated picks are what the app falls back to before the catalogue arrives, and the first
entry of them is the default model of a new set.

But `splitModelSelection` (`src/renderer/hooks/api-config-shared.ts:418`) decided whether a
stored model is shown as **picked** (in the list) or **typed** (in a text field) by asking
the **curated** list. So every stored model outside those twelve opened as typed — and
since a builtin cloud provider's catalogue entry sets `manualModelToggle: false`
(`src/shared/provider-catalog.ts:90`), the "Preset / Custom" toggle was not rendered
either: the user was left typing an id, with no visible way back to the list.

389 of the 401 OpenRouter models and 10 of the 17 Anthropic ones were affected. The model
id itself was never lost — `finalModelOf` returns the typed value — only the control was
wrong.

A second, older problem sat in the same lists: `claude-3-7-sonnet-latest` was in the
hand-written Anthropic lists, and had been for two pi releases after Anthropic's catalogue
dropped it. In the fallback list the app offered a model id no catalogue knows.

## 2. The decision

**The split consults the list the picker shows.** A stored model that the catalogue offers
is picked, whatever the curated lists say. The curated list stays what it is good at: the
fallback before the catalogue arrives, and the source of the default model.

**A curated pick must exist in pi's catalogue.** A pick the catalogue does not have cannot
be resolved to a model — no context window, no price, no thinking levels — so it is
offered next to models that do. The curated lists are hand-written and drift; a test now
holds them against the installed pi.

## 3. As built

### 3.1 The catalogue travels with the loaded config

The split is decided when a set is loaded into the form
(`hydrateModelSetDraft` → `splitModelSelection`), so the catalogue has to be there at that
moment. It is loaded in the same pass as the config, and the caller's own state is still
the previous one when the load reports back — so the catalogue is handed over with the
config instead of being read from state:

```
useApiConfigSource  →  onLoaded(config, presets, catalogue)
  → useApiSettingsState.applyLoadedRef.current  →  applySetsConfig(config, presets, 'reset', catalogue)
    → useModelSets.applyPersistedConfig          →  buildModelSetsBootstrap(config, presets, catalogue)
      → hydrateModelSetDraft(set, presets, endpoints, catalogue)
        → splitModelSelection(..., catalogueModels)
```

`useModelSets` keeps the catalogue in a ref (assigned during render), so a later
re-hydration — a set switch, a save — uses the current one.

### 3.2 The split

```ts
const isPicked =
  presetModels.some((item) => item.id === modelValue) ||
  (catalogueModels ?? []).some((item) => item.id === modelValue);
```

The preset list stays in the test because the catalogue may not have arrived yet: before it
does, the curated list is all the app knows.

### 3.3 The stale pick

`claude-3-7-sonnet-latest` is gone from both hand-written lists.

### 3.4 What did not change

- **A custom endpoint's model stays typed.** It has no list to pick from — its models are
  whatever its owner serves — and a catalogue entry that happens to share the id must not
  put it behind a picker the form does not show.
- **Ollama is untouched.** Its models come from discovery, not from a catalogue, and it
  has the "use detected models" toggle.
- **The curated lists keep their other jobs**: the fallback before the catalogue arrives,
  and the default model of a new set (the first entry).

## 4. Tests

- `tests/api-config-state-config-sets.test.ts` — a catalogue model opens as picked; a
  model in neither list stays typed; a model outside the curated list stays typed while
  the catalogue has not arrived; a custom endpoint stays typed even when the catalogue
  lists its model.
- `tests/api-model-presets-vs-pi-catalog.test.ts` — every curated pick exists in the
  installed pi's catalogue. Reads the installed pi on purpose, like
  `provider-setups-vs-catalog.test.ts`; the failure message says what to do.
- `tests/config-ipc-mutation-contract.test.ts` — the catalogue reaches the load handler
  with the config, so it cannot be dropped from the wiring again.

## 5. Left open

The catalogue is a snapshot of pi's registry, and pi's registry lags OpenRouter's live
list (401 against 468). A model published after the snapshot still cannot be picked, and a
builtin cloud provider cannot be typed into. That is a separate decision — see
`pi-sdk-140-uplift-and-adoption-plan.md` §7.2.
