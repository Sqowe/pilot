import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isValidSystemPromptFileChoice,
  loadWorkspaceSystemPrompt,
  resolveWorkspaceInstructionsConfig,
  computeWorkspaceInstructionsStatus,
  MAX_BYTES,
  SYSTEM_PROMPT_FILE_CHOICES,
} from '../src/main/utils/workspace-system-prompt';
import {
  isValidSystemPromptPriority,
  normalizeSystemPromptPriority,
} from '../src/shared/system-prompt-file-choices';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cowork-sp-${prefix}-`));
}

describe('isValidSystemPromptFileChoice', () => {
  it('accepts every whitelisted choice', () => {
    for (const choice of SYSTEM_PROMPT_FILE_CHOICES) {
      expect(isValidSystemPromptFileChoice(choice)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isValidSystemPromptFileChoice('README.md')).toBe(false);
    expect(isValidSystemPromptFileChoice('../etc/passwd')).toBe(false);
    expect(isValidSystemPromptFileChoice(null)).toBe(false);
    expect(isValidSystemPromptFileChoice(undefined)).toBe(false);
    expect(isValidSystemPromptFileChoice(42)).toBe(false);
  });
});

describe('loadWorkspaceSystemPrompt', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp('root');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('returns null when no choice is configured', async () => {
    expect(await loadWorkspaceSystemPrompt(tmpRoot, '')).toBeNull();
    expect(await loadWorkspaceSystemPrompt(tmpRoot, undefined)).toBeNull();
  });

  it('returns null for unknown or unsafe choices', async () => {
    expect(await loadWorkspaceSystemPrompt(tmpRoot, 'README.md')).toBeNull();
    expect(await loadWorkspaceSystemPrompt(tmpRoot, '../etc/passwd')).toBeNull();
    expect(await loadWorkspaceSystemPrompt(tmpRoot, '/etc/passwd')).toBeNull();
  });

  it('returns null when cwd is missing or empty', async () => {
    expect(await loadWorkspaceSystemPrompt(undefined, 'CLAUDE.md')).toBeNull();
    expect(await loadWorkspaceSystemPrompt('', 'CLAUDE.md')).toBeNull();
  });

  it('returns null when the file does not exist', async () => {
    expect(await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md')).toBeNull();
  });

  it('loads and trims a present file and emits a fingerprint', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '  project rules here  \n\n');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('project rules here');
    expect(result!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null when the file is empty or only whitespace', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '   \n\n   ');
    expect(await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md')).toBeNull();
  });

  it('handles nested .cowork/instructions.md choice', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.cowork'));
    fs.writeFileSync(path.join(tmpRoot, '.cowork', 'instructions.md'), 'nested guidance');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, '.cowork/instructions.md');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('nested guidance');
  });

  it('returns null for a directory at the chosen name', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'CLAUDE.md'));
    expect(await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md')).toBeNull();
  });

  it('truncates files larger than MAX_BYTES and marks the output', async () => {
    const big = 'x'.repeat(MAX_BYTES + 1024);
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), big);
    const result = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(MAX_BYTES + 200);
    expect(result!.text).toContain('truncated');
  });

  it('fingerprint changes when file contents change', async () => {
    const filePath = path.join(tmpRoot, 'CLAUDE.md');
    fs.writeFileSync(filePath, 'original rules');
    const first = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(first).not.toBeNull();

    fs.writeFileSync(filePath, 'updated rules — more content');
    const second = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(second).not.toBeNull();
    expect(second!.fingerprint).not.toBe(first!.fingerprint);
  });

  it('fingerprint changes on same-size edits (independent of mtime resolution)', async () => {
    // Regression guard for coarse-mtime filesystems: a single-character swap
    // keeps the file size identical and may land within one timestamp tick,
    // yet the fingerprint must still change because it is content-derived.
    const filePath = path.join(tmpRoot, 'CLAUDE.md');
    fs.writeFileSync(filePath, 'rule-A');
    const first = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(first).not.toBeNull();

    fs.writeFileSync(filePath, 'rule-B');
    // Pin mtime back to the pre-edit value to simulate a filesystem that
    // didn't register the change in its coarse mtime.
    const statBefore = fs.statSync(filePath);
    fs.utimesSync(filePath, statBefore.atime, new Date(statBefore.mtimeMs - 5000));

    const second = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(second).not.toBeNull();
    expect(second!.fingerprint).not.toBe(first!.fingerprint);
  });

  it('fingerprint is stable across reads of an unchanged file', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'stable');
    const a = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    const b = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });

  it('rejects symlinks pointing outside cwd', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const outside = mktmp('outside');
    try {
      fs.writeFileSync(path.join(outside, 'evil.md'), 'should not be read');
      fs.symlinkSync(path.join(outside, 'evil.md'), path.join(tmpRoot, 'CLAUDE.md'));
      expect(await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md')).toBeNull();
    } finally {
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('accepts symlinks that stay within cwd', async () => {
    if (process.platform === 'win32') {
      return;
    }
    fs.writeFileSync(path.join(tmpRoot, 'real.md'), 'inner content');
    fs.symlinkSync(path.join(tmpRoot, 'real.md'), path.join(tmpRoot, 'CLAUDE.md'));
    const result = await loadWorkspaceSystemPrompt(tmpRoot, 'CLAUDE.md');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('inner content');
  });
});

describe('loadWorkspaceSystemPrompt — priority-list form', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp('priority');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('returns null when enabled=false regardless of files present', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rules');
    expect(await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], false)).toBeNull();
  });

  it('returns null when cwd is missing', async () => {
    expect(await loadWorkspaceSystemPrompt(undefined, ['CLAUDE.md'], true)).toBeNull();
    expect(await loadWorkspaceSystemPrompt('', ['CLAUDE.md'], true)).toBeNull();
  });

  it('returns null when cwd points to a file (non-directory)', async () => {
    const filePath = path.join(tmpRoot, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'content');
    expect(await loadWorkspaceSystemPrompt(filePath, ['CLAUDE.md'], true)).toBeNull();
  });

  it('returns null when cwd does not exist', async () => {
    expect(
      await loadWorkspaceSystemPrompt('/nonexistent/path/xyz', ['CLAUDE.md'], true)
    ).toBeNull();
  });

  it('returns null when no candidate exists', async () => {
    const result = await loadWorkspaceSystemPrompt(
      tmpRoot,
      ['CLAUDE.md', 'AGENTS.md', 'memory.md'],
      true
    );
    expect(result).toBeNull();
  });

  it('first existing candidate wins', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rules');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'claude rules');
    // CLAUDE.md is listed first — it should win
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('claude rules');
    expect(result!.resolvedFile).toBe('CLAUDE.md');
  });

  it('falls through to next candidate when higher-priority file is absent', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rules');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('agents rules');
    expect(result!.resolvedFile).toBe('AGENTS.md');
  });

  it('falls through when higher-priority file is empty', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '   ');
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rules');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('AGENTS.md');
    expect(result!.text).toBe('agents rules');
  });

  it('resolvedFile reflects the winning candidate', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.cowork'));
    fs.writeFileSync(path.join(tmpRoot, '.cowork', 'instructions.md'), 'cowork rules');
    const result = await loadWorkspaceSystemPrompt(
      tmpRoot,
      ['CLAUDE.md', 'AGENTS.md', '.cowork/instructions.md'],
      true
    );
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('.cowork/instructions.md');
    expect(result!.text).toBe('cowork rules');
  });

  it('fingerprint changes when the winning file changes content', async () => {
    const filePath = path.join(tmpRoot, 'AGENTS.md');
    fs.writeFileSync(filePath, 'v1');
    const first = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    fs.writeFileSync(filePath, 'v2');
    const second = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(first!.fingerprint).not.toBe(second!.fingerprint);
  });

  it('reordering priority with same files yields different winner', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'claude');
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents');

    const r1 = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    const r2 = await loadWorkspaceSystemPrompt(tmpRoot, ['AGENTS.md', 'CLAUDE.md'], true);

    expect(r1!.resolvedFile).toBe('CLAUDE.md');
    expect(r2!.resolvedFile).toBe('AGENTS.md');
    expect(r1!.fingerprint).not.toBe(r2!.fingerprint);
  });

  it('skips invalid/off-whitelist entries and falls through', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'claude rules');
    // 'README.md' is off-whitelist — should be skipped, not crash
    const result = await loadWorkspaceSystemPrompt(
      tmpRoot,
      ['README.md' as never, 'CLAUDE.md'],
      true
    );
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('CLAUDE.md');
  });

  it('does not throw and skips non-string entries in priority array', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rules');
    // Mixed array with non-string entries — must not throw, must find AGENTS.md
    const result = await loadWorkspaceSystemPrompt(
      tmpRoot,
      [123 as never, null as never, 'AGENTS.md'],
      true
    );
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('AGENTS.md');
  });

  it('does not throw and returns null when priority is a non-array', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rules');
    // Non-array falls to legacy branch; undefined/null is not a valid choice
    // so it returns null without throwing.
    await expect(loadWorkspaceSystemPrompt(tmpRoot, undefined as never, true)).resolves.toBeNull();
  });

  it('does not throw and returns null for an empty string entry', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rules');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['' as never, 'CLAUDE.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('CLAUDE.md');
  });

  it('priority-list: skips candidate that is a symlink escaping workspace', async () => {
    if (process.platform === 'win32') return;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sp-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'evil.md'), 'should not be read');
      // AGENTS.md is a symlink pointing outside cwd
      fs.symlinkSync(path.join(outside, 'evil.md'), path.join(tmpRoot, 'AGENTS.md'));
      fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'safe content');
      // AGENTS.md should be skipped; CLAUDE.md should be loaded
      const result = await loadWorkspaceSystemPrompt(tmpRoot, ['AGENTS.md', 'CLAUDE.md'], true);
      expect(result).not.toBeNull();
      expect(result!.resolvedFile).toBe('CLAUDE.md');
      expect(result!.text).toBe('safe content');
    } finally {
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('priority-list: skips candidate that is a directory and falls through', async () => {
    // CLAUDE.md is a directory — should be skipped
    fs.mkdirSync(path.join(tmpRoot, 'CLAUDE.md'));
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'agents rules');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('AGENTS.md');
  });

  it('priority-list: whitespace-only entries are trimmed and skipped', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'rules');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['  ' as never, 'CLAUDE.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('CLAUDE.md');
  });

  it('legacy single-choice form still works and sets resolvedFile to empty string', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), 'legacy rules');
    // Two-arg (legacy) call
    const result = await loadWorkspaceSystemPrompt(tmpRoot, 'AGENTS.md');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('legacy rules');
    expect(result!.resolvedFile).toBe('');
  });
});

describe('resolveWorkspaceInstructionsConfig', () => {
  function makeStore(values: Record<string, unknown>) {
    return {
      get: (key: 'systemPromptFileEnabled' | 'systemPromptFilePriority' | 'systemPromptFile') =>
        values[key],
    };
  }

  it('new keys present → uses them with strict boolean coercion', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({
        systemPromptFileEnabled: true,
        systemPromptFilePriority: ['CLAUDE.md', 'AGENTS.md'],
      })
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('enabled=false (strict) → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: false, systemPromptFilePriority: ['CLAUDE.md'] })
    );
    expect(cfg.enabled).toBe(false);
  });

  it('truthy non-boolean "true" string with priority present → disabled (non-boolean treated as absent → no infer from priority? No — treated as invalid)', () => {
    // Non-boolean, non-null → disabled (corrupt value must not enable)
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: 'true', systemPromptFilePriority: ['CLAUDE.md'] })
    );
    expect(cfg.enabled).toBe(false);
  });

  it('truthy non-boolean 1 with priority present → disabled (non-boolean, non-null → disabled)', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: 1, systemPromptFilePriority: ['CLAUDE.md'] })
    );
    expect(cfg.enabled).toBe(false);
  });

  it('non-boolean "false" string with priority present → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: 'false', systemPromptFilePriority: ['CLAUDE.md'] })
    );
    expect(cfg.enabled).toBe(false);
  });

  it('explicit boolean false with priority present → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: false, systemPromptFilePriority: ['CLAUDE.md'] })
    );
    expect(cfg.enabled).toBe(false);
  });

  it('new priority key present but empty + legacy file set → new config wins, disabled', () => {
    // Empty priority array means new config is present but no candidates configured.
    // Legacy fallback must NOT activate — new config always wins.
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFilePriority: [], systemPromptFile: 'CLAUDE.md' })
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority).toEqual([]);
  });

  it('filters non-string entries out of priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({
        systemPromptFileEnabled: true,
        systemPromptFilePriority: ['CLAUDE.md', 42, null, 'AGENTS.md'],
      })
    );
    expect(cfg.priority).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('legacy fallback: new keys absent, legacy file set → enabled + single-entry priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: 'CLAUDE.md' }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority).toEqual(['CLAUDE.md']);
  });

  it('legacy fallback: legacy="" → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: '' }));
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority).toEqual([]);
  });

  it('legacy fallback: no keys at all → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({}));
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority).toEqual([]);
  });

  it('legacy fallback: off-whitelist legacy file → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: 'README.md' }));
    expect(cfg.enabled).toBe(false);
  });

  it('partial config: priority present, enabled absent → infer enabled=true', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFilePriority: ['CLAUDE.md', 'AGENTS.md'] })
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('partial config: priority present but empty, enabled absent → disabled', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFilePriority: [] }));
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority).toEqual([]);
  });

  it('partial config: enabled=true but priority non-array → enabled, empty priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({ systemPromptFileEnabled: true, systemPromptFilePriority: 'CLAUDE.md' })
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getStatus shape — IPC payload contract
// ---------------------------------------------------------------------------

describe('loadWorkspaceSystemPrompt — getStatus payload contract', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-status-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('disabled → resolvedFile is empty string', async () => {
    // Mirrors the { configuredFile: '', resolvedFile: '', loaded: false } path.
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md'], false);
    expect(result).toBeNull();
    // Callers must emit resolvedFile: '' when result is null — verified in
    // index.ts; here we confirm null is the signal.
  });

  it('no file present → null (caller emits resolvedFile: empty string)', async () => {
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).toBeNull();
  });

  it('file configured and present → resolvedFile matches winning candidate', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# Agent instructions\n');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md', 'AGENTS.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('AGENTS.md');
    expect(typeof result!.fingerprint).toBe('string');
    expect(result!.fingerprint.length).toBeGreaterThan(0);
  });

  it('first-by-priority wins when multiple files exist', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '# Claude instructions\n');
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# Agent instructions\n');
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['AGENTS.md', 'CLAUDE.md'], true);
    expect(result!.resolvedFile).toBe('AGENTS.md');
  });

  it('truncated file → resolvedFile still set', async () => {
    const big = Buffer.alloc(MAX_BYTES + 100, 'x');
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), big);
    const result = await loadWorkspaceSystemPrompt(tmpRoot, ['CLAUDE.md'], true);
    expect(result).not.toBeNull();
    expect(result!.resolvedFile).toBe('CLAUDE.md');
    expect(result!.text).toContain('[... truncated');
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceInstructionsConfig — legacy migration compatibility
// ---------------------------------------------------------------------------

describe('resolveWorkspaceInstructionsConfig — legacy migration', () => {
  function makeStore(data: Record<string, unknown>) {
    return {
      get: (key: string) =>
        Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined,
    } as Parameters<typeof resolveWorkspaceInstructionsConfig>[0];
  }

  it('legacy systemPromptFile=CLAUDE.md → enabled=true, CLAUDE.md first in priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: 'CLAUDE.md' }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority[0]).toBe('CLAUDE.md');
  });

  it('legacy systemPromptFile=AGENTS.md → enabled=true, AGENTS.md first in priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: 'AGENTS.md' }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.priority[0]).toBe('AGENTS.md');
  });

  it('legacy systemPromptFile="" → enabled=false', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({ systemPromptFile: '' }));
    expect(cfg.enabled).toBe(false);
  });

  it('new keys present take precedence over legacy', () => {
    // Even if systemPromptFile is set, new keys win.
    const cfg = resolveWorkspaceInstructionsConfig(
      makeStore({
        systemPromptFile: 'AGENTS.md',
        systemPromptFileEnabled: false,
        systemPromptFilePriority: ['CLAUDE.md'],
      })
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority[0]).toBe('CLAUDE.md');
  });

  it('truly fresh install (no keys at all) → disabled with empty priority', () => {
    const cfg = resolveWorkspaceInstructionsConfig(makeStore({}));
    expect(cfg.enabled).toBe(false);
    expect(cfg.priority).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getStatus IPC payload contract — WorkspaceInstructionsStatus shape
// ---------------------------------------------------------------------------

function makeStatusStore(data: Record<string, unknown>) {
  return {
    get: (key: string) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined),
  } as Parameters<typeof computeWorkspaceInstructionsStatus>[0];
}

describe('getStatus IPC payload contract', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ipc-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('disabled → configuredFile=first-priority, resolvedFile="", loaded=false', async () => {
    const status = await computeWorkspaceInstructionsStatus(
      makeStatusStore({
        systemPromptFileEnabled: false,
        systemPromptFilePriority: ['CLAUDE.md', 'AGENTS.md'],
      }),
      tmpRoot
    );
    expect(status.configuredFile).toBe('CLAUDE.md');
    expect(status.resolvedFile).toBe('');
    expect(status.loaded).toBe(false);
  });

  it('enabled, file missing → configuredFile=first-priority, resolvedFile="", loaded=false, error set', async () => {
    const status = await computeWorkspaceInstructionsStatus(
      makeStatusStore({
        systemPromptFileEnabled: true,
        systemPromptFilePriority: ['CLAUDE.md', 'AGENTS.md'],
      }),
      tmpRoot
    );
    expect(status.configuredFile).toBe('CLAUDE.md');
    expect(status.resolvedFile).toBe('');
    expect(status.loaded).toBe(false);
    expect(status.error).toMatch(/No workspace instructions/);
  });

  it('enabled, file present → configuredFile=first-priority, resolvedFile=winner, loaded=true', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# Agent instructions\n');
    const status = await computeWorkspaceInstructionsStatus(
      makeStatusStore({
        systemPromptFileEnabled: true,
        systemPromptFilePriority: ['CLAUDE.md', 'AGENTS.md'],
      }),
      tmpRoot
    );
    // configuredFile = first in priority (CLAUDE.md), even though AGENTS.md won
    expect(status.configuredFile).toBe('CLAUDE.md');
    // resolvedFile = actual winner
    expect(status.resolvedFile).toBe('AGENTS.md');
    expect(status.loaded).toBe(true);
    expect(typeof status.sizeBytes).toBe('number');
    expect(typeof status.fingerprintShort).toBe('string');
  });

  it('legacy-only config (systemPromptFile=CLAUDE.md) → enabled, configuredFile=CLAUDE.md', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '# Claude instructions\n');
    const status = await computeWorkspaceInstructionsStatus(
      makeStatusStore({ systemPromptFile: 'CLAUDE.md' }),
      tmpRoot
    );
    expect(status.configuredFile).toBe('CLAUDE.md');
    expect(status.resolvedFile).toBe('CLAUDE.md');
    expect(status.loaded).toBe(true);
  });

  it('legacy-only config (systemPromptFile="") → disabled', async () => {
    const status = await computeWorkspaceInstructionsStatus(
      makeStatusStore({ systemPromptFile: '' }),
      tmpRoot
    );
    expect(status.loaded).toBe(false);
    expect(status.resolvedFile).toBe('');
  });
});

// ---------------------------------------------------------------------------
// noContextFiles regression — only agentsFiles suppressed
// ---------------------------------------------------------------------------

describe('noContextFiles=true scope regression', () => {
  it('normalizeSystemPromptPriority produces a full permutation (whitelist unchanged)', () => {
    // If noContextFiles only gates agentsFiles, the whitelist candidates must
    // still all be present after normalization. A future upstream change that
    // removes candidates from the whitelist would break this test, alerting us
    // that injection behavior may have changed.
    const full = normalizeSystemPromptPriority([]);
    expect(full).toContain('CLAUDE.md');
    expect(full).toContain('AGENTS.md');
    expect(full).toContain('.cowork/instructions.md');
    expect(full).toContain('memory.md');
    expect(full).toContain('instructions.md');
    // No duplicates
    expect(new Set(full).size).toBe(full.length);
  });

  it('isValidSystemPromptPriority rejects unknown filenames (whitelist is stable)', () => {
    // The whitelist gates what noContextFiles suppresses. If new filenames were
    // silently accepted, context files outside the known set could slip through.
    expect(isValidSystemPromptPriority(['UNKNOWN.md'])).toBe(false);
    expect(isValidSystemPromptPriority(['CLAUDE.md', 'UNKNOWN.md'])).toBe(false);
  });

  it('loadWorkspaceSystemPrompt with enabled=false returns null (no injection occurs)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-nc-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# instructions\n');
      // When the feature is disabled, nothing should be injected — null means
      // the caller will not append <workspace_instructions> to the prompt.
      const result = await loadWorkspaceSystemPrompt(tmpDir, ['AGENTS.md', 'CLAUDE.md'], false);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exactly one injection: loadWorkspaceSystemPrompt returns one winner, not multiple', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-nc2-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude\n');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\n');
      // Only one result is returned even when multiple candidates exist.
      // This is the guarantee that noContextFiles=true + app resolver = exactly one injection.
      const result = await loadWorkspaceSystemPrompt(tmpDir, ['CLAUDE.md', 'AGENTS.md'], true);
      expect(result).not.toBeNull();
      expect(result!.resolvedFile).toBe('CLAUDE.md'); // first by priority wins
      // Result is a single object, not an array — no double injection possible
      expect(Array.isArray(result)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// settings.update migration logic — legacy key + existing priority
// ---------------------------------------------------------------------------

/**
 * Simulates the settings.update workspace-instructions normalization logic
 * extracted from index.ts so we can unit-test it without Electron IPC.
 */
function simulateSettingsUpdate(
  payload: Record<string, unknown>,
  existingPriority: string[]
): {
  updates: Partial<{ systemPromptFileEnabled: boolean; systemPromptFilePriority: string[] }>;
  warns: string[];
} {
  const warns: string[] = [];
  const updates: Partial<{ systemPromptFileEnabled: boolean; systemPromptFilePriority: string[] }> =
    {};

  if ('systemPromptFile' in payload && !('systemPromptFilePriority' in payload)) {
    const raw = payload.systemPromptFile;
    if (raw === '') {
      updates.systemPromptFileEnabled = false;
    } else if (isValidSystemPromptFileChoice(raw)) {
      const base = [raw as string, ...existingPriority.filter((x) => typeof x === 'string')];
      updates.systemPromptFileEnabled = true;
      updates.systemPromptFilePriority = normalizeSystemPromptPriority(base);
    } else {
      warns.push(`Ignored invalid legacy systemPromptFile value: ${String(raw)}`);
    }
  }

  if ('systemPromptFileEnabled' in payload) {
    const raw = payload.systemPromptFileEnabled;
    if (typeof raw === 'boolean') {
      updates.systemPromptFileEnabled = raw;
    } else {
      warns.push(`Ignored invalid systemPromptFileEnabled value: ${String(raw)}`);
    }
  }

  if ('systemPromptFilePriority' in payload) {
    const raw = payload.systemPromptFilePriority;
    if (isValidSystemPromptPriority(raw)) {
      updates.systemPromptFilePriority = normalizeSystemPromptPriority(raw);
    } else {
      warns.push(`Ignored invalid systemPromptFilePriority value: ${String(raw)}`);
    }
  }

  return { updates, warns };
}

describe('settings.update migration logic', () => {
  it('legacy systemPromptFile merges with existing priority, not replaces', () => {
    const existing = ['AGENTS.md', 'CLAUDE.md', 'memory.md'];
    const { updates } = simulateSettingsUpdate({ systemPromptFile: 'CLAUDE.md' }, existing);
    expect(updates.systemPromptFileEnabled).toBe(true);
    // CLAUDE.md must be first (hoisted)
    expect(updates.systemPromptFilePriority![0]).toBe('CLAUDE.md');
    // Existing entries must all be preserved
    expect(updates.systemPromptFilePriority).toContain('AGENTS.md');
    expect(updates.systemPromptFilePriority).toContain('memory.md');
    // No duplicates
    expect(new Set(updates.systemPromptFilePriority).size).toBe(
      updates.systemPromptFilePriority!.length
    );
  });

  it('legacy systemPromptFile ignored when payload also has systemPromptFilePriority', () => {
    // New key takes precedence — legacy should not clobber explicit new update.
    const existing = ['AGENTS.md'];
    const { updates } = simulateSettingsUpdate(
      { systemPromptFile: 'CLAUDE.md', systemPromptFilePriority: ['AGENTS.md', 'CLAUDE.md'] },
      existing
    );
    // systemPromptFilePriority from payload wins; legacy branch was skipped
    expect(updates.systemPromptFilePriority![0]).toBe('AGENTS.md');
  });

  it('legacy systemPromptFile="" disables without touching priority', () => {
    const existing = ['CLAUDE.md', 'AGENTS.md'];
    const { updates } = simulateSettingsUpdate({ systemPromptFile: '' }, existing);
    expect(updates.systemPromptFileEnabled).toBe(false);
    expect(updates.systemPromptFilePriority).toBeUndefined();
  });

  it('invalid legacy value produces a warning and no update', () => {
    const { updates, warns } = simulateSettingsUpdate({ systemPromptFile: 'INVALID.md' }, [
      'CLAUDE.md',
    ]);
    expect(updates.systemPromptFileEnabled).toBeUndefined();
    expect(updates.systemPromptFilePriority).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });

  it('multiple invalid fields each produce their own warning', () => {
    const { warns } = simulateSettingsUpdate(
      { systemPromptFileEnabled: 'yes', systemPromptFilePriority: 'CLAUDE.md' },
      []
    );
    expect(warns.length).toBe(2);
  });

  it('payload with both enabled and priority applies both', () => {
    const { updates } = simulateSettingsUpdate(
      { systemPromptFileEnabled: false, systemPromptFilePriority: ['AGENTS.md', 'CLAUDE.md'] },
      []
    );
    expect(updates.systemPromptFileEnabled).toBe(false);
    expect(updates.systemPromptFilePriority![0]).toBe('AGENTS.md');
  });
});
