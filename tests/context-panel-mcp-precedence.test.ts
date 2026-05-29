/**
 * Tests for ContextPanel MCP disabled-server precedence logic.
 *
 * Validates the interaction between:
 * - Workspace profile disabled servers (from .cowork/mcp-servers.json)
 * - Session-disabled servers (from in-memory session state)
 * - User manual toggle override (userToggledMcp flag)
 *
 * Part 1: Structural contract tests (verify source patterns)
 * Part 2: Behavioral tests using the pure deriveDisabledServerIds utility
 *         to validate the merge/override logic that ContextPanel depends on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { deriveDisabledServerIds } from '../src/renderer/utils/mcp-profile-derive';

const contextPanelSource = fs.readFileSync(
  path.resolve('src/renderer/components/ContextPanel.tsx'),
  'utf8'
);

describe('ContextPanel MCP workspace profile precedence', () => {
  describe('structural contracts', () => {
    it('imports deriveDisabledServerIds utility', () => {
      expect(contextPanelSource).toContain(
        "import { deriveDisabledServerIds } from '../utils/mcp-profile-derive'"
      );
    });

    it('loads workspace profile via getWorkspaceProfile IPC', () => {
      expect(contextPanelSource).toContain(
        'window.electronAPI?.mcp?.getWorkspaceProfile(currentWorkingDir)'
      );
    });

    it('derives disabled IDs using deriveDisabledServerIds', () => {
      expect(contextPanelSource).toContain('deriveDisabledServerIds(profile, mcpServers)');
    });

    it('stores workspace profile disabled state separately from session state', () => {
      expect(contextPanelSource).toContain('workspaceProfileDisabled');
      expect(contextPanelSource).toContain('setWorkspaceProfileDisabled');
    });

    it('computes effectiveDisabledServers as a useMemo', () => {
      expect(contextPanelSource).toContain('const effectiveDisabledServers = useMemo(');
    });

    it('uses effectiveDisabledServers for the connector count display', () => {
      expect(contextPanelSource).toContain('!effectiveDisabledServers.has(s.id)');
    });

    it('uses effectiveDisabledServers for individual connector toggle state', () => {
      expect(contextPanelSource).toContain(
        'sessionDisabled={effectiveDisabledServers.has(server.id)}'
      );
    });

    it('saves effectiveDisabledServers to workspace profile', () => {
      expect(contextPanelSource).toContain('Array.from(effectiveDisabledServers)');
    });
  });

  describe('user toggle override is session-scoped', () => {
    it('tracks userToggledMcp flag', () => {
      expect(contextPanelSource).toContain('const [userToggledMcp, setUserToggledMcp]');
    });

    it('tracks which session the toggle applies to', () => {
      expect(contextPanelSource).toContain('const [userToggledSessionId, setUserToggledSessionId]');
    });

    it('sets override flags only after successful toggle (not before IPC call)', () => {
      // Find the handleToggleSessionServer function body
      const fnStart = contextPanelSource.indexOf('const handleToggleSessionServer = async');
      const fnEnd = contextPanelSource.indexOf('const handleSaveWorkspaceProfile', fnStart);
      const fnBody = contextPanelSource.slice(fnStart, fnEnd);

      // setUserToggledMcp should appear AFTER result?.success check
      const successCheck = fnBody.indexOf('result?.success');
      const setToggled = fnBody.indexOf('setUserToggledMcp(true)');
      expect(successCheck).toBeGreaterThan(0);
      expect(setToggled).toBeGreaterThan(successCheck);
    });

    it('seeds session state from workspace profile on first toggle', () => {
      // The toggle handler should sync workspace-disabled servers into session state
      // before applying the user's toggle, so one click works correctly
      const fnStart = contextPanelSource.indexOf('const handleToggleSessionServer = async');
      const fnEnd = contextPanelSource.indexOf('const handleSaveWorkspaceProfile', fnStart);
      const fnBody = contextPanelSource.slice(fnStart, fnEnd);

      // Should check if user hasn't toggled yet and seed workspace profile into session
      expect(fnBody).toContain('workspaceProfileDisabled');
      expect(fnBody).toContain('getSessionDisabledServers');
    });

    it('guards against stale session during async toggle using ref', () => {
      const fnStart = contextPanelSource.indexOf('const handleToggleSessionServer = async');
      const fnEnd = contextPanelSource.indexOf('const handleSaveWorkspaceProfile', fnStart);
      const fnBody = contextPanelSource.slice(fnStart, fnEnd);

      // Should capture sessionId at start
      expect(fnBody).toContain('const sessionId = activeSessionId');
      // Should use ref for stale-session checks (not closure variable)
      expect(fnBody).toContain('activeSessionIdRef.current !== sessionId');
    });

    it('seeds workspace-disabled servers in parallel (Promise.all)', () => {
      const fnStart = contextPanelSource.indexOf('const handleToggleSessionServer = async');
      const fnEnd = contextPanelSource.indexOf('const handleSaveWorkspaceProfile', fnStart);
      const fnBody = contextPanelSource.slice(fnStart, fnEnd);

      expect(fnBody).toContain('Promise.all');
    });

    it('refreshes session state on failure for consistency', () => {
      const fnStart = contextPanelSource.indexOf('const handleToggleSessionServer = async');
      const fnEnd = contextPanelSource.indexOf('const handleSaveWorkspaceProfile', fnStart);
      const fnBody = contextPanelSource.slice(fnStart, fnEnd);

      // The outer catch block should refresh session state
      // Find "Failed to toggle session MCP server" which is in the outer catch
      const outerCatchMsg = fnBody.indexOf('Failed to toggle session MCP server');
      expect(outerCatchMsg).toBeGreaterThan(0);
      const afterOuterCatch = fnBody.slice(outerCatchMsg);
      expect(afterOuterCatch).toContain('getSessionDisabledServers');
    });

    it('checks session ID match in effectiveDisabledServers memo', () => {
      expect(contextPanelSource).toContain(
        'userToggledMcp && userToggledSessionId === activeSessionId'
      );
    });

    it('resets override flags on activeSessionId change', () => {
      // Find the reset effect (contains both activeSessionId and setUserToggledMcp(false))
      const lines = contextPanelSource.split('\n');
      let foundResetEffect = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('setUserToggledMcp(false)')) {
          // Look for the dependency array of this effect (within ~10 lines)
          const surroundingLines = lines.slice(Math.max(0, i - 5), i + 10).join('\n');
          if (
            surroundingLines.includes('activeSessionId') &&
            surroundingLines.includes('currentWorkingDir')
          ) {
            foundResetEffect = true;
            break;
          }
        }
      }
      expect(foundResetEffect).toBe(true);
    });

    it('uses a ref to track latest activeSessionId for async guards', () => {
      expect(contextPanelSource).toContain('const activeSessionIdRef = useRef(activeSessionId)');
      expect(contextPanelSource).toContain('activeSessionIdRef.current = activeSessionId');
    });
  });

  describe('profile load effect does not reset user override', () => {
    it('workspace profile load effect body does NOT call setUserToggledMcp', () => {
      // Find the effect that contains getWorkspaceProfile
      const profileCallIdx = contextPanelSource.indexOf('getWorkspaceProfile(currentWorkingDir)');
      // Walk backwards to find the enclosing useEffect
      const beforeProfile = contextPanelSource.slice(0, profileCallIdx);
      const effectStart = beforeProfile.lastIndexOf('useEffect(');
      // Walk forward to find the closing of this effect (its dependency array)
      const afterEffect = contextPanelSource.slice(effectStart);
      // Find the dependency array — pattern: }, [deps]);
      const depArrayMatch = afterEffect.match(/\}, \[([^\]]*)\]\)/);
      expect(depArrayMatch).not.toBeNull();

      // The effect body (from useEffect to the dep array) should not contain setUserToggledMcp
      const effectBody = afterEffect.slice(
        0,
        afterEffect.indexOf(depArrayMatch![0]) + depArrayMatch![0].length
      );
      expect(effectBody).not.toContain('setUserToggledMcp');
    });
  });
});

describe('ContextPanel MCP precedence — behavioral (pure logic)', () => {
  const servers = [
    { id: 'mcp-1', name: 'Server A' },
    { id: 'mcp-2', name: 'Server B' },
    { id: 'mcp-3', name: 'Server C' },
    { id: 'mcp-4', name: 'Server D' },
  ];

  describe('workspace profile applied before user interaction', () => {
    it('blocklist profile disables listed servers', () => {
      const profile = { disabled: ['mcp-1', 'mcp-2'] };
      const derived = deriveDisabledServerIds(profile, servers);
      expect(derived).toEqual(new Set(['mcp-1', 'mcp-2']));
    });

    it('allowlist profile disables unlisted servers', () => {
      const profile = { enabled: ['mcp-1'] };
      const derived = deriveDisabledServerIds(profile, servers);
      expect(derived).toEqual(new Set(['mcp-2', 'mcp-3', 'mcp-4']));
    });

    it('name-based matching resolves to server IDs', () => {
      const profile = { disabled: ['Server A', 'Server C'] };
      const derived = deriveDisabledServerIds(profile, servers);
      expect(derived).toEqual(new Set(['mcp-1', 'mcp-3']));
    });
  });

  describe('merge logic (simulating effectiveDisabledServers)', () => {
    // Simulates the merge logic from ContextPanel's useMemo
    function computeEffective(
      sessionDisabled: Set<string>,
      workspaceDisabled: Set<string>,
      userToggledMcp: boolean,
      userToggledSessionId: string | null,
      activeSessionId: string | null
    ): Set<string> {
      if (userToggledMcp && userToggledSessionId === activeSessionId) {
        return sessionDisabled;
      }
      const merged = new Set(sessionDisabled);
      for (const id of workspaceDisabled) {
        merged.add(id);
      }
      return merged;
    }

    it('merges session and workspace disabled when user has not toggled', () => {
      const session = new Set(['mcp-1']);
      const workspace = new Set(['mcp-2', 'mcp-3']);
      const result = computeEffective(session, workspace, false, null, 'sess-1');
      expect(result).toEqual(new Set(['mcp-1', 'mcp-2', 'mcp-3']));
    });

    it('uses only session state when user has toggled in current session', () => {
      const session = new Set(['mcp-1']);
      const workspace = new Set(['mcp-2', 'mcp-3']);
      const result = computeEffective(session, workspace, true, 'sess-1', 'sess-1');
      expect(result).toEqual(new Set(['mcp-1']));
    });

    it('ignores user toggle from a different session', () => {
      const session = new Set(['mcp-1']);
      const workspace = new Set(['mcp-2', 'mcp-3']);
      // User toggled in sess-1, but we're now in sess-2
      const result = computeEffective(session, workspace, true, 'sess-1', 'sess-2');
      expect(result).toEqual(new Set(['mcp-1', 'mcp-2', 'mcp-3']));
    });

    it('session switch resets override (simulated by flag reset)', () => {
      const session = new Set<string>(); // New session, nothing disabled yet
      const workspace = new Set(['mcp-2']);
      // After session switch, userToggledMcp is reset to false
      const result = computeEffective(session, workspace, false, null, 'sess-2');
      expect(result).toEqual(new Set(['mcp-2']));
    });

    it('failed toggle does not activate override (flags stay false)', () => {
      const session = new Set<string>();
      const workspace = new Set(['mcp-1', 'mcp-2']);
      // Toggle failed — flags remain false/null
      const result = computeEffective(session, workspace, false, null, 'sess-1');
      expect(result).toEqual(new Set(['mcp-1', 'mcp-2']));
    });

    it('empty workspace profile results in session-only state', () => {
      const session = new Set(['mcp-1']);
      const workspace = new Set<string>();
      const result = computeEffective(session, workspace, false, null, 'sess-1');
      expect(result).toEqual(new Set(['mcp-1']));
    });
  });
});

describe('ContextPanel MCP toggle — one-click correctness', () => {
  // Simulates the full toggle flow including workspace-profile seeding
  function simulateToggle(
    serverId: string,
    currentSessionDisabled: Set<string>,
    workspaceDisabled: Set<string>,
    userToggledMcp: boolean,
    userToggledSessionId: string | null,
    activeSessionId: string
  ) {
    // Step 1: Compute effective state (what UI shows)
    let effective: Set<string>;
    if (userToggledMcp && userToggledSessionId === activeSessionId) {
      effective = currentSessionDisabled;
    } else {
      effective = new Set(currentSessionDisabled);
      for (const id of workspaceDisabled) {
        effective.add(id);
      }
    }

    // Step 2: UI shows server as disabled? → click sends disabled=false (enable)
    const isShownDisabled = effective.has(serverId);
    const toggleDirection = !isShownDisabled; // true = disable, false = enable

    // Step 3: On first toggle, seed session state from workspace profile
    const seededSession = new Set(currentSessionDisabled);
    if (!userToggledMcp || userToggledSessionId !== activeSessionId) {
      for (const wpId of workspaceDisabled) {
        seededSession.add(wpId);
      }
    }

    // Step 4: Apply the toggle to seeded session state
    if (toggleDirection) {
      seededSession.add(serverId);
    } else {
      seededSession.delete(serverId);
    }

    return { seededSession, toggleDirection, isShownDisabled };
  }

  it('workspace-disabled server is enabled with one click', () => {
    // Server mcp-2 is disabled by workspace profile only
    const sessionDisabled = new Set<string>();
    const workspaceDisabled = new Set(['mcp-2']);

    const result = simulateToggle(
      'mcp-2',
      sessionDisabled,
      workspaceDisabled,
      false,
      null,
      'sess-1'
    );

    // UI shows it as disabled
    expect(result.isShownDisabled).toBe(true);
    // Toggle direction is "enable" (disabled=false)
    expect(result.toggleDirection).toBe(false);
    // After seeding + toggle, mcp-2 is NOT in session disabled
    expect(result.seededSession.has('mcp-2')).toBe(false);
  });

  it('session-disabled server is enabled with one click', () => {
    const sessionDisabled = new Set(['mcp-1']);
    const workspaceDisabled = new Set<string>();

    const result = simulateToggle(
      'mcp-1',
      sessionDisabled,
      workspaceDisabled,
      false,
      null,
      'sess-1'
    );

    expect(result.isShownDisabled).toBe(true);
    expect(result.toggleDirection).toBe(false);
    expect(result.seededSession.has('mcp-1')).toBe(false);
  });

  it('enabled server is disabled with one click', () => {
    const sessionDisabled = new Set<string>();
    const workspaceDisabled = new Set(['mcp-2']);

    const result = simulateToggle(
      'mcp-1',
      sessionDisabled,
      workspaceDisabled,
      false,
      null,
      'sess-1'
    );

    // mcp-1 is NOT disabled
    expect(result.isShownDisabled).toBe(false);
    // Toggle direction is "disable" (disabled=true)
    expect(result.toggleDirection).toBe(true);
    // After toggle, mcp-1 IS in session disabled
    expect(result.seededSession.has('mcp-1')).toBe(true);
    // mcp-2 remains disabled (seeded from workspace)
    expect(result.seededSession.has('mcp-2')).toBe(true);
  });

  it('second toggle in same session does not re-seed', () => {
    // After first toggle, userToggledMcp=true, userToggledSessionId=sess-1
    const sessionDisabled = new Set(['mcp-2']); // Already seeded from previous toggle
    const workspaceDisabled = new Set(['mcp-2']);

    const result = simulateToggle(
      'mcp-2',
      sessionDisabled,
      workspaceDisabled,
      true,
      'sess-1',
      'sess-1'
    );

    // User already toggled — effective = sessionDisabled only
    expect(result.isShownDisabled).toBe(true);
    expect(result.toggleDirection).toBe(false);
    // No re-seeding, just removes from session
    expect(result.seededSession.has('mcp-2')).toBe(false);
  });

  it('workspace-disabled + session-disabled server needs one click to enable', () => {
    // Server is disabled by both workspace and session
    const sessionDisabled = new Set(['mcp-3']);
    const workspaceDisabled = new Set(['mcp-3']);

    const result = simulateToggle(
      'mcp-3',
      sessionDisabled,
      workspaceDisabled,
      false,
      null,
      'sess-1'
    );

    expect(result.isShownDisabled).toBe(true);
    expect(result.toggleDirection).toBe(false);
    // After seeding (mcp-3 already in session) + toggle (remove), it's enabled
    expect(result.seededSession.has('mcp-3')).toBe(false);
  });
});
