import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentPath = path.resolve(
  __dirname,
  '../src/renderer/components/message/CollapsibleUserText.tsx'
);
const source = fs.readFileSync(componentPath, 'utf8');

describe('CollapsibleUserText component', () => {
  describe('overflow detection', () => {
    it('has a minimum character threshold to avoid measuring short messages', () => {
      expect(source).toContain('MIN_CHARS_TO_COLLAPSE');
      expect(source).toContain('text.length < MIN_CHARS_TO_COLLAPSE');
    });

    it('uses COLLAPSED_MAX_HEIGHT to determine overflow', () => {
      expect(source).toContain('COLLAPSED_MAX_HEIGHT');
      expect(source).toContain('el.scrollHeight > COLLAPSED_MAX_HEIGHT');
    });

    it('guards ResizeObserver usage for environments where it is unavailable', () => {
      expect(source).toContain("typeof ResizeObserver !== 'undefined'");
    });

    it('provides a window resize fallback when ResizeObserver is absent', () => {
      expect(source).toContain("window.addEventListener('resize', checkOverflow)");
      expect(source).toContain("window.removeEventListener('resize', checkOverflow)");
    });
  });

  describe('collapse/expand behavior', () => {
    it('applies overflow-hidden and maxHeight when collapsed', () => {
      expect(source).toContain('overflow-hidden');
      expect(source).toContain('maxHeight');
      expect(source).toContain('COLLAPSED_MAX_HEIGHT');
    });

    it('renders a Show more button when content overflows', () => {
      expect(source).toContain("t('messageCard.showMore')");
    });

    it('renders a Show less button when expanded', () => {
      expect(source).toContain("t('messageCard.showLess')");
    });

    it('uses chevron icons for the toggle', () => {
      expect(source).toContain('ChevronDown');
      expect(source).toContain('ChevronUp');
    });
  });

  describe('streaming behavior', () => {
    it('suppresses collapse during streaming', () => {
      // shouldCollapse includes !isStreaming check
      expect(source).toContain('isOverflowing && !expanded && !isStreaming');
    });

    it('hides the toggle button during streaming', () => {
      expect(source).toContain('isOverflowing && !isStreaming');
    });

    it('shows streaming cursor when isStreaming is true', () => {
      expect(source).toContain('isStreaming && <span');
      expect(source).toContain('animate-pulse');
    });
  });

  describe('state reset on content change', () => {
    it('resets expanded state when text changes', () => {
      expect(source).toContain('setExpanded(false)');
      // The effect depends on [text]
      expect(source).toMatch(/useEffect\(\(\)\s*=>\s*\{\s*setExpanded\(false\)/);
    });
  });

  describe('gradient overlay', () => {
    it('renders a gradient fade using the surface CSS variable', () => {
      expect(source).toContain('var(--color-surface)');
      expect(source).toContain('pointer-events-none');
    });
  });
});
