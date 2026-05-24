/**
 * Behavioral tests for the mcp.saveWorkspaceProfile IPC handler's authorization logic.
 *
 * Tests the exported `validateWorkspaceCwd` function which enforces that renderer-provided
 * `cwd` values are authorized workspaces (matching the global working directory or a known
 * session's cwd). This prevents a compromised renderer from writing to arbitrary paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateWorkspaceCwd } from '../src/main/mcp/mcp-workspace-profile';

describe('validateWorkspaceCwd', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
    tmpFile = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(tmpFile, 'test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('rejects invalid cwd inputs', () => {
    it('rejects null cwd', () => {
      const result = validateWorkspaceCwd(null, [tmpDir]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('absolute path');
      }
    });

    it('rejects undefined cwd', () => {
      const result = validateWorkspaceCwd(undefined, [tmpDir]);
      expect(result.valid).toBe(false);
    });

    it('rejects empty string cwd', () => {
      const result = validateWorkspaceCwd('', [tmpDir]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('absolute path');
      }
    });

    it('rejects relative path cwd', () => {
      const result = validateWorkspaceCwd('relative/path', [tmpDir]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('absolute path');
      }
    });
  });

  describe('rejects non-directory paths', () => {
    it('rejects a file path (not a directory)', () => {
      const result = validateWorkspaceCwd(tmpFile, [tmpFile]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('not a directory');
      }
    });

    it('rejects a non-existent path', () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');
      const result = validateWorkspaceCwd(nonExistent, [nonExistent]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('does not exist');
      }
    });
  });

  describe('rejects unauthorized workspace paths', () => {
    it('rejects an absolute directory path not in authorized list', () => {
      const unauthorizedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unauth-'));
      try {
        const result = validateWorkspaceCwd(unauthorizedDir, [tmpDir]);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toContain('not an authorized workspace');
        }
      } finally {
        fs.rmSync(unauthorizedDir, { recursive: true, force: true });
      }
    });

    it('rejects when authorized list is empty', () => {
      const result = validateWorkspaceCwd(tmpDir, []);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('not an authorized workspace');
      }
    });

    it('rejects path traversal attempts', () => {
      // Even if the traversal resolves to an existing directory,
      // it must match an authorized path after resolution
      const traversal = path.join(tmpDir, '..', 'some-other-dir');
      const result = validateWorkspaceCwd(traversal, [tmpDir]);
      expect(result.valid).toBe(false);
    });
  });

  describe('accepts authorized workspace paths', () => {
    it('accepts cwd that matches an authorized workspace', () => {
      const result = validateWorkspaceCwd(tmpDir, [tmpDir]);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.canonicalCwd).toBeTruthy();
      }
    });

    it('accepts cwd matching one of multiple authorized workspaces', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-other-'));
      try {
        const result = validateWorkspaceCwd(tmpDir, [otherDir, tmpDir]);
        expect(result.valid).toBe(true);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('normalizes paths before comparison (trailing slash)', () => {
      // path.resolve normalizes trailing slashes
      const result = validateWorkspaceCwd(tmpDir + '/', [tmpDir]);
      expect(result.valid).toBe(true);
    });

    it('normalizes paths with redundant segments', () => {
      // path.resolve normalizes /./
      const withDot = path.join(tmpDir, '.', '.');
      const result = validateWorkspaceCwd(withDot, [tmpDir]);
      expect(result.valid).toBe(true);
    });

    it('returns canonical path for downstream use (TOCTOU prevention)', () => {
      const withDot = path.join(tmpDir, '.', '.');
      const result = validateWorkspaceCwd(withDot, [tmpDir]);
      expect(result.valid).toBe(true);
      if (result.valid) {
        // Canonical path should not contain redundant segments
        expect(result.canonicalCwd).not.toContain('/./');
        // Should resolve to the real path
        expect(fs.existsSync(result.canonicalCwd)).toBe(true);
      }
    });
  });
});
