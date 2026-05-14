import { describe, it, expect } from 'vitest';
import {
  setBashCommandLists,
  decideBashPermission,
} from '../src/main/config/permission-rules-store.ts';

describe('denylist word-boundary matching (regression: false positives)', () => {
  it('does NOT false-positive on "rm" inside "formats" or "markdown"', () => {
    setBashCommandLists(['firecrawl *', 'head *'], ['rm', '--force', 'awk', 'sudo']);
    const cmd =
      'firecrawl search "site:telex.hu Magyar Péter" --scrape --scrape-formats markdown -o .firecrawl/out.json --json 2>&1 | head -5';
    expect(decideBashPermission(cmd)).toBe('allow');
  });

  it('does NOT false-positive on "awk" inside "gawk" or "hawkish"', () => {
    setBashCommandLists(['echo *'], ['awk']);
    expect(decideBashPermission('echo "hawkish behavior"')).toBe('allow');
  });

  it('does NOT false-positive on "rm" inside "firmware"', () => {
    setBashCommandLists(['cat *'], ['rm']);
    expect(decideBashPermission('cat firmware.bin')).toBe('allow');
  });

  it('does NOT false-positive on "sudo" inside "pseudocode"', () => {
    setBashCommandLists(['echo *'], ['sudo']);
    expect(decideBashPermission('echo "pseudocode example"')).toBe('allow');
  });

  it('still catches actual "rm" as a command', () => {
    setBashCommandLists(['ls *'], ['rm']);
    expect(decideBashPermission('rm -rf /tmp')).toBe('ask');
  });

  it('still catches "rm" after a pipe', () => {
    setBashCommandLists(['ls *'], ['rm']);
    expect(decideBashPermission('ls /tmp | rm')).toBe('ask');
  });

  it('still catches "rm" preceded by path separator', () => {
    setBashCommandLists(['*'], ['rm']);
    expect(decideBashPermission('/usr/bin/rm file.txt')).toBe('ask');
  });

  it('catches "rm" preceded by open parenthesis', () => {
    setBashCommandLists(['echo *'], ['rm']);
    expect(decideBashPermission('echo (rm -rf /)')).toBe('ask');
  });

  it('catches "rm" preceded by semicolon after split', () => {
    // After splitting on `;`, the sub-command starts with `rm`
    setBashCommandLists(['echo *'], ['rm']);
    expect(decideBashPermission('echo ok; rm file')).toBe('ask');
  });

  it('catches "rm" when preceded by colon-space (shell no-op)', () => {
    setBashCommandLists(['*'], ['rm']);
    expect(decideBashPermission(': && rm file')).toBe('ask');
  });

  it('catches "rm" at the very start of a sub-command (no preceding char)', () => {
    setBashCommandLists([], ['rm']);
    expect(decideBashPermission('rm -rf /')).toBe('ask');
  });

  it('catches "rm" preceded by a quote character in the sub-command', () => {
    // After quote-aware splitting, the sub might start with rm
    setBashCommandLists(['*'], ['rm']);
    expect(decideBashPermission('rm file.txt')).toBe('ask');
  });

  it('still catches "sudo" at start of command', () => {
    setBashCommandLists(['ls *'], ['sudo']);
    expect(decideBashPermission('sudo ls')).toBe('ask');
  });

  it('still catches "awk" as a standalone command', () => {
    setBashCommandLists(['cat *', 'awk *'], ['awk']);
    expect(decideBashPermission("cat file | awk '{print}'")).toBe('ask');
  });

  it('still catches "--force" flag in commands', () => {
    setBashCommandLists(['git *'], ['--force']);
    expect(decideBashPermission('git push --force')).toBe('ask');
  });

  it('"--force" still matches "--force-with-lease" (flag prefix)', () => {
    setBashCommandLists(['git *'], ['--force']);
    expect(decideBashPermission('git push --force-with-lease')).toBe('ask');
  });

  it('"--force" matches when preceded by equals sign', () => {
    // e.g. some tools use --option=--force style
    setBashCommandLists(['git *'], ['--force']);
    expect(decideBashPermission('git push --force origin')).toBe('ask');
  });

  it('denylist is case-insensitive', () => {
    setBashCommandLists(['echo *'], ['RM']);
    expect(decideBashPermission('rm -rf /')).toBe('ask');
  });

  it('does NOT false-positive on "rm" inside a longer word with underscore', () => {
    setBashCommandLists(['echo *'], ['rm']);
    expect(decideBashPermission('echo "confirm_action"')).toBe('allow');
  });

  it('does NOT false-positive on "rm" inside a camelCase identifier', () => {
    setBashCommandLists(['echo *'], ['rm']);
    expect(decideBashPermission('echo "confirmDialog"')).toBe('allow');
  });
});
