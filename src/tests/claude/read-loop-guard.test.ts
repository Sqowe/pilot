import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReadLoopGuard,
  extractReadFilePath,
  DEFAULT_MAX_READS_PER_FILE,
} from '../../main/claude/read-loop-guard';

describe('ReadLoopGuard', () => {
  let guard: ReadLoopGuard;

  beforeEach(() => {
    guard = new ReadLoopGuard();
  });

  describe('check()', () => {
    it('allows reads up to the default limit', () => {
      const filePath = '/Users/test/documents/large-file.md';

      for (let i = 1; i <= DEFAULT_MAX_READS_PER_FILE; i++) {
        const result = guard.check(filePath);
        expect(result.blocked).toBe(false);
        expect(result.count).toBe(i);
      }
    });

    it('blocks reads beyond the default limit', () => {
      const filePath = '/Users/test/documents/large-file.md';

      // Exhaust the limit
      for (let i = 0; i < DEFAULT_MAX_READS_PER_FILE; i++) {
        guard.check(filePath);
      }

      // Next read should be blocked
      const result = guard.check(filePath);
      expect(result.blocked).toBe(true);
      expect(result.count).toBe(DEFAULT_MAX_READS_PER_FILE + 1);
      expect(result.reason).toContain('large-file.md');
      expect(result.reason).toContain('grep');
      expect(result.reason).toContain('bash');
    });

    it('tracks different files independently', () => {
      const file1 = '/Users/test/file1.md';
      const file2 = '/Users/test/file2.md';

      // Read file1 up to the limit
      for (let i = 0; i < DEFAULT_MAX_READS_PER_FILE; i++) {
        guard.check(file1);
      }

      // file2 should still be allowed
      const result = guard.check(file2);
      expect(result.blocked).toBe(false);
      expect(result.count).toBe(1);
    });

    it('normalizes paths — same file with different representations', () => {
      const absolute = '/Users/test/project/src/file.ts';
      const withDotDot = '/Users/test/project/src/../src/file.ts';

      // Read via absolute path
      guard.check(absolute);
      guard.check(absolute);
      guard.check(absolute);

      // Read via path with ../ — should count as the same file
      const result = guard.check(withDotDot);
      expect(result.count).toBe(4);
    });

    it('does NOT merge paths that differ only in case (case-sensitive safe)', () => {
      // On case-sensitive volumes, these are different files
      guard.check('/Users/test/File.md');
      guard.check('/Users/test/File.md');
      guard.check('/Users/test/File.md');
      guard.check('/Users/test/File.md');

      // Different casing = different file, should not be blocked
      const result = guard.check('/Users/test/file.md');
      expect(result.blocked).toBe(false);
      expect(result.count).toBe(1);
    });

    it('respects custom maxReads', () => {
      const customGuard = new ReadLoopGuard(2);
      const filePath = '/tmp/test.txt';

      expect(customGuard.check(filePath).blocked).toBe(false); // 1
      expect(customGuard.check(filePath).blocked).toBe(false); // 2
      expect(customGuard.check(filePath).blocked).toBe(true); // 3 — blocked
    });

    it('handles empty file path gracefully', () => {
      const result = guard.check('');
      // Empty path cannot be normalized — skipped (not tracked)
      expect(result.blocked).toBe(false);
      expect(result.count).toBe(0);
    });

    it('skips tracking for relative paths when no cwd is provided', () => {
      // Without cwd, relative paths cannot be safely normalized
      const result1 = guard.check('src/file.ts');
      expect(result1.blocked).toBe(false);
      expect(result1.count).toBe(0); // not tracked

      // Even after many calls, it's never blocked (not tracked)
      for (let i = 0; i < 10; i++) {
        guard.check('src/file.ts');
      }
      const result2 = guard.check('src/file.ts');
      expect(result2.blocked).toBe(false);
      expect(result2.count).toBe(0);
    });

    it('resolves relative paths against cwd', () => {
      const cwd = '/Users/test/project';

      guard.check('src/file.ts', cwd);
      guard.check('/Users/test/project/src/file.ts');

      // Both should count as the same file
      const result = guard.check('src/file.ts', cwd);
      expect(result.count).toBe(3);
    });
  });

  describe('getCount()', () => {
    it('returns 0 for unread files', () => {
      expect(guard.getCount('/some/file.ts')).toBe(0);
    });

    it('returns current count without incrementing', () => {
      guard.check('/tmp/file.ts');
      guard.check('/tmp/file.ts');

      expect(guard.getCount('/tmp/file.ts')).toBe(2);
      // Calling getCount again should not change the count
      expect(guard.getCount('/tmp/file.ts')).toBe(2);
    });
  });

  describe('resetFile()', () => {
    it('resets the counter for a specific file', () => {
      const filePath = '/tmp/file.ts';

      guard.check(filePath);
      guard.check(filePath);
      guard.check(filePath);
      expect(guard.getCount(filePath)).toBe(3);

      guard.resetFile(filePath);
      expect(guard.getCount(filePath)).toBe(0);

      // Should be able to read again
      const result = guard.check(filePath);
      expect(result.blocked).toBe(false);
      expect(result.count).toBe(1);
    });
  });

  describe('resetAll()', () => {
    it('resets all counters', () => {
      guard.check('/tmp/a.ts');
      guard.check('/tmp/b.ts');
      guard.check('/tmp/c.ts');

      guard.resetAll();

      expect(guard.getCount('/tmp/a.ts')).toBe(0);
      expect(guard.getCount('/tmp/b.ts')).toBe(0);
      expect(guard.getCount('/tmp/c.ts')).toBe(0);
    });
  });
});

