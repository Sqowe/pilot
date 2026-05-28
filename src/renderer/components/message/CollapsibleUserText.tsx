// CollapsibleUserText — truncates long user messages with a "Show more/less" toggle.
// Activates only when text exceeds a height threshold, keeping short messages unchanged.
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';

/** Max collapsed height in pixels (~8 lines of text at 1.5 line-height, 15px font) */
const COLLAPSED_MAX_HEIGHT = 180;

/** Minimum character count to even consider collapsing (avoids measuring tiny messages) */
const MIN_CHARS_TO_COLLAPSE = 300;

interface CollapsibleUserTextProps {
  text: string;
  isStreaming?: boolean;
}

export const CollapsibleUserText = memo(function CollapsibleUserText({
  text,
  isStreaming,
}: CollapsibleUserTextProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Reset expanded state when text content changes (prevents stale state on reuse)
  useEffect(() => {
    setExpanded(false);
  }, [text]);

  // Measure whether content exceeds the collapsed height threshold
  useEffect(() => {
    if (text.length < MIN_CHARS_TO_COLLAPSE) {
      setIsOverflowing(false);
      return;
    }

    const el = contentRef.current;
    if (!el) return;

    const checkOverflow = () => {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT);
    };

    checkOverflow();

    // Re-check on resize (font size changes, container width changes)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(checkOverflow);
      observer.observe(el);
      return () => observer.disconnect();
    }

    // Fallback: listen to window resize when ResizeObserver is unavailable
    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [text]);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const shouldCollapse = isOverflowing && !expanded && !isStreaming;

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={`text-text-primary whitespace-pre-wrap break-words text-left ${
          shouldCollapse ? 'overflow-hidden' : ''
        }`}
        style={shouldCollapse ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
      >
        {text}
        {isStreaming && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />}
      </div>

      {/* Gradient fade overlay when collapsed */}
      {shouldCollapse && (
        <div
          className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
          style={{
            background: 'linear-gradient(to top, var(--color-surface) 0%, transparent 100%)',
          }}
        />
      )}

      {/* Show more / Show less toggle */}
      {isOverflowing && !isStreaming && (
        <button
          type="button"
          onClick={toggle}
          className={`flex items-center gap-1 text-xs transition-colors ${
            expanded
              ? 'mt-1 text-accent hover:text-accent-hover'
              : 'mt-2 px-2.5 py-1 rounded-full bg-accent/10 text-accent font-medium hover:bg-accent/20'
          }`}
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3 h-3" />
              <span>{t('messageCard.showLess')}</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" />
              <span>{t('messageCard.showMore')}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
});
