import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron app before importing the module
let testUserDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testUserDataDir;
      return testUserDataDir;
    },
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  ensurePromptFiles,
  loadPromptSections,
  assembleUserPrompt,
  updatePromptSection,
  resetPromptSection,
  resetAllPromptSections,
  togglePromptSection,
  getPromptsDirPath,
  openPromptsDir,
  getSectionOrder,
  getDefaultContent,
  invalidatePromptCache,
} from '../src/main/prompts/prompt-loader';

describe('prompt-loader', () => {
  beforeEach(() => {
    testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-loader-test-'));
    // Reset module-level cache by re-importing would be ideal, but we can
    // trigger invalidation by calling ensurePromptFiles which invalidates cache
  });

  afterEach(() => {
    fs.rmSync(testUserDataDir, { recursive: true, force: true });
  });

  describe('ensurePromptFiles', () => {
    it('creates prompts directory and all default section files', () => {
      ensurePromptFiles();

      const promptsDir = path.join(testUserDataDir, 'prompts');
      expect(fs.existsSync(promptsDir)).toBe(true);
      expect(fs.existsSync(path.join(promptsDir, 'identity.md'))).toBe(true);
      expect(fs.existsSync(path.join(promptsDir, 'behavioral-rules.md'))).toBe(true);
      expect(fs.existsSync(path.join(promptsDir, 'citations.md'))).toBe(true);
      expect(fs.existsSync(path.join(promptsDir, 'tool-routing.md'))).toBe(true);
    });

    it('does not overwrite existing files', () => {
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Custom identity', 'utf-8');

      ensurePromptFiles();

      expect(fs.readFileSync(path.join(promptsDir, 'identity.md'), 'utf-8')).toBe(
        'Custom identity'
      );
    });

    it('recreates missing files while preserving existing ones', () => {
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Custom', 'utf-8');

      ensurePromptFiles();

      expect(fs.readFileSync(path.join(promptsDir, 'identity.md'), 'utf-8')).toBe('Custom');
      expect(fs.existsSync(path.join(promptsDir, 'citations.md'))).toBe(true);
    });
  });

  describe('loadPromptSections', () => {
    it('returns all sections in correct order', () => {
      ensurePromptFiles();
      const sections = loadPromptSections();

      expect(sections).toHaveLength(4);
      expect(sections[0].filename).toBe('identity.md');
      expect(sections[1].filename).toBe('behavioral-rules.md');
      expect(sections[2].filename).toBe('citations.md');
      expect(sections[3].filename).toBe('tool-routing.md');
    });

    it('marks default content as isDefault=true', () => {
      ensurePromptFiles();
      const sections = loadPromptSections();

      for (const section of sections) {
        expect(section.isDefault).toBe(true);
      }
    });

    it('marks modified content as isDefault=false', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Modified identity', 'utf-8');

      // Invalidate cache by calling ensurePromptFiles
      ensurePromptFiles();
      const sections = loadPromptSections();

      const identity = sections.find((s) => s.filename === 'identity.md');
      expect(identity?.isDefault).toBe(false);
      expect(identity?.content).toBe('Modified identity');
    });

    it('all sections are enabled by default', () => {
      ensurePromptFiles();
      const sections = loadPromptSections();

      for (const section of sections) {
        expect(section.enabled).toBe(true);
      }
    });
  });

  describe('assembleUserPrompt', () => {
    it('joins all enabled sections with double newlines', () => {
      ensurePromptFiles();
      const prompt = assembleUserPrompt();

      expect(prompt).toContain('Sqowe Pilot');
      expect(prompt).toContain('CRITICAL BEHAVIORAL RULES');
      expect(prompt).toContain('<citation_requirements>');
      expect(prompt).toContain('<tool_behavior>');
    });

    it('excludes disabled sections', () => {
      ensurePromptFiles();
      togglePromptSection('citations.md', false);

      const prompt = assembleUserPrompt();

      expect(prompt).toContain('Sqowe Pilot');
      expect(prompt).not.toContain('<citation_requirements>');
    });

    it('preserves section order regardless of toggle order', () => {
      ensurePromptFiles();
      togglePromptSection('identity.md', false);
      togglePromptSection('identity.md', true);

      const prompt = assembleUserPrompt();
      const identityIdx = prompt.indexOf('Sqowe Pilot');
      const rulesIdx = prompt.indexOf('CRITICAL BEHAVIORAL RULES');
      const citationsIdx = prompt.indexOf('<citation_requirements>');
      const toolIdx = prompt.indexOf('<tool_behavior>');

      expect(identityIdx).toBeLessThan(rulesIdx);
      expect(rulesIdx).toBeLessThan(citationsIdx);
      expect(citationsIdx).toBeLessThan(toolIdx);
    });

    it('reflects external file edits on next call (mtime-based invalidation)', () => {
      ensurePromptFiles();
      const before = assembleUserPrompt();
      expect(before).toContain('Sqowe Pilot');

      // External edit
      const promptsDir = path.join(testUserDataDir, 'prompts');
      const filePath = path.join(promptsDir, 'identity.md');
      // Touch the file with new content — mtime will change
      fs.writeFileSync(filePath, 'Custom AI persona', 'utf-8');

      const after = assembleUserPrompt();
      expect(after).toContain('Custom AI persona');
      expect(after).not.toContain('Sqowe Pilot');
    });

    it('uses cache when files have not changed (same mtime)', () => {
      ensurePromptFiles();
      const first = assembleUserPrompt();
      const second = assembleUserPrompt();
      // Same reference means cache was used
      expect(first).toBe(second);
    });
  });

  describe('workspace overrides', () => {
    it('workspace file replaces global section entirely', () => {
      ensurePromptFiles();
      const workspaceDir = path.join(testUserDataDir, 'workspace');
      const wsPromptsDir = path.join(workspaceDir, '.cowork', 'prompts');
      fs.mkdirSync(wsPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(wsPromptsDir, 'identity.md'), 'You are a Python expert.', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: workspaceDir });

      expect(prompt).toContain('You are a Python expert.');
      expect(prompt).not.toContain('Sqowe Pilot');
      // Other sections still come from global
      expect(prompt).toContain('CRITICAL BEHAVIORAL RULES');
    });

    it('non-existent workspace override falls back to global', () => {
      ensurePromptFiles();
      const workspaceDir = path.join(testUserDataDir, 'workspace-no-overrides');
      fs.mkdirSync(workspaceDir, { recursive: true });

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: workspaceDir });

      expect(prompt).toContain('Sqowe Pilot');
    });

    it('workspace override for one section does not affect others', () => {
      ensurePromptFiles();
      const workspaceDir = path.join(testUserDataDir, 'workspace2');
      const wsPromptsDir = path.join(workspaceDir, '.cowork', 'prompts');
      fs.mkdirSync(wsPromptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsPromptsDir, 'citations.md'),
        'Custom citation rules for this project.',
        'utf-8'
      );

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: workspaceDir });

      expect(prompt).toContain('Custom citation rules for this project.');
      expect(prompt).not.toContain('<citation_requirements>');
      expect(prompt).toContain('Sqowe Pilot');
      expect(prompt).toContain('<tool_behavior>');
    });

    it('disabled section is not loaded even if workspace override exists', () => {
      ensurePromptFiles();
      togglePromptSection('identity.md', false);

      const workspaceDir = path.join(testUserDataDir, 'workspace3');
      const wsPromptsDir = path.join(workspaceDir, '.cowork', 'prompts');
      fs.mkdirSync(wsPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(wsPromptsDir, 'identity.md'), 'Should not appear', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: workspaceDir });

      expect(prompt).not.toContain('Should not appear');
      expect(prompt).not.toContain('Sqowe Pilot');
    });
  });

  describe('template variables', () => {
    it('resolves {{cwd}} in prompt content', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Working in {{cwd}}', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: '/Users/test/my-project' });

      expect(prompt).toContain('Working in /Users/test/my-project');
      expect(prompt).not.toContain('{{cwd}}');
    });

    it('resolves {{project_name}} to basename of cwd', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Project: {{project_name}}', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: '/Users/test/my-awesome-project' });

      expect(prompt).toContain('Project: my-awesome-project');
    });

    it('resolves {{model}} to the active model name', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Using model: {{model}}', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: '/tmp', model: 'claude-sonnet-4' });

      expect(prompt).toContain('Using model: claude-sonnet-4');
    });

    it('resolves {{date}} to current date in YYYY-MM-DD format', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Today is {{date}}', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: '/tmp' });

      const today = new Date().toISOString().split('T')[0];
      expect(prompt).toContain(`Today is ${today}`);
    });

    it('leaves content unchanged when no template variables present', () => {
      ensurePromptFiles();
      const prompt = assembleUserPrompt({ cwd: '/tmp', model: 'test' });

      // Default content has no {{...}} so should be unchanged
      expect(prompt).toContain('Sqowe Pilot');
      expect(prompt).not.toContain('{{');
    });

    it('resolves variables in workspace override files too', () => {
      ensurePromptFiles();
      const workspaceDir = path.join(testUserDataDir, 'ws-templates');
      const wsPromptsDir = path.join(workspaceDir, '.cowork', 'prompts');
      fs.mkdirSync(wsPromptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsPromptsDir, 'identity.md'),
        'You are helping with {{project_name}} using {{model}}.',
        'utf-8'
      );

      invalidatePromptCache();
      const prompt = assembleUserPrompt({ cwd: workspaceDir, model: 'gpt-4o' });

      expect(prompt).toContain(`You are helping with ws-templates using gpt-4o.`);
    });
  });

  describe('updatePromptSection', () => {
    it('updates section content on disk', () => {
      ensurePromptFiles();
      const result = updatePromptSection('identity.md', 'New identity');

      expect(result.success).toBe(true);
      const promptsDir = path.join(testUserDataDir, 'prompts');
      expect(fs.readFileSync(path.join(promptsDir, 'identity.md'), 'utf-8')).toBe('New identity');
    });

    it('rejects unknown section filenames', () => {
      ensurePromptFiles();
      const result = updatePromptSection('unknown.md', 'content');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown section');
    });

    it('invalidates cache after update', () => {
      ensurePromptFiles();
      const before = assembleUserPrompt();
      updatePromptSection('identity.md', 'Changed identity');
      const after = assembleUserPrompt();

      expect(before).not.toBe(after);
      expect(after).toContain('Changed identity');
    });
  });

  describe('resetPromptSection', () => {
    it('restores default content', () => {
      ensurePromptFiles();
      updatePromptSection('identity.md', 'Custom content');
      const result = resetPromptSection('identity.md');

      expect(result.success).toBe(true);
      const sections = loadPromptSections();
      const identity = sections.find((s) => s.filename === 'identity.md');
      expect(identity?.isDefault).toBe(true);
    });

    it('rejects unknown section filenames', () => {
      const result = resetPromptSection('hacker.md');
      expect(result.success).toBe(false);
    });
  });

  describe('resetAllPromptSections', () => {
    it('resets all sections to defaults and re-enables all', () => {
      ensurePromptFiles();
      updatePromptSection('identity.md', 'Custom identity');
      updatePromptSection('citations.md', 'Custom citations');
      togglePromptSection('tool-routing.md', false);

      const result = resetAllPromptSections();
      expect(result.success).toBe(true);

      invalidatePromptCache();
      const sections = loadPromptSections();
      for (const s of sections) {
        expect(s.isDefault).toBe(true);
        expect(s.enabled).toBe(true);
      }
    });

    it('returns error when directory is inaccessible', () => {
      // Make userData a file to block directory creation
      fs.rmSync(testUserDataDir, { recursive: true, force: true });
      fs.writeFileSync(testUserDataDir, 'blocking', 'utf-8');

      const result = resetAllPromptSections();
      expect(result.success).toBe(false);

      // Cleanup
      fs.unlinkSync(testUserDataDir);
      fs.mkdirSync(testUserDataDir, { recursive: true });
    });

    it('rolls back on partial write failure', () => {
      ensurePromptFiles();
      // Customize sections first
      updatePromptSection('identity.md', 'My custom identity');
      updatePromptSection('behavioral-rules.md', 'My custom rules');

      const promptsDir = path.join(testUserDataDir, 'prompts');
      const citationsPath = path.join(promptsDir, 'citations.md');

      // Make citations.md unwritable to trigger write failure
      // (readable for snapshot, but write will fail)
      fs.chmodSync(citationsPath, 0o444);

      invalidatePromptCache();
      const result = resetAllPromptSections();

      // Restore permissions for cleanup
      fs.chmodSync(citationsPath, 0o644);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rolled back');

      // Verify rollback: identity.md should still have custom content
      invalidatePromptCache();
      const sections = loadPromptSections();
      const identity = sections.find((s) => s.filename === 'identity.md');
      expect(identity?.content).toBe('My custom identity');
    });

    it('restores _meta.json disabled state on rollback', () => {
      ensurePromptFiles();
      togglePromptSection('identity.md', false);
      togglePromptSection('citations.md', false);

      const promptsDir = path.join(testUserDataDir, 'prompts');
      const toolRoutingPath = path.join(promptsDir, 'tool-routing.md');

      // Make tool-routing.md unwritable (readable for snapshot, write fails)
      fs.chmodSync(toolRoutingPath, 0o444);

      invalidatePromptCache();
      const result = resetAllPromptSections();

      // Restore permissions
      fs.chmodSync(toolRoutingPath, 0o644);

      expect(result.success).toBe(false);

      // Verify _meta.json was restored — disabled sections should still be disabled
      invalidatePromptCache();
      const sections = loadPromptSections();
      const identity = sections.find((s) => s.filename === 'identity.md');
      const citations = sections.find((s) => s.filename === 'citations.md');
      expect(identity?.enabled).toBe(false);
      expect(citations?.enabled).toBe(false);
    });

    it('aborts without writing if backup read fails', () => {
      ensurePromptFiles();
      updatePromptSection('identity.md', 'Custom before abort');

      const promptsDir = path.join(testUserDataDir, 'prompts');

      // Make behavioral-rules.md unreadable (but it exists)
      const rulesPath = path.join(promptsDir, 'behavioral-rules.md');
      fs.chmodSync(rulesPath, 0o000);

      invalidatePromptCache();
      const result = resetAllPromptSections();

      // Restore permissions for cleanup
      fs.chmodSync(rulesPath, 0o644);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot snapshot');
      expect(result.error).toContain('Aborting reset');

      // Verify no writes happened — identity.md still has custom content
      invalidatePromptCache();
      const sections = loadPromptSections();
      const identity = sections.find((s) => s.filename === 'identity.md');
      expect(identity?.content).toBe('Custom before abort');
    });

    it('includes the failing file in rollback (not just previously written files)', () => {
      ensurePromptFiles();
      updatePromptSection('identity.md', 'Original identity');
      updatePromptSection('citations.md', 'Original citations');

      const promptsDir = path.join(testUserDataDir, 'prompts');

      // Make citations.md unwritable — snapshot can read it, but write will fail
      const citationsPath = path.join(promptsDir, 'citations.md');
      fs.chmodSync(citationsPath, 0o444);

      invalidatePromptCache();
      const result = resetAllPromptSections();

      // Restore permissions
      fs.chmodSync(citationsPath, 0o644);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rolled back');

      // identity.md was written before the failure — should be rolled back
      invalidatePromptCache();
      const sections = loadPromptSections();
      expect(sections.find((s) => s.filename === 'identity.md')?.content).toBe('Original identity');
      // citations.md write failed — content should still be original
      expect(sections.find((s) => s.filename === 'citations.md')?.content).toBe(
        'Original citations'
      );
    });

    it('restores _meta.json when meta write fails (all section writes succeed)', () => {
      ensurePromptFiles();
      togglePromptSection('identity.md', false);

      const promptsDir = path.join(testUserDataDir, 'prompts');
      const metaPath = path.join(promptsDir, '_meta.json');

      // Make _meta.json unwritable — snapshot can read it, but write will fail
      fs.chmodSync(metaPath, 0o444);

      invalidatePromptCache();
      const result = resetAllPromptSections();

      // Restore permissions
      fs.chmodSync(metaPath, 0o644);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rolled back');

      // _meta.json should be restored — identity.md should still be disabled
      invalidatePromptCache();
      const sections = loadPromptSections();
      const identity = sections.find((s) => s.filename === 'identity.md');
      expect(identity?.enabled).toBe(false);
    });
  });

  describe('togglePromptSection', () => {
    it('disables a section and persists to _meta.json', () => {
      ensurePromptFiles();
      const result = togglePromptSection('citations.md', false);

      expect(result.success).toBe(true);

      const metaPath = path.join(testUserDataDir, 'prompts', '_meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.disabled).toContain('citations.md');
    });

    it('re-enables a section', () => {
      ensurePromptFiles();
      togglePromptSection('citations.md', false);
      togglePromptSection('citations.md', true);

      const metaPath = path.join(testUserDataDir, 'prompts', '_meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.disabled).not.toContain('citations.md');
    });

    it('rejects unknown section filenames', () => {
      const result = togglePromptSection('evil.md', true);
      expect(result.success).toBe(false);
    });

    it('does not duplicate entries when disabling twice', () => {
      ensurePromptFiles();
      togglePromptSection('citations.md', false);
      togglePromptSection('citations.md', false);

      const metaPath = path.join(testUserDataDir, 'prompts', '_meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const count = meta.disabled.filter((f: string) => f === 'citations.md').length;
      expect(count).toBe(1);
    });
  });

  describe('getPromptsDirPath', () => {
    it('returns the prompts directory path', () => {
      const dir = getPromptsDirPath();
      expect(dir).toBe(path.join(testUserDataDir, 'prompts'));
    });
  });

  describe('getSectionOrder', () => {
    it('returns the ordered list of section filenames', () => {
      const order = getSectionOrder();
      expect(order).toEqual([
        'identity.md',
        'behavioral-rules.md',
        'citations.md',
        'tool-routing.md',
      ]);
    });
  });

  describe('getDefaultContent', () => {
    it('returns default content for known sections', () => {
      const content = getDefaultContent('identity.md');
      expect(content).toContain('Sqowe Pilot');
    });

    it('returns null for unknown sections', () => {
      expect(getDefaultContent('unknown.md')).toBeNull();
    });
  });

  describe('openPromptsDir', () => {
    it('calls shell.openPath with the prompts directory', async () => {
      ensurePromptFiles();
      const result = await openPromptsDir();
      expect(result.success).toBe(true);
    });

    it('returns failure when shell.openPath returns an error string', async () => {
      const { shell } = await import('electron');
      vi.mocked(shell.openPath).mockResolvedValueOnce('No application found to open directory');

      ensurePromptFiles();
      const result = await openPromptsDir();
      expect(result.success).toBe(false);
      expect(result.error).toContain('No application found');
    });
  });

  describe('failure paths', () => {
    it('updatePromptSection returns error for write failures', () => {
      ensurePromptFiles();
      // Make the prompts dir read-only to trigger write failure
      const promptsDir = path.join(testUserDataDir, 'prompts');
      const filePath = path.join(promptsDir, 'identity.md');
      // Remove the file and make dir read-only
      fs.chmodSync(promptsDir, 0o444);

      const result = updatePromptSection('identity.md', 'new content');
      // Restore permissions for cleanup
      fs.chmodSync(promptsDir, 0o755);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('resetPromptSection returns error for write failures', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.chmodSync(promptsDir, 0o444);

      const result = resetPromptSection('identity.md');
      fs.chmodSync(promptsDir, 0o755);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('cache invalidation on external edits', () => {
    it('assembleUserPrompt always reflects external file edits (no caching)', () => {
      ensurePromptFiles();
      // First call
      const before = assembleUserPrompt();
      expect(before).toContain('Sqowe Pilot');

      // External edit (simulating user editing via Finder)
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Externally modified', 'utf-8');

      // Next call immediately reflects the change (no cache)
      const after = assembleUserPrompt();
      expect(after).toContain('Externally modified');
      expect(after).not.toContain('Sqowe Pilot');
    });

    it('invalidatePromptCache causes loadPromptSections to re-read from disk', () => {
      ensurePromptFiles();
      // First load — caches sections for UI
      const sectionsBefore = loadPromptSections();
      expect(sectionsBefore[0].content).toContain('Sqowe Pilot');

      // External edit
      const promptsDir = path.join(testUserDataDir, 'prompts');
      fs.writeFileSync(path.join(promptsDir, 'identity.md'), 'Externally modified', 'utf-8');

      // Without invalidation, loadPromptSections returns cached
      const stillCached = loadPromptSections();
      expect(stillCached[0].content).toContain('Sqowe Pilot');

      // After invalidation, picks up external edit
      invalidatePromptCache();
      const afterInvalidate = loadPromptSections();
      expect(afterInvalidate[0].content).toContain('Externally modified');
    });
  });

  describe('togglePromptSection write failure', () => {
    it('returns failure when _meta.json cannot be written', () => {
      ensurePromptFiles();
      const promptsDir = path.join(testUserDataDir, 'prompts');
      // Create a directory named _meta.json to block file write
      const metaPath = path.join(promptsDir, '_meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      fs.mkdirSync(metaPath);

      const result = togglePromptSection('citations.md', false);

      // Cleanup
      fs.rmdirSync(metaPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('malformed _meta.json recovery', () => {
    it('falls back to empty disabled list when _meta.json is invalid JSON', () => {
      ensurePromptFiles();
      const metaPath = path.join(testUserDataDir, 'prompts', '_meta.json');
      fs.writeFileSync(metaPath, 'not valid json {{{', 'utf-8');

      invalidatePromptCache();
      const sections = loadPromptSections();
      // All sections should be enabled (fallback)
      for (const s of sections) {
        expect(s.enabled).toBe(true);
      }
    });

    it('falls back when _meta.json has wrong structure', () => {
      ensurePromptFiles();
      const metaPath = path.join(testUserDataDir, 'prompts', '_meta.json');
      fs.writeFileSync(metaPath, JSON.stringify({ disabled: 'not-an-array' }), 'utf-8');

      invalidatePromptCache();
      const sections = loadPromptSections();
      for (const s of sections) {
        expect(s.enabled).toBe(true);
      }
    });
  });

  describe('startup failure handling', () => {
    it('ensurePromptFiles returns false when directory cannot be created', () => {
      // Make userData path a file to block mkdir
      fs.rmSync(testUserDataDir, { recursive: true, force: true });
      fs.writeFileSync(testUserDataDir, 'blocking file', 'utf-8');

      const result = ensurePromptFiles();
      expect(result).toBe(false);

      // Cleanup
      fs.unlinkSync(testUserDataDir);
      fs.mkdirSync(testUserDataDir, { recursive: true });
    });

    it('assembleUserPrompt returns defaults when directory is unavailable', () => {
      // Make userData path a file to block mkdir
      fs.rmSync(testUserDataDir, { recursive: true, force: true });
      fs.writeFileSync(testUserDataDir, 'blocking file', 'utf-8');

      invalidatePromptCache();
      const prompt = assembleUserPrompt();
      // Should still return content from in-memory defaults
      expect(prompt).toContain('Sqowe Pilot');
      expect(prompt).toContain('CRITICAL BEHAVIORAL RULES');

      // Cleanup
      fs.unlinkSync(testUserDataDir);
      fs.mkdirSync(testUserDataDir, { recursive: true });
    });
  });
});