describe('extractReadFilePath()', () => {
  it('extracts file_path (pi-coding-agent format)', () => {
    expect(extractReadFilePath({ file_path: '/Users/test/file.md' })).toBe('/Users/test/file.md');
  });

  it('extracts path as fallback', () => {
    expect(extractReadFilePath({ path: '/Users/test/file.md' })).toBe('/Users/test/file.md');
  });

  it('extracts filePath as fallback', () => {
    expect(extractReadFilePath({ filePath: '/Users/test/file.md' })).toBe('/Users/test/file.md');
  });

  it('prefers file_path over path and filePath', () => {
    expect(
      extractReadFilePath({
        file_path: '/preferred.md',
        path: '/fallback1.md',
        filePath: '/fallback2.md',
      })
    ).toBe('/preferred.md');
  });

  it('returns null for empty input', () => {
    expect(extractReadFilePath({})).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(extractReadFilePath({ file_path: 123 })).toBeNull();
    expect(extractReadFilePath({ file_path: null })).toBeNull();
  });

  it('trims whitespace', () => {
    expect(extractReadFilePath({ file_path: '  /Users/test/file.md  ' })).toBe(
      '/Users/test/file.md'
    );
  });

  it('returns null for whitespace-only strings', () => {
    expect(extractReadFilePath({ file_path: '   ' })).toBeNull();
  });
});

