import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isValidSystemPromptFileChoice,
  loadWorkspaceSystemPrompt,
  MAX_BYTES,
  SYSTEM_PROMPT_FILE_CHOICES,
} from '../src/main/utils/workspace-system-prompt';

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
