import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/claude/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');

const configStorePath = path.resolve(process.cwd(), 'src/main/config/config-store.ts');
const configStoreContent = readFileSync(configStorePath, 'utf8');

const mcpManagerPath = path.resolve(process.cwd(), 'src/main/mcp/mcp-manager.ts');
const mcpManagerContent = readFileSync(mcpManagerPath, 'utf8');

const settingsSkillsPath = path.resolve(
  process.cwd(),
  'src/renderer/components/settings/SettingsSkills.tsx'
);
const settingsSkillsContent = readFileSync(settingsSkillsPath, 'utf8');

const mainIndexPath = path.resolve(process.cwd(), 'src/main/index.ts');
const mainIndexContent = readFileSync(mainIndexPath, 'utf8');

describe('localDevPath feature', () => {
  describe('config-store persistence', () => {
    it('declares localDevPath in AppConfig interface', () => {
      expect(configStoreContent).toContain('localDevPath?: string');
    });

    it('includes localDevPath in DIRECT_READ_KEYS', () => {
      expect(configStoreContent).toContain("'localDevPath'");
    });

    it('sets empty string as default for localDevPath', () => {
      expect(configStoreContent).toContain("localDevPath: ''");
    });

    it('normalizes localDevPath as string in normalizeConfig', () => {
      expect(configStoreContent).toContain(
        "typeof raw.localDevPath === 'string' ? raw.localDevPath : defaultConfig.localDevPath"
      );
    });

    it('persists localDevPath in update method', () => {
      expect(configStoreContent).toContain(
        'updates.localDevPath !== undefined ? updates.localDevPath : current.localDevPath'
      );
    });
  });

  describe('agent-runner PATH merge', () => {
    it('reads localDevPath from configStore', () => {
      expect(agentRunnerContent).toContain("configStore.get('localDevPath')");
    });

    it('uses centralized path-env utility for base PATH and localDevPath application', () => {
      expect(agentRunnerContent).toContain('setBasePath(process.env.PATH, localDevPath)');
      expect(agentRunnerContent).toContain('applyLocalDevPath(localDevPath)');
    });

    it('uses platform-aware normalization for deduplication', () => {
      // Should normalize case on win32
      expect(agentRunnerContent).toContain("platform === 'win32' ? p.toLowerCase() : p");
    });

    it('exports reapplyLocalDevPath for runtime re-application', () => {
      expect(agentRunnerContent).toContain('export function reapplyLocalDevPath()');
    });

    it('reapplyLocalDevPath delegates to centralized path-env utility', () => {
      expect(agentRunnerContent).toContain("require('../utils/path-env')");
    });
  });

  describe('MCP manager PATH merge', () => {
    it('imports configStore', () => {
      expect(mcpManagerContent).toContain("import { configStore } from '../config/config-store'");
    });

    it('reads localDevPath from configStore', () => {
      expect(mcpManagerContent).toContain("configStore.get('localDevPath')");
    });

    it('uses platform-aware deduplication', () => {
      // Should normalize case on win32 for dedup
      expect(mcpManagerContent).toContain("platform === 'win32' ? p.toLowerCase() : p");
    });

    it('exposes invalidateEnvCache method', () => {
      expect(mcpManagerContent).toContain('invalidateEnvCache(): void');
      expect(mcpManagerContent).toContain('this.cachedBaseEnv = null');
    });
  });

  describe('runtime re-application on config save', () => {
    it('detects localDevPath changes in config.save handler', () => {
      expect(mainIndexContent).toContain('newConfig.localDevPath !== previousConfig.localDevPath');
    });

    it('uses centralized applyLocalDevPath utility', () => {
      expect(mainIndexContent).toContain("require('./utils/path-env')");
      expect(mainIndexContent).toContain('applyLocalDevPath(newConfig.localDevPath)');
    });

    it('checks isBasePathSet before applying', () => {
      expect(mainIndexContent).toContain('isBasePathSet()');
    });

    it('invalidates MCP env cache after localDevPath change', () => {
      expect(mainIndexContent).toContain('mcpManager.invalidateEnvCache()');
    });
  });

  describe('IPC and preload', () => {
    it('exposes env.getEffectivePath IPC handler', () => {
      expect(mainIndexContent).toContain("ipcMain.handle('env.getEffectivePath'");
    });
  });

  describe('UI integration', () => {
    it('renders localDevPath input field', () => {
      expect(settingsSkillsContent).toContain("t('skills.localDevPathTitle')");
      expect(settingsSkillsContent).toContain("t('skills.localDevPathHint')");
    });

    it('includes save button for localDevPath', () => {
      expect(settingsSkillsContent).toContain('handleSaveLocalDevPath');
    });

    it('includes collapsible effective PATH viewer', () => {
      expect(settingsSkillsContent).toContain("t('skills.localDevPathShowEffective')");
      expect(settingsSkillsContent).toContain("t('skills.localDevPathHideEffective')");
      expect(settingsSkillsContent).toContain('handleToggleEffectivePath');
    });

    it('loads localDevPath from config on mount', () => {
      expect(settingsSkillsContent).toContain('config.localDevPath');
    });

    it('saves localDevPath via config.save API', () => {
      expect(settingsSkillsContent).toContain(
        'window.electronAPI.config.save({ localDevPath: localDevPathDraft })'
      );
    });

    it('uses electronAPI.platform for PATH delimiter (not process.platform)', () => {
      expect(settingsSkillsContent).toContain("window.electronAPI?.platform === 'win32'");
      expect(settingsSkillsContent).not.toContain("process.platform === 'win32'");
    });
  });
});
