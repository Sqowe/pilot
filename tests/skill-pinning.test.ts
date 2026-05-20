/**
 * Tests for the skill pinning feature.
 * Covers: validation, limits, IPC wiring, UI integration, and shared constants.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_PINNED_SKILLS_PER_SESSION,
  MAX_SKILL_ID_LENGTH,
  SAFE_SKILL_ID_REGEX,
  isValidSkillId,
} from '../src/shared/skill-pinning-constants';

const sessionManagerPath = path.resolve(__dirname, '../src/main/session/session-manager.ts');
const agentRunnerPath = path.resolve(__dirname, '../src/main/claude/agent-runner.ts');
const preloadPath = path.resolve(__dirname, '../src/preload/index.ts');
const mainIndexPath = path.resolve(__dirname, '../src/main/index.ts');
const welcomeViewPath = path.resolve(__dirname, '../src/renderer/components/WelcomeView.tsx');
const contextPanelPath = path.resolve(__dirname, '../src/renderer/components/ContextPanel.tsx');
const typesPath = path.resolve(__dirname, '../src/renderer/types/index.ts');

const sessionManagerSource = fs.readFileSync(sessionManagerPath, 'utf8');
const agentRunnerSource = fs.readFileSync(agentRunnerPath, 'utf8');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const mainIndexSource = fs.readFileSync(mainIndexPath, 'utf8');
const welcomeViewSource = fs.readFileSync(welcomeViewPath, 'utf8');
const contextPanelSource = fs.readFileSync(contextPanelPath, 'utf8');
const typesSource = fs.readFileSync(typesPath, 'utf8');

describe('skill pinning: shared constants (behavioral)', () => {
  it('MAX_PINNED_SKILLS_PER_SESSION is a reasonable limit', () => {
    expect(MAX_PINNED_SKILLS_PER_SESSION).toBeGreaterThanOrEqual(5);
    expect(MAX_PINNED_SKILLS_PER_SESSION).toBeLessThanOrEqual(20);
  });

  it('MAX_SKILL_ID_LENGTH prevents excessively long IDs', () => {
    expect(MAX_SKILL_ID_LENGTH).toBeLessThanOrEqual(256);
    expect(MAX_SKILL_ID_LENGTH).toBeGreaterThanOrEqual(32);
  });

  describe('isValidSkillId', () => {
    it('accepts valid skill IDs', () => {
      expect(isValidSkillId('semantic-index')).toBe(true);
      expect(isValidSkillId('firecrawl')).toBe(true);
      expect(isValidSkillId('cowork-memory')).toBe(true);
      expect(isValidSkillId('my.skill.v2')).toBe(true);
      expect(isValidSkillId('skill_name')).toBe(true);
      expect(isValidSkillId('ABC123')).toBe(true);
    });

    it('rejects empty strings', () => {
      expect(isValidSkillId('')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isValidSkillId(null)).toBe(false);
      expect(isValidSkillId(undefined)).toBe(false);
      expect(isValidSkillId(123)).toBe(false);
      expect(isValidSkillId({})).toBe(false);
    });

    it('rejects IDs with prompt-injection characters', () => {
      expect(isValidSkillId('skill</pinned_skills>')).toBe(false);
      expect(isValidSkillId('skill\ninjection')).toBe(false);
      expect(isValidSkillId('skill with spaces')).toBe(false);
      expect(isValidSkillId('<script>alert(1)</script>')).toBe(false);
      expect(isValidSkillId('skill;rm -rf /')).toBe(false);
    });

    it('rejects IDs exceeding max length', () => {
      const longId = 'a'.repeat(MAX_SKILL_ID_LENGTH + 1);
      expect(isValidSkillId(longId)).toBe(false);
      // Exactly at limit should pass
      const maxId = 'a'.repeat(MAX_SKILL_ID_LENGTH);
      expect(isValidSkillId(maxId)).toBe(true);
    });
  });

  describe('SAFE_SKILL_ID_REGEX', () => {
    it('matches only safe characters', () => {
      expect(SAFE_SKILL_ID_REGEX.test('valid-id')).toBe(true);
      expect(SAFE_SKILL_ID_REGEX.test('valid.id')).toBe(true);
      expect(SAFE_SKILL_ID_REGEX.test('valid_id')).toBe(true);
      expect(SAFE_SKILL_ID_REGEX.test('invalid id')).toBe(false);
      expect(SAFE_SKILL_ID_REGEX.test('invalid\nid')).toBe(false);
      expect(SAFE_SKILL_ID_REGEX.test('invalid<id>')).toBe(false);
    });
  });
});

describe('skill pinning: session-manager integration', () => {
  it('uses shared isValidSkillId for validation', () => {
    expect(sessionManagerSource).toContain('import {');
    expect(sessionManagerSource).toContain('isValidSkillId');
    expect(sessionManagerSource).toContain('MAX_PINNED_SKILLS_PER_SESSION');
  });

  it('enforces MAX_PINNED_SKILLS_PER_SESSION limit on toggle', () => {
    expect(sessionManagerSource).toContain('pinnedSet.size >= MAX_PINNED_SKILLS_PER_SESSION');
    expect(sessionManagerSource).toContain(
      `Cannot pin more than \${MAX_PINNED_SKILLS_PER_SESSION} skills per session`
    );
  });

  it('enforces limit on initialPinnedSkills in startSession', () => {
    expect(sessionManagerSource).toContain('pinnedSet.size >= MAX_PINNED_SKILLS_PER_SESSION');
  });

  it('applies initial pinned skills before enqueueing prompt', () => {
    const pinBlock = sessionManagerSource.indexOf(
      'initialPinnedSkills && initialPinnedSkills.length > 0'
    );
    const enqueue = sessionManagerSource.indexOf('this.enqueuePrompt(session, prompt');
    expect(pinBlock).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(pinBlock);
  });

  it('cleans up pinned skills on session delete', () => {
    const matches = sessionManagerSource.match(/this\.sessionPinnedSkills\.delete\(sessionId\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('skill pinning: agent-runner directive generation', () => {
  it('imports SAFE_SKILL_ID_REGEX from shared constants', () => {
    expect(agentRunnerSource).toContain('import { SAFE_SKILL_ID_REGEX }');
  });

  it('uses shared regex for sanitization', () => {
    expect(agentRunnerSource).toContain('SAFE_SKILL_ID_REGEX.test(id)');
  });

  it('builds directive with XML tags', () => {
    expect(agentRunnerSource).toContain('<pinned_skills>');
    expect(agentRunnerSource).toContain('</pinned_skills>');
  });

  it('returns empty string when no valid pinned skills', () => {
    expect(agentRunnerSource).toContain("if (sanitizedIds.length === 0) return ''");
  });

  it('injects directive into coworkAppendPrompt assembly', () => {
    expect(agentRunnerSource).toContain('this.buildPinnedSkillsDirective(session.id)');
  });
});

describe('skill pinning: IPC bridge', () => {
  it('exposes skills.toggleSessionPin in preload', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('skills.toggleSessionPin'");
  });

  it('exposes skills.getSessionPinnedSkills in preload', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('skills.getSessionPinnedSkills'");
  });

  it('validates skill existence before pinning in main handler', () => {
    expect(mainIndexSource).toContain('Skill not found');
    expect(mainIndexSource).toContain('Skill is disabled');
  });

  it('passes initialPinnedSkills to sm.startSession', () => {
    expect(mainIndexSource).toContain('event.payload.initialPinnedSkills');
  });
});

describe('skill pinning: types', () => {
  it('session.start payload includes initialPinnedSkills', () => {
    expect(typesSource).toContain('initialPinnedSkills?: string[]');
  });
});

describe('skill pinning: renderer WelcomeView', () => {
  it('loads available skills on mount', () => {
    expect(welcomeViewSource).toContain('window.electronAPI?.skills?.getAll()');
  });

  it('passes initialPinnedSkills to startSession', () => {
    expect(welcomeViewSource).toContain(
      'pinnedSkillIds.size > 0 ? Array.from(pinnedSkillIds) : undefined'
    );
  });

  it('renders skill pinning section', () => {
    expect(welcomeViewSource).toContain('Skill Pinning Picker');
  });

  it('enforces MAX_PINNED_SKILLS_PER_SESSION limit client-side', () => {
    expect(welcomeViewSource).toContain('MAX_PINNED_SKILLS_PER_SESSION');
    // Disables buttons when at limit
    expect(welcomeViewSource).toContain('pinnedSkillIds.size >= MAX_PINNED_SKILLS_PER_SESSION');
    // Prevents adding in state updater
    expect(welcomeViewSource).toContain(
      'if (next.size >= MAX_PINNED_SKILLS_PER_SESSION) return prev'
    );
  });

  it('shows count/limit in summary line', () => {
    expect(welcomeViewSource).toContain('MAX_PINNED_SKILLS_PER_SESSION');
  });
});

describe('skill pinning: renderer ContextPanel', () => {
  it('loads pinned skills for active session', () => {
    expect(contextPanelSource).toContain(
      'window.electronAPI?.skills?.getSessionPinnedSkills(activeSessionId)'
    );
  });

  it('renders unavailable pinned skills with fallback', () => {
    expect(contextPanelSource).toContain('Array.from(sessionPinnedSkills)');
    expect(contextPanelSource).toContain('(unavailable)');
  });

  it('shows section when pinned skills exist even if no available skills', () => {
    expect(contextPanelSource).toContain(
      'availableSkills.length > 0 || sessionPinnedSkills.size > 0'
    );
  });

  it('enforces MAX_PINNED_SKILLS_PER_SESSION limit on add buttons', () => {
    expect(contextPanelSource).toContain('MAX_PINNED_SKILLS_PER_SESSION');
    expect(contextPanelSource).toContain(
      'sessionPinnedSkills.size < MAX_PINNED_SKILLS_PER_SESSION'
    );
  });
});

describe('skill pinning: validation parity (initial vs runtime)', () => {
  it('session.start handler validates initialPinnedSkills against installed skills', () => {
    // main/index.ts must filter initialPinnedSkills against skillsManager before passing to startSession
    expect(mainIndexSource).toContain('skillsManager.getAllSkills()');
    expect(mainIndexSource).toContain('enabledSkillIds.has(id)');
    expect(mainIndexSource).toContain('validatedPinnedSkills');
  });

  it('skills.toggleSessionPin handler validates skill exists and is enabled', () => {
    expect(mainIndexSource).toContain('Skill not found');
    expect(mainIndexSource).toContain('Skill is disabled');
  });

  it('both paths use the same shared isValidSkillId for format validation', () => {
    // session-manager uses isValidSkillId (imported from shared constants)
    expect(sessionManagerSource).toContain('isValidSkillId');
    // agent-runner uses SAFE_SKILL_ID_REGEX (imported from shared constants)
    expect(agentRunnerSource).toContain('SAFE_SKILL_ID_REGEX');
  });

  it('both paths enforce MAX_PINNED_SKILLS_PER_SESSION', () => {
    // toggleSessionPinnedSkill enforces limit
    expect(sessionManagerSource).toContain('MAX_PINNED_SKILLS_PER_SESSION');
    // startSession initial pin also enforces limit
    const startSessionBlock = sessionManagerSource.slice(
      sessionManagerSource.indexOf('initialPinnedSkills && initialPinnedSkills.length > 0'),
      sessionManagerSource.indexOf('this.enqueuePrompt(session, prompt')
    );
    expect(startSessionBlock).toContain('MAX_PINNED_SKILLS_PER_SESSION');
  });

  it('directives are only injected for sanitized IDs (defense-in-depth)', () => {
    expect(agentRunnerSource).toContain(
      'pinnedSkillIds.filter((id) => SAFE_SKILL_ID_REGEX.test(id))'
    );
    expect(agentRunnerSource).toContain("if (sanitizedIds.length === 0) return ''");
  });
});
