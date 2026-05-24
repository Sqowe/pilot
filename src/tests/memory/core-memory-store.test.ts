import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreMemoryStore } from '../../main/memory/core-memory-store';

describe('CoreMemoryStore', () => {
  let tempRoot: string;
  let filePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-core-memory-'));
    filePath = path.join(tempRoot, 'core_memory.json');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps newly applied memories when the store is at capacity', () => {
    const store = new CoreMemoryStore(filePath, 2);
    store.applyActions([
      { op: 'upsert', category: 'preferences', key: 'language', value: '中文' },
      { op: 'upsert', category: 'skills', key: 'typescript', value: '熟悉 TypeScript' },
    ]);

    store.applyActions([
      { op: 'upsert', category: 'interests', key: 'memory', value: '关注 memory 系统' },
    ]);

    const keys = store.getEntries().map((entry) => entry.combinedKey);
    expect(keys).toContain('interests.memory');
    expect(keys).toHaveLength(2);
  });

  it('migrates legacy v1 format (plain strings) with empty sourceWorkspaces', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'identity.role': 'backend engineer',
        'preferences.lang': 'TypeScript',
      })
    );

    const store = new CoreMemoryStore(filePath);
    const entries = store.getEntries();

    expect(entries).toHaveLength(2);
    expect(entries[0].sourceWorkspaces).toEqual([]);
    expect(entries[1].sourceWorkspaces).toEqual([]);
    expect(entries[0].value).toBe('backend engineer');
  });

  it('loads v2 format with sourceWorkspaces and normalizes them', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'identity.role': {
          value: 'engineer',
          sourceWorkspaces: ['/Users/a/project', '/Users/a/project', '/Users/b/other'],
        },
      })
    );

    const store = new CoreMemoryStore(filePath);
    const entries = store.getEntries();

    expect(entries).toHaveLength(1);
    // Deduplication should remove the duplicate
    expect(entries[0].sourceWorkspaces).toEqual(['/Users/a/project', '/Users/b/other']);
  });

  it('getEntriesForWorkspace excludes legacy entries with no workspace info', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'identity.role': 'engineer',
        'preferences.lang': { value: 'TypeScript', sourceWorkspaces: ['/workspace/a'] },
      })
    );

    const store = new CoreMemoryStore(filePath);

    // Legacy entry excluded, single-workspace entry included for matching workspace
    const filtered = store.getEntriesForWorkspace('/workspace/a');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].combinedKey).toBe('preferences.lang');
  });

  it('getEntriesForWorkspace excludes single-workspace entries that do not match', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'preferences.lang': { value: 'TypeScript', sourceWorkspaces: ['/workspace/a'] },
        'skills.rust': { value: 'proficient', sourceWorkspaces: ['/workspace/b'] },
      })
    );

    const store = new CoreMemoryStore(filePath);
    const filtered = store.getEntriesForWorkspace('/workspace/a');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].combinedKey).toBe('preferences.lang');
  });

  it('getEntriesForWorkspace includes entries confirmed across 2+ workspaces', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'preferences.lang': {
          value: 'TypeScript',
          sourceWorkspaces: ['/workspace/a', '/workspace/b'],
        },
        'skills.rust': { value: 'proficient', sourceWorkspaces: ['/workspace/c'] },
      })
    );

    const store = new CoreMemoryStore(filePath);
    // Even from an unrelated workspace, multi-workspace entries are included
    const filtered = store.getEntriesForWorkspace('/workspace/x');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].combinedKey).toBe('preferences.lang');
  });

  it('applyActions merges sourceWorkspace into existing entry', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'preferences.lang': { value: 'TypeScript', sourceWorkspaces: ['/workspace/a'] },
      })
    );

    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'preferences', key: 'lang', value: 'TypeScript + Rust' }],
      '/workspace/b'
    );

    const entries = store.getEntries();
    expect(entries[0].sourceWorkspaces).toEqual(['/workspace/a', '/workspace/b']);
    expect(entries[0].value).toBe('TypeScript + Rust');
  });

  it('applyActions does not duplicate workspace on repeated upsert', () => {
    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'skills', key: 'ts', value: 'TypeScript' }],
      '/workspace/a'
    );
    store.applyActions(
      [{ op: 'upsert', category: 'skills', key: 'ts', value: 'TypeScript expert' }],
      '/workspace/a'
    );

    const entries = store.getEntries();
    expect(entries[0].sourceWorkspaces).toEqual(['/workspace/a']);
  });

  it('delete removes entry regardless of workspace tracking', () => {
    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'skills', key: 'ts', value: 'TypeScript' }],
      '/workspace/a'
    );
    store.applyActions([{ op: 'delete', category: 'skills', key: 'ts' }], '/workspace/b');

    expect(store.getEntries()).toHaveLength(0);
  });

  it('applyActions with null workspace uses global sentinel', () => {
    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'identity', key: 'role', value: 'developer' }],
      null
    );

    const entries = store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceWorkspaces).toContain('__global__');
  });

  it('getEntriesForWorkspace includes entries with global sentinel', () => {
    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'identity', key: 'role', value: 'developer' }],
      null
    );

    // Should be visible from any workspace
    const filtered = store.getEntriesForWorkspace('/some/random/workspace');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].value).toBe('developer');
  });

  it('getEntriesForWorkspace with null currentWorkspace still includes global sentinel entries', () => {
    const store = new CoreMemoryStore(filePath);
    store.applyActions(
      [{ op: 'upsert', category: 'preferences', key: 'style', value: 'concise' }],
      null
    );
    store.applyActions(
      [{ op: 'upsert', category: 'skills', key: 'rust', value: 'proficient' }],
      '/workspace/a'
    );

    const filtered = store.getEntriesForWorkspace(null);
    // Global sentinel entry included, single-workspace entry excluded (no match possible)
    expect(filtered).toHaveLength(1);
    expect(filtered[0].combinedKey).toBe('preferences.style');
  });
});
