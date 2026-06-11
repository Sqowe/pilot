import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => {
  const electron = {
    app: {
      getName: () => 'open-cowork-test',
      getVersion: () => '0.0.0-test',
      getPath: () => '/tmp/open-cowork-test',
    },
  };
  return { ...electron, default: electron };
});

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

describe('Plugin Pinning: buildPinnedPluginsDirective', () => {
  it('agent-runner source contains buildPinnedPluginsDirective', () => {
    const agentRunnerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/claude/agent-runner.ts'),
      'utf8'
    );
    expect(agentRunnerSource).toContain('buildPinnedPluginsDirective');
    expect(agentRunnerSource).toContain('this.buildPinnedPluginsDirective(session.id)');
  });

  it('agent-runner escapes XML-sensitive characters in plugin metadata', () => {
    const agentRunnerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/claude/agent-runner.ts'),
      'utf8'
    );
    expect(agentRunnerSource).toContain('escapeXmlText');
    expect(agentRunnerSource).toContain('escapeXmlAttr');
    expect(agentRunnerSource).toContain('&amp;');
    expect(agentRunnerSource).toContain('&lt;');
    expect(agentRunnerSource).toContain('&gt;');
    expect(agentRunnerSource).toContain('&quot;');
  });

  it('agent-runner skips disabled plugins in the directive', () => {
    const agentRunnerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/claude/agent-runner.ts'),
      'utf8'
    );
    expect(agentRunnerSource).toContain('if (!plugin || !plugin.enabled) continue');
    // Also checks per-component skill enablement
    expect(agentRunnerSource).toContain('!plugin.componentsEnabled.skills');
  });

  it('agent-runner uses orchestratorSkill when present', () => {
    const agentRunnerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/claude/agent-runner.ts'),
      'utf8'
    );
    expect(agentRunnerSource).toContain('Entry point skill:');
    expect(agentRunnerSource).toContain('It coordinates the other skills in the bundle');
  });

  it('agent-runner falls back to skill count when no orchestrator', () => {
    const agentRunnerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/claude/agent-runner.ts'),
      'utf8'
    );
    expect(agentRunnerSource).toContain('plugin.componentCounts.skills');
    expect(agentRunnerSource).toContain('Use them when the task matches');
  });
});

describe('Plugin Pinning: SessionManager integration', () => {
  it('session-manager has sessionPinnedPlugins state and methods', () => {
    const sessionManagerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/session/session-manager.ts'),
      'utf8'
    );
    expect(sessionManagerSource).toContain('sessionPinnedPlugins');
    expect(sessionManagerSource).toContain('toggleSessionPluginPin');
    expect(sessionManagerSource).toContain('getSessionPinnedPlugins');
  });

  it('session-manager validates plugin exists before pinning', () => {
    const sessionManagerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/session/session-manager.ts'),
      'utf8'
    );
    expect(sessionManagerSource).toContain('Plugin not found:');
    expect(sessionManagerSource).toContain('Plugin is disabled:');
    expect(sessionManagerSource).toContain('Plugin has no enabled skills:');
  });

  it('session-manager cleans up pinned plugins on session delete', () => {
    const sessionManagerSource = fs.readFileSync(
      path.join(__dirname, '../src/main/session/session-manager.ts'),
      'utf8'
    );
    expect(sessionManagerSource).toContain('this.sessionPinnedPlugins.delete(sessionId)');
  });
});

describe('Plugin Pinning: IPC and preload', () => {
  it('preload exposes getSessionPinnedPlugins and toggleSessionPluginPin', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
    expect(preloadSource).toContain("'plugins.getSessionPinnedPlugins'");
    expect(preloadSource).toContain("'plugins.toggleSessionPluginPin'");
  });

  it('main index registers IPC handlers for plugin pinning', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
    expect(mainSource).toContain("'plugins.getSessionPinnedPlugins'");
    expect(mainSource).toContain("'plugins.toggleSessionPluginPin'");
  });
});

describe('Plugin Pinning: Renderer ContextPanel', () => {
  it('ContextPanel includes plugin pinning UI', () => {
    const contextPanelSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/components/ContextPanel.tsx'),
      'utf8'
    );
    expect(contextPanelSource).toContain('handleTogglePluginPin');
    expect(contextPanelSource).toContain('sessionPinnedPlugins');
    expect(contextPanelSource).toContain('installedPlugins');
    expect(contextPanelSource).toContain("t('context.plugins')");
  });

  it('ContextPanel displays stale pinned plugins with unpin action', () => {
    const contextPanelSource = fs.readFileSync(
      path.join(__dirname, '../src/renderer/components/ContextPanel.tsx'),
      'utf8'
    );
    // Verify stale plugins are displayed with localized unavailable label
    expect(contextPanelSource).toContain("t('context.pluginUnavailable')");
    // Verify stale pinned plugins are rendered separately
    expect(contextPanelSource).toContain('Stale pinned plugins');
  });
});
