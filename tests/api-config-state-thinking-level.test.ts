import { describe, expect, it } from 'vitest';
import type { ModelThinkingLevel, ThinkingCapabilities } from '../src/renderer/types';
import { clampToSupportedLevel } from '../src/shared/thinking-levels';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import {
  buildModelSetSavePayload,
  buildModelSetSignature,
  createModelSetsState,
  hasUnsavedModelSetChanges,
  modelSetsReducer,
  type ModelSetsState,
} from '../src/renderer/hooks/model-sets-state';

// The thinking level is a field of the config set, so it lives in the model-sets
// half of the form state.
function makeState(
  thinkingLevel: ModelThinkingLevel = 'off',
  supportsThinking = false
): ModelSetsState {
  const state = createModelSetsState(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      activeConfigSetId: 'default',
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          enableThinking: thinkingLevel !== 'off',
          thinkingLevel,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    } as never,
    FALLBACK_PROVIDER_PRESETS
  );
  // As the hook does once the config has loaded.
  const loaded = modelSetsReducer(state, {
    type: 'APPLY_PERSISTED',
    configSets: state.configSets,
    activeConfigSetId: state.activeConfigSetId,
    draft: state.draft,
  });
  return {
    ...loaded,
    thinkingCapabilities: {
      supportsThinking,
      levels: supportsThinking ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'],
    },
  };
}

function setCaps(state: ModelSetsState, caps: ThinkingCapabilities): ModelSetsState {
  return modelSetsReducer(state, { type: 'SET_THINKING_CAPABILITIES', payload: caps });
}

function setLevel(state: ModelSetsState, level: ModelThinkingLevel): ModelSetsState {
  return modelSetsReducer(state, { type: 'SET_THINKING_LEVEL', payload: level });
}

describe('modelSetsReducer — SET_THINKING_LEVEL', () => {
  it('sets the level, and the save payload derives enableThinking from it', () => {
    let s = makeState('off');
    s = setLevel(s, 'medium');
    expect(s.draft.thinkingLevel).toBe('medium');
    expect(buildModelSetSavePayload(s.draft, 'default')).toMatchObject({
      thinkingLevel: 'medium',
      enableThinking: true,
    });
  });

  it('setting off clears enableThinking', () => {
    let s = makeState('high', true);
    s = setLevel(s, 'off');
    expect(s.draft.thinkingLevel).toBe('off');
    expect(buildModelSetSavePayload(s.draft, 'default')).toMatchObject({
      thinkingLevel: 'off',
      enableThinking: false,
    });
  });

  it('counts a changed level as an unsaved change', () => {
    let s = makeState('off');
    expect(hasUnsavedModelSetChanges(s)).toBe(false);
    s = setLevel(s, 'high');
    expect(hasUnsavedModelSetChanges(s)).toBe(true);
  });
});

describe('modelSetsReducer — SET_THINKING_CAPABILITIES', () => {
  // The stored level is the user's model-independent intent. Capabilities describe
  // the model. Folding one into the other corrupted the preference on every model
  // switch and left the form permanently dirty, which blocked config-set switching.
  it('never mutates the stored level, even when unsupported', () => {
    let s = makeState('max', true);
    s = setCaps(s, { supportsThinking: true, levels: ['off', 'low', 'medium'] });
    expect(s.draft.thinkingLevel).toBe('max');
    expect(s.thinkingCapabilities.levels).toEqual(['off', 'low', 'medium']);
  });

  it('never mutates the stored level when the model has no reasoning support', () => {
    // Switching to a non-reasoning model must not erase the preference — switching
    // back has to restore it.
    let s = makeState('high', true);
    s = setCaps(s, { supportsThinking: false, levels: ['off'] });
    expect(s.draft.thinkingLevel).toBe('high');
    s = setCaps(s, { supportsThinking: true, levels: ['off', 'low', 'high'] });
    expect(s.draft.thinkingLevel).toBe('high');
  });

  it('CLEAR_THINKING_CAPABILITIES never touches the stored level', () => {
    // Regression: the mount-time "no model yet" dispatch used to reset the level
    // to 'off', wiping the value just loaded from config.
    let s = makeState('high', true);
    s = modelSetsReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' });
    expect(s.draft.thinkingLevel).toBe('high');
    expect(s.thinkingCapabilities.supportsThinking).toBe(false);
  });

  it('survives the real mount sequence without losing the stored level', () => {
    // Reproduces the first reported bug: level shows Off and reverts after save.
    let s = makeState('high', true);
    // 1. mount — no model is resolvable yet
    s = modelSetsReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' });
    expect(s.draft.thinkingLevel).toBe('high');

    // 2. capabilities arrive for the real model (z-ai/glm-5.1 via OpenRouter)
    const glm: ThinkingCapabilities = {
      supportsThinking: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
    };
    s = setCaps(s, glm);
    expect(s.draft.thinkingLevel).toBe('high');

    // 3. user picks a different level; it sticks across a capability refresh
    s = setLevel(s, 'medium');
    s = setCaps(s, glm);
    expect(s.draft.thinkingLevel).toBe('medium');
  });
});

describe('draft signature — capability loading must not dirty the form', () => {
  it('stays clean when the model cannot honour the stored level', () => {
    // Regression: clamping into state changed thinkingLevel, which is part of the
    // draft signature, so merely opening Settings marked the config set "unsaved"
    // and the unsaved-changes gate blocked switching to another config set.
    let s = makeState('max', true);
    const saved = buildModelSetSignature(s.draft);

    s = modelSetsReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' });
    s = setCaps(s, {
      supportsThinking: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
    });

    expect(buildModelSetSignature(s.draft)).toBe(saved);
    expect(hasUnsavedModelSetChanges(s)).toBe(false);
  });

  it('stays clean on a model with no reasoning support', () => {
    let s = makeState('high', true);
    const saved = buildModelSetSignature(s.draft);
    s = setCaps(s, { supportsThinking: false, levels: ['off'] });
    expect(buildModelSetSignature(s.draft)).toBe(saved);
    expect(hasUnsavedModelSetChanges(s)).toBe(false);
  });
});

describe('clampToSupportedLevel — display clamp, mirrors pi', () => {
  const LOW_MID: ModelThinkingLevel[] = ['off', 'low', 'medium'];

  it('preserves a supported level', () => {
    expect(clampToSupportedLevel(['off', 'low', 'medium', 'high'], 'medium')).toBe('medium');
  });

  it('clamps downward when nothing higher is supported', () => {
    expect(clampToSupportedLevel(LOW_MID, 'high')).toBe('medium');
  });

  it('clamps upward in preference to downward, matching pi', () => {
    expect(clampToSupportedLevel(LOW_MID, 'minimal')).toBe('low');
  });

  it('prefers upward even when a lower level is also available (pi parity)', () => {
    // A down-then-up search returns 'minimal' here; pi's clampThinkingLevel
    // returns 'high'. Verified against pi-ai/dist/models.js:404-422 (0.80.10).
    expect(clampToSupportedLevel(['off', 'minimal', 'high'], 'low')).toBe('high');
  });

  it('falls back to off when no non-off level is supported', () => {
    expect(clampToSupportedLevel(['off'], 'xhigh')).toBe('off');
  });

  it('keeps off as off when the model supports thinking', () => {
    // Display must never show an opted-out user as opted in.
    expect(clampToSupportedLevel(['off', 'minimal', 'medium'], 'off')).toBe('off');
  });
});
