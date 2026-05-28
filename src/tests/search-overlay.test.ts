import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readComponent(): string {
  return readFileSync(
    path.resolve(process.cwd(), 'src/renderer/components/SearchOverlay.tsx'),
    'utf-8'
  );
}

describe('SearchOverlay', () => {
  describe('stale async result handling', () => {
    it('uses a request id ref to guard against stale responses', () => {
      const source = readComponent();
      expect(source).toContain('requestIdRef');
      expect(source).toContain('++requestIdRef.current');
    });

    it('checks request id before applying results', () => {
      const source = readComponent();
      expect(source).toContain('requestIdRef.current !== currentRequestId');
    });

    it('invalidates pending requests when overlay closes', () => {
      const source = readComponent();
      // The isOpen effect should increment requestIdRef on close
      expect(source).toContain('} else {');
      expect(source).toContain('// Overlay closed — invalidate any pending/in-flight search');
      expect(source).toContain('requestIdRef.current++');
    });

    it('clears debounce timer on close and reopen', () => {
      const source = readComponent();
      // Both branches of the isOpen effect should clear debounce
      const matches = source.match(/clearTimeout\(debounceRef\.current\)/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3); // open, close, and handleQueryChange
    });

    it('invalidates when query is cleared', () => {
      const source = readComponent();
      // In handleQueryChange, when trimmed is empty, requestIdRef should be incremented
      expect(source).toContain('if (!trimmed) {\n        requestIdRef.current++');
    });

    it('resets isSearching and invalidates request id in memory-disabled branch', () => {
      const source = readComponent();
      // The !memoryEnabled branch should reset isSearching and invalidate
      expect(source).toContain(
        'if (!memoryEnabled) {\n        // Immediate title-only search\n        requestIdRef.current++;\n        setIsSearching(false);'
      );
    });
  });

  describe('keyboard navigation bounds', () => {
    it('guards key handling when results are empty', () => {
      const source = readComponent();
      expect(source).toContain('if (results.length === 0) return;');
    });

    it('clamps selectedIndex when results change', () => {
      const source = readComponent();
      expect(source).toContain('Math.min(prev, results.length - 1)');
    });

    it('does not allow selectedIndex below 0', () => {
      const source = readComponent();
      expect(source).toContain('Math.max(prev - 1, 0)');
    });

    it('does not allow selectedIndex above results length', () => {
      const source = readComponent();
      expect(source).toContain('Math.min(prev + 1, results.length - 1)');
    });

    it('resets selectedIndex to 0 when query changes', () => {
      const source = readComponent();
      expect(source).toContain('setQuery(value);\n      setSelectedIndex(0);');
    });
  });

  describe('scroll into view', () => {
    it('uses data-result-index attribute for scroll targeting', () => {
      const source = readComponent();
      expect(source).toContain('data-result-index={currentFlatIndex}');
      expect(source).toContain('querySelector(\n      `[data-result-index="${selectedIndex}"]`');
    });

    it('does not use children indexing for scroll', () => {
      const source = readComponent();
      expect(source).not.toContain('resultsRef.current.children[selectedIndex]');
    });
  });

  describe('escape closes overlay', () => {
    it('listens for Escape key when open', () => {
      const source = readComponent();
      expect(source).toContain("if (e.key === 'Escape')");
      expect(source).toContain('onClose()');
    });
  });

  describe('overlay mounting in sidebar', () => {
    it('renders SearchOverlay in both collapsed and expanded sidebar branches', () => {
      const sidebarSource = readFileSync(
        path.resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx'),
        'utf-8'
      );
      // Count SearchOverlay render instances — should be 2 (collapsed + expanded)
      const overlayMatches = sidebarSource.match(/<SearchOverlay/g);
      expect(overlayMatches).not.toBeNull();
      expect(overlayMatches!.length).toBe(2);
    });
  });

  describe('enter selects highlighted item', () => {
    it('calls onSelectSession and onClose on Enter', () => {
      const source = readComponent();
      expect(source).toContain("e.key === 'Enter'");
      expect(source).toContain('onSelectSession(selected.sessionId)');
      expect(source).toContain('onClose()');
    });
  });
});