describe('Integration: ReadLoopGuard in permission gate context', () => {
  /**
   * Simulates the agent-runner gate behavior: the guard is consulted
   * for 'read' tool calls but not for other tools.
   */
  it('blocks repeated reads but allows other tools unconditionally', () => {
    const guard = new ReadLoopGuard(3);
    const cwd = '/Users/test/project';

    // Simulate gate logic (mirrors agent-runner.ts)
    function simulateGate(
      toolName: string,
      input: Record<string, unknown>
    ): { block: boolean; reason?: string } | null {
      if (toolName === 'read') {
        const filePath = extractReadFilePath(input);
        if (filePath) {
          const result = guard.check(filePath, cwd);
          if (result.blocked) {
            return { block: true, reason: result.reason };
          }
        }
      }
      return null; // allowed
    }

    const targetFile = { file_path: 'src/big-file.md' };

    // First 3 reads allowed
    expect(simulateGate('read', targetFile)).toBeNull();
    expect(simulateGate('read', targetFile)).toBeNull();
    expect(simulateGate('read', targetFile)).toBeNull();

    // 4th read blocked
    const blocked = simulateGate('read', targetFile);
    expect(blocked).not.toBeNull();
    expect(blocked!.block).toBe(true);
    expect(blocked!.reason).toContain('big-file.md');
    expect(blocked!.reason).toContain('grep');

    // Other tools are never affected
    expect(simulateGate('bash', { command: 'ls' })).toBeNull();
    expect(
      simulateGate('edit', { file_path: 'src/big-file.md', old_text: 'a', new_text: 'b' })
    ).toBeNull();
    expect(simulateGate('write', { file_path: 'src/big-file.md', content: 'hello' })).toBeNull();
  });

  it('correctly resolves relative paths against cwd', () => {
    const guard = new ReadLoopGuard(2);
    const cwd = '/Users/test/project';

    // These should all resolve to the same file
    guard.check('src/file.ts', cwd); // /Users/test/project/src/file.ts
    guard.check('/Users/test/project/src/file.ts', cwd); // same absolute

    // 3rd read — should be blocked
    const result = guard.check('./src/file.ts', cwd);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(3);
  });

  it('propagates reason text suitable for model consumption', () => {
    const guard = new ReadLoopGuard(1);
    guard.check('/tmp/conversation.md');

    const result = guard.check('/tmp/conversation.md');
    expect(result.blocked).toBe(true);
    // Reason should contain actionable guidance
    expect(result.reason).toContain('bash');
    expect(result.reason).toContain('grep');
    expect(result.reason).toContain('tail');
    expect(result.reason).toContain('conversation.md');
    // Should mention the count and limit
    expect(result.reason).toContain('2 times');
    expect(result.reason).toContain('limit: 1');
  });

  it('handles all file_path input variants correctly', () => {
    const guard = new ReadLoopGuard(2);

    // pi-coding-agent uses file_path
    guard.check(extractReadFilePath({ file_path: '/tmp/test.md' })!);
    // Some tools use path
    guard.check(extractReadFilePath({ path: '/tmp/test.md' })!);

    // Should be blocked on 3rd regardless of input key name
    const filePath = extractReadFilePath({ filePath: '/tmp/test.md' });
    const result = guard.check(filePath!);
    expect(result.blocked).toBe(true);
  });
});

describe('ReadLoopGuard — LRU eviction', () => {
  it('evicts oldest entries when maxTracked is exceeded', () => {
    const guard = new ReadLoopGuard(4, 3); // max 4 reads, track only 3 files

    // Track 3 files
    guard.check('/tmp/a.ts');
    guard.check('/tmp/b.ts');
    guard.check('/tmp/c.ts');
    expect(guard.trackedFileCount).toBe(3);

    // Adding a 4th file should evict the oldest (a.ts)
    guard.check('/tmp/d.ts');
    expect(guard.trackedFileCount).toBe(3);
    expect(guard.getCount('/tmp/a.ts')).toBe(0); // evicted
    expect(guard.getCount('/tmp/b.ts')).toBe(1); // still tracked
    expect(guard.getCount('/tmp/d.ts')).toBe(1); // newly added
  });

  it('re-reading a file refreshes its LRU position', () => {
    const guard = new ReadLoopGuard(4, 3);

    guard.check('/tmp/a.ts'); // oldest
    guard.check('/tmp/b.ts');
    guard.check('/tmp/c.ts');

    // Re-read a.ts — moves it to the end (most recent)
    guard.check('/tmp/a.ts');

    // Now add d.ts — should evict b.ts (now the oldest)
    guard.check('/tmp/d.ts');
    expect(guard.getCount('/tmp/b.ts')).toBe(0); // evicted
    expect(guard.getCount('/tmp/a.ts')).toBe(2); // still tracked, count preserved
  });
});

