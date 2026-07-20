import { describe, expect, it } from 'vitest';
import type { ModelThinkingLevel, ThinkingCapabilities } from '../src/renderer/types';
import { clampToSupportedLevel } from '../src/shared/thinking-levels';
import {
  apiConfigReducer,
  buildApiConfigDraftSignature,
  type ApiConfigState,
  type ApiConfigAction,
} from '../src/renderer/hooks/useApiConfigState';

// Minimal state shape for testing thinking-level reducer cases
function makeState(
  thinkingLevel: ModelThinkingLevel = 'off',
  supportsThinking = false
): ApiConfigState {
  return {
    presets: {} as ApiConfigState['presets'],
    profiles: {} as ApiConfigState['profiles'],
    activeProfileKey: 'anthropic' as ApiConfigState['activeProfileKey'],
    configSets: [],
    activeConfigSetId: 'default',
    pendingConfigSetAction: null,
    isMutatingConfigSet: false,
    lastCustomProtocol: 'anthropic',
    enableThinking: thinkingLevel !== 'off',
    thinkingLevel,
    thinkingCapabilities: {
      supportsThinking,
      levels: supportsThinking ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'],
    },
    discoveredModels: {},
    isLoadingConfig: false,
    savedDraftSignature: '',
    isSaving: false,
    isTesting: false,
    isRefreshingModels: false,
    isDiscoveringLocalOllama: false,
    errorText: '',
    errorKey: null,
    errorValues: undefined,
    successText: '',
    successKey: null,
    successValues: undefined,
    lastSaveCompletedAt: 0,
    testResult: null,
    diagnosticResult: null,
    isDiagnosing: false,
  };
}

function setCaps(state: ApiConfigState, caps: ThinkingCapabilities): ApiConfigState {
  return apiConfigReducer(state, {
    type: 'SET_THINKING_CAPABILITIES',
    payload: caps,
  } as ApiConfigAction);
}

function setLevel(state: ApiConfigState, level: ModelThinkingLevel): ApiConfigState {
  return apiConfigReducer(state, {
    type: 'SET_THINKING_LEVEL',
    payload: level,
  } as ApiConfigAction);
}

describe('apiConfigReducer — SET_THINKING_LEVEL', () => {
  it('sets thinkingLevel and derives enableThinking', () => {
    let s = makeState('off');
    s = setLevel(s, 'medium');
    expect(s.thinkingLevel).toBe('medium');
    expect(s.enableThinking).toBe(true);
  });

  it('setting off clears enableThinking', () => {
    let s = makeState('high', true);
    s = setLevel(s, 'off');
    expect(s.thinkingLevel).toBe('off');
    expect(s.enableThinking).toBe(false);
  });
});

describe('apiConfigReducer — SET_THINKING_CAPABILITIES', () => {
  // The stored level is the user's model-independent intent. Capabilities describe
  // the model. Folding one into the other corrupted the preference on every model
  // switch and left the form permanently dirty, which blocked config-set switching.
  it('never mutates the stored level, even when unsupported', () => {
    let s = makeState('max', true);
    s = setCaps(s, { supportsThinking: true, levels: ['off', 'low', 'medium'] });
    expect(s.thinkingLevel).toBe('max');
    expect(s.enableThinking).toBe(true);
    expect(s.thinkingCapabilities.levels).toEqual(['off', 'low', 'medium']);
  });

  it('never mutates the stored level when the model has no reasoning support', () => {
    // Switching to a non-reasoning model must not erase the preference — switching
    // back has to restore it.
    let s = makeState('high', true);
    s = setCaps(s, { supportsThinking: false, levels: ['off'] });
    expect(s.thinkingLevel).toBe('high');
    s = setCaps(s, { supportsThinking: true, levels: ['off', 'low', 'high'] });
    expect(s.thinkingLevel).toBe('high');
  });

  it('CLEAR_THINKING_CAPABILITIES never touches the stored level', () => {
    // Regression: the mount-time "no model yet" dispatch used to reset the level
    // to 'off', wiping the value just loaded from config.
    let s = makeState('high', true);
    s = apiConfigReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' } as ApiConfigAction);
    expect(s.thinkingLevel).toBe('high');
    expect(s.enableThinking).toBe(true);
    expect(s.thinkingCapabilities.supportsThinking).toBe(false);
  });

  it('survives the real mount sequence without losing the stored level', () => {
    // Reproduces the first reported bug: level shows Off and reverts after save.
    let s = makeState('high', true);
    // 1. mount — profiles still empty, so no model is resolvable yet
    s = apiConfigReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' } as ApiConfigAction);
    expect(s.thinkingLevel).toBe('high');

    // 2. capabilities arrive for the real model (z-ai/glm-5.1 via OpenRouter)
    const glm: ThinkingCapabilities = {
      supportsThinking: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
    };
    s = setCaps(s, glm);
    expect(s.thinkingLevel).toBe('high');

    // 3. user picks a different level; it sticks across a capability refresh
    s = setLevel(s, 'medium');
    s = setCaps(s, glm);
    expect(s.thinkingLevel).toBe('medium');
  });
});

describe('draft signature — capability loading must not dirty the form', () => {
  it('stays clean when the model cannot honour the stored level', () => {
    // Regression: clamping into state changed thinkingLevel, which is part of the
    // draft signature, so merely opening Settings marked the config set "unsaved"
    // and the unsaved-changes gate blocked switching to another config set.
    let s = makeState('max', true);
    const saved = buildApiConfigDraftSignature(s.activeProfileKey, s.profiles, 'max');

    s = apiConfigReducer(s, { type: 'CLEAR_THINKING_CAPABILITIES' } as ApiConfigAction);
    s = setCaps(s, {
      supportsThinking: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
    });

    expect(buildApiConfigDraftSignature(s.activeProfileKey, s.profiles, s.thinkingLevel)).toBe(
      saved
    );
  });

  it('stays clean on a model with no reasoning support', () => {
    let s = makeState('high', true);
    const saved = buildApiConfigDraftSignature(s.activeProfileKey, s.profiles, 'high');
    s = setCaps(s, { supportsThinking: false, levels: ['off'] });
    expect(buildApiConfigDraftSignature(s.activeProfileKey, s.profiles, s.thinkingLevel)).toBe(
      saved
    );
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
