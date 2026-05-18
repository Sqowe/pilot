import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readSidebar(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf-8');
}

describe('Sidebar resizable behavior', () => {
  describe('width initialization', () => {
    it('validates stored value with Number.isFinite to handle NaN/corruption', () => {
      const source = readSidebar();
      expect(source).toContain('Number.isFinite(parsed)');
    });

    it('clamps width between 200 and 480', () => {
      const source = readSidebar();
      expect(source).toContain('Math.max(200, Math.min(480, parsed))');
    });

    it('falls back to 280 when stored value is invalid', () => {
      const source = readSidebar();
      expect(source).toContain(
        'Number.isFinite(parsed) ? Math.max(200, Math.min(480, parsed)) : 280'
      );
    });

    it('wraps localStorage.getItem in try/catch for restricted environments', () => {
      const source = readSidebar();
      expect(source).toContain("localStorage.getItem('sidebar-width')");
      // The try block should wrap the localStorage access
      expect(source).toContain('} catch {\n      // localStorage unavailable');
    });
  });

  describe('drag lifecycle and cleanup', () => {
    it('guards against re-entrant drags', () => {
      const source = readSidebar();
      expect(source).toContain('if (isResizingRef.current) return;');
    });

    it('uses pointer events with setPointerCapture for reliable tracking', () => {
      const source = readSidebar();
      expect(source).toContain('setPointerCapture(e.pointerId)');
      expect(source).toContain('releasePointerCapture(e.pointerId)');
    });

    it('guards releasePointerCapture with hasPointerCapture and try/catch', () => {
      const source = readSidebar();
      expect(source).toContain('target.hasPointerCapture(e.pointerId)');
      // The release should be inside a try block
      const releaseIndex = source.indexOf('releasePointerCapture(e.pointerId)');
      const precedingTry = source.lastIndexOf('try {', releaseIndex);
      expect(precedingTry).toBeGreaterThan(-1);
      expect(releaseIndex - precedingTry).toBeLessThan(120);
    });

    it('listens for lostpointercapture as additional cleanup trigger', () => {
      const source = readSidebar();
      expect(source).toContain("addEventListener('lostpointercapture'");
      expect(source).toContain("removeEventListener('lostpointercapture'");
    });

    it('listens for window blur to handle pointer released outside app', () => {
      const source = readSidebar();
      expect(source).toContain("window.addEventListener('blur', cleanup)");
      expect(source).toContain("window.removeEventListener('blur', cleanup)");
    });

    it('cleanup is idempotent via isResizingRef guard', () => {
      const source = readSidebar();
      expect(source).toContain('if (!isResizingRef.current) return; // Idempotent');
    });

    it('stores cleanup function in a ref for unmount safety', () => {
      const source = readSidebar();
      expect(source).toContain('dragCleanupRef.current = cleanup');
    });

    it('cleans up on unmount via useEffect return', () => {
      const source = readSidebar();
      expect(source).toContain(
        'if (dragCleanupRef.current) {\n        dragCleanupRef.current();\n      }'
      );
    });

    it('restores body cursor and userSelect in cleanup', () => {
      const source = readSidebar();
      expect(source).toContain("document.body.style.cursor = ''");
      expect(source).toContain("document.body.style.userSelect = ''");
    });

    it('nulls out dragCleanupRef after cleanup runs', () => {
      const source = readSidebar();
      expect(source).toContain('dragCleanupRef.current = null');
    });
  });

  describe('persistence', () => {
    it('persists final width from currentWidthRef on pointer up', () => {
      const source = readSidebar();
      expect(source).toContain('currentWidthRef.current = newWidth');
      expect(source).toContain(
        "localStorage.setItem('sidebar-width', String(currentWidthRef.current))"
      );
    });

    it('wraps localStorage.setItem in try/catch', () => {
      const source = readSidebar();
      // The setItem should be inside a try block
      const setItemIndex = source.indexOf("localStorage.setItem('sidebar-width'");
      const precedingTry = source.lastIndexOf('try {', setItemIndex);
      const precedingCatch = source.indexOf('} catch {', setItemIndex);
      expect(precedingTry).toBeGreaterThan(-1);
      expect(precedingCatch).toBeGreaterThan(setItemIndex);
    });

    it('does not persist on every state change', () => {
      const source = readSidebar();
      expect(source).not.toContain('}, [sidebarWidth]);');
    });
  });

  describe('tooltip', () => {
    it('adds title attribute to session title for native tooltip', () => {
      const source = readSidebar();
      expect(source).toContain('title={session.title}');
    });
  });

  describe('resize handle', () => {
    it('renders a resize handle with col-resize cursor and touch-none', () => {
      const source = readSidebar();
      expect(source).toContain('cursor-col-resize');
      expect(source).toContain('touch-none');
    });

    it('uses onPointerDown for the resize handle', () => {
      const source = readSidebar();
      expect(source).toContain('onPointerDown={handleResizeStart}');
    });

    it('uses inline style for dynamic width', () => {
      const source = readSidebar();
      expect(source).toContain('style={{ width: `${sidebarWidth}px` }}');
    });
  });
});