describe('ReadLoopGuard — session reuse with cwd change', () => {
  it('resolves same relative path differently when cwd changes', () => {
    const guard = new ReadLoopGuard(2);

    // First run: cwd is /project-a
    guard.check('src/main.ts', '/project-a');
    guard.check('src/main.ts', '/project-a');

    // Second run: cwd changes to /project-b (session reuse)
    // Same relative path but different absolute file — should NOT be blocked
    const result = guard.check('src/main.ts', '/project-b');
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(1); // fresh count for the new absolute path
  });

  it('correctly blocks when cwd stays the same across reuse', () => {
    const guard = new ReadLoopGuard(2);

    // First run
    guard.check('src/main.ts', '/project');
    guard.check('src/main.ts', '/project');

    // Second run with same cwd — should be blocked (same file)
    const result = guard.check('src/main.ts', '/project');
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(3);
  });

  it('simulates mutable cwdRef pattern from agent-runner', () => {
    const guard = new ReadLoopGuard(2);
    const cwdRef = { value: '/workspace-a' };

    // Simulate gate using cwdRef.value at call time
    function simulateRead(relativePath: string) {
      return guard.check(relativePath, cwdRef.value);
    }

    // First session run
    simulateRead('src/file.ts'); // count 1
    simulateRead('src/file.ts'); // count 2

    // Session reuse — cwd changes
    cwdRef.value = '/workspace-b';

    // Same relative path, different workspace — fresh count
    const result = simulateRead('src/file.ts');
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(1);
  });

  it('absolute paths are unaffected by cwd changes', () => {
    const guard = new ReadLoopGuard(2);
    const cwdRef = { value: '/workspace-a' };

    guard.check('/absolute/path/file.ts', cwdRef.value);
    guard.check('/absolute/path/file.ts', cwdRef.value);

    // Change cwd — absolute path still resolves the same
    cwdRef.value = '/workspace-b';
    const result = guard.check('/absolute/path/file.ts', cwdRef.value);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(3);
  });
});

