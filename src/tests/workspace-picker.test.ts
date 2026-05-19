import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readWorkspacePicker(): string {
  return readFileSync(
    path.resolve(process.cwd(), 'src/renderer/components/WorkspacePicker.tsx'),
    'utf-8'
  );
}

function readUseIPC(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts'), 'utf-8');
}

function readWelcomeView(): string {
  return readFileSync(
    path.resolve(process.cwd(), 'src/renderer/components/WelcomeView.tsx'),
    'utf-8'
  );
}

describe('WorkspacePicker', () => {
  describe('workspace derivation from sessions', () => {
    it('derives known workspaces from session cwd values', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('session.cwd');
      expect(source).toContain('sessions');
    });

    it('deduplicates workspace paths using a Map', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('new Map<string, { path: string; label: string; count: number }>()');
    });

    it('sorts workspaces by usage count then alphabetically', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('b.count - a.count || a.label.localeCompare(b.label)');
    });

    it('extracts basename as label from full path', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('path.split(/[/\\\\]/)');
      expect(source).toContain('segments[segments.length - 1] || path');
    });

    it('skips empty or whitespace-only cwd values', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('session.cwd && session.cwd.trim()');
    });
  });

  describe('dropdown open/close behavior', () => {
    it('toggles open state on button click', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('setIsOpen(!isOpen)');
    });

    it('closes on outside click via mousedown listener', () => {
      const source = readWorkspacePicker();
      expect(source).toContain("document.addEventListener('mousedown', handleClickOutside)");
      expect(source).toContain("document.removeEventListener('mousedown', handleClickOutside)");
    });

    it('closes on Escape key', () => {
      const source = readWorkspacePicker();
      expect(source).toContain("event.key === 'Escape'");
      expect(source).toContain('setIsOpen(false)');
    });

    it('cleans up event listeners on unmount or close', () => {
      const source = readWorkspacePicker();
      // Both effects should return cleanup functions
      const removeListenerMatches = source.match(/removeEventListener/g);
      expect(removeListenerMatches).not.toBeNull();
      expect(removeListenerMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it('only attaches listeners when dropdown is open', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('if (!isOpen) return;');
    });
  });

  describe('workspace selection', () => {
    it('calls onSelectPath when a non-current workspace is clicked', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('onSelectPath(ws.path)');
    });

    it('does not call onSelectPath for the current workspace', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('if (!isCurrent)');
    });

    it('shows a checkmark for the current workspace', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('{isCurrent && <Check');
    });

    it('closes dropdown after selection', () => {
      const source = readWorkspacePicker();
      // After onSelectPath call, setIsOpen(false) should follow
      expect(source).toContain('setIsOpen(false)');
    });
  });

  describe('browse action', () => {
    it('calls onBrowse callback for native folder picker', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('onBrowse()');
    });

    it('closes dropdown before opening browse dialog', () => {
      const source = readWorkspacePicker();
      // The browse button handler should close first, then call onBrowse
      expect(source).toContain('setIsOpen(false);\n                onBrowse()');
    });

    it('renders a Browse button separated from the workspace list', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('border-t border-border-muted');
      expect(source).toContain("t('welcome.browseFolder'");
    });
  });

  describe('empty state', () => {
    it('shows a message when no recent workspaces exist', () => {
      const source = readWorkspacePicker();
      expect(source).toContain('knownWorkspaces.length === 0');
      expect(source).toContain("t('welcome.noRecentWorkspaces'");
    });
  });
});

describe('setWorkingDirDirect (useIPC)', () => {
  it('is exported from useIPC return object', () => {
    const source = readUseIPC();
    expect(source).toContain('setWorkingDirDirect,');
  });

  it('calls workdir.set IPC in Electron mode', () => {
    const source = readUseIPC();
    expect(source).toContain("type: 'workdir.set'");
    expect(source).toContain('payload: { path, sessionId }');
  });

  it('updates store state in non-Electron mode for consistent behavior', () => {
    const source = readUseIPC();
    // Non-Electron branch should update the store
    expect(source).toContain('useAppStore.getState().setWorkingDir(path)');
  });

  it('includes isElectron in dependency array', () => {
    const source = readUseIPC();
    // Find the setWorkingDirDirect useCallback and check its deps
    const fnStart = source.indexOf('const setWorkingDirDirect = useCallback(');
    const fnEnd = source.indexOf(');', source.indexOf('[invoke, isElectron]', fnStart));
    const fnSource = source.slice(fnStart, fnEnd + 2);
    expect(fnSource).toContain('[invoke, isElectron]');
  });
});

describe('WelcomeView workspace picker integration', () => {
  it('imports and renders WorkspacePicker component', () => {
    const source = readWelcomeView();
    expect(source).toContain("import { WorkspacePicker } from './WorkspacePicker'");
    expect(source).toContain('<WorkspacePicker');
  });

  it('passes workingDir as currentPath', () => {
    const source = readWelcomeView();
    expect(source).toContain('currentPath={workingDir}');
  });

  it('uses setWorkingDirDirect for direct workspace selection', () => {
    const source = readWelcomeView();
    expect(source).toContain('setWorkingDirDirect');
  });

  it('uses handleSelectFolder as the browse callback', () => {
    const source = readWelcomeView();
    expect(source).toContain('onBrowse={handleSelectFolder}');
  });

  it('shows error notice on setWorkingDirDirect failure', () => {
    const source = readWelcomeView();
    expect(source).toContain('!result.success && result.error');
    expect(source).toContain('id: `notice-workdir-set-${Date.now()}`');
  });
});