describe('Integration: Read-loop guard active regardless of permission mode', () => {
  /**
   * Simulates the agent-runner gate when requestPermission is NOT configured
   * (auto-approve / non-interactive mode). The read-loop guard must still
   * block excessive reads — this is the exact scenario from the original bug.
   */
  it('blocks repeated reads even when requestPermission is null (auto-approve mode)', () => {
    const guard = new ReadLoopGuard(3);
    const cwdRef = { value: '/workspace' };
    const requestPermission = null; // not configured

    // Simulate the gate logic as implemented in agent-runner.ts
    function simulateGate(
      toolName: string,
      input: Record<string, unknown>
    ): { block: boolean; reason?: string } | undefined {
      // --- Read loop detection (always active) ---
      if (toolName === 'read') {
        const filePath = extractReadFilePath(input);
        if (filePath) {
          const guardResult = guard.check(filePath, cwdRef.value);
          if (guardResult.blocked) {
            return { block: true, reason: guardResult.reason };
          }
        }
      }

      // --- Permission gating (only when requestPermission is configured) ---
      if (!requestPermission) {
        return undefined; // allowed, delegate to SDK
      }

      // ... permission logic would go here ...
      return undefined;
    }

    const bigFile = { file_path: '/workspace/huge-conversation.md' };

    // First 3 reads pass through (no permission check, no blocking)
    expect(simulateGate('read', bigFile)).toBeUndefined();
    expect(simulateGate('read', bigFile)).toBeUndefined();
    expect(simulateGate('read', bigFile)).toBeUndefined();

    // 4th read is blocked by the guard
    const result = simulateGate('read', bigFile);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain('huge-conversation.md');
  });

  it('blocks repeated reads when requestPermission IS configured', () => {
    const guard = new ReadLoopGuard(3);
    const cwdRef = { value: '/workspace' };
    const requestPermission = async () => 'allow' as const; // configured

    function simulateGate(
      toolName: string,
      input: Record<string, unknown>
    ): { block: boolean; reason?: string } | undefined {
      if (toolName === 'read') {
        const filePath = extractReadFilePath(input);
        if (filePath) {
          const guardResult = guard.check(filePath, cwdRef.value);
          if (guardResult.blocked) {
            return { block: true, reason: guardResult.reason };
          }
        }
      }

      if (!requestPermission) {
        return undefined;
      }

      // Permission logic would run here (allow in this test)
      return undefined;
    }

    const bigFile = { file_path: '/workspace/huge-conversation.md' };

    // First 3 reads pass through
    expect(simulateGate('read', bigFile)).toBeUndefined();
    expect(simulateGate('read', bigFile)).toBeUndefined();
    expect(simulateGate('read', bigFile)).toBeUndefined();

    // 4th read is blocked by the guard (before permission is even checked)
    const result = simulateGate('read', bigFile);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it('non-read tools are never blocked by the guard in any mode', () => {
    const guard = new ReadLoopGuard(1); // very aggressive limit
    const cwdRef = { value: '/workspace' };

    function simulateGate(
      toolName: string,
      input: Record<string, unknown>
    ): { block: boolean; reason?: string } | undefined {
      if (toolName === 'read') {
        const filePath = extractReadFilePath(input);
        if (filePath) {
          const guardResult = guard.check(filePath, cwdRef.value);
          if (guardResult.blocked) {
            return { block: true, reason: guardResult.reason };
          }
        }
      }
      return undefined;
    }

    // bash, edit, write are never affected
    for (let i = 0; i < 20; i++) {
      expect(
        simulateGate('bash', { command: 'grep -n "test" /workspace/file.md' })
      ).toBeUndefined();
      expect(simulateGate('edit', { file_path: '/workspace/file.md' })).toBeUndefined();
      expect(simulateGate('write', { file_path: '/workspace/file.md' })).toBeUndefined();
    }
  });
});

describe('ReadLoopGuard — constructor input validation', () => {
  it('clamps maxReads to minimum of 1', () => {
    const guard = new ReadLoopGuard(0);
    // With maxReads=1, first read is allowed, second is blocked
    expect(guard.check('/tmp/file.ts').blocked).toBe(false);
    expect(guard.check('/tmp/file.ts').blocked).toBe(true);
  });

  it('clamps negative maxReads to 1', () => {
    const guard = new ReadLoopGuard(-5);
    expect(guard.check('/tmp/file.ts').blocked).toBe(false);
    expect(guard.check('/tmp/file.ts').blocked).toBe(true);
  });

  it('floors fractional maxReads', () => {
    const guard = new ReadLoopGuard(2.9);
    expect(guard.check('/tmp/file.ts').blocked).toBe(false); // 1
    expect(guard.check('/tmp/file.ts').blocked).toBe(false); // 2
    expect(guard.check('/tmp/file.ts').blocked).toBe(true); // 3 > floor(2.9)=2
  });

  it('clamps maxTracked to minimum of 1', () => {
    const guard = new ReadLoopGuard(4, 0);
    // Should still track at least 1 file
    guard.check('/tmp/a.ts');
    expect(guard.getCount('/tmp/a.ts')).toBe(1);
  });
});

describe('ReadLoopGuard — sequential prompt execution guarantee', () => {
  /**
   * Simulates the documented invariant: cwdRef.value is updated at the
   * start of each run() and remains stable for the duration of that run's
   * tool calls (because pi-coding-agent enforces sequential prompts).
   */
  it('cwd is stable within a single prompt run (sequential execution)', () => {
    const guard = new ReadLoopGuard(3);
    const cwdRef = { value: '/workspace-v1' };

    // Simulate a single prompt run with multiple tool calls
    // All reads within this run use the same cwdRef.value
    guard.check('src/file.ts', cwdRef.value); // /workspace-v1/src/file.ts
    guard.check('src/file.ts', cwdRef.value); // same
    guard.check('src/file.ts', cwdRef.value); // same

    // 4th read in same run — blocked
    const result = guard.check('src/file.ts', cwdRef.value);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(4);
  });

  it('cwd update between sequential prompts is safe', () => {
    const guard = new ReadLoopGuard(3);
    const cwdRef = { value: '/workspace-v1' };

    // First prompt run
    guard.check('src/file.ts', cwdRef.value); // count 1 for /workspace-v1/src/file.ts
    guard.check('src/file.ts', cwdRef.value); // count 2

    // --- Prompt completes, new prompt starts with different cwd ---
    cwdRef.value = '/workspace-v2';

    // Second prompt run — different absolute path, fresh count
    guard.check('src/file.ts', cwdRef.value); // count 1 for /workspace-v2/src/file.ts
    guard.check('src/file.ts', cwdRef.value); // count 2
    guard.check('src/file.ts', cwdRef.value); // count 3

    // Blocked for workspace-v2 path
    const result = guard.check('src/file.ts', cwdRef.value);
    expect(result.blocked).toBe(true);

    // Original workspace-v1 path still at count 2 (not affected)
    expect(guard.getCount('src/file.ts', '/workspace-v1')).toBe(2);
  });
});
