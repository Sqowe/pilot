import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';

export interface SelectionContextMenuProps {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}

export const SelectionContextMenu = memo(function SelectionContextMenu({
  text,
  x,
  y,
  onClose,
}: SelectionContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ x, y });

  // Track mounted state to prevent setState after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Clamp to viewport after render
  useEffect(() => {
    setPosition({ x, y });

    requestAnimationFrame(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let adjustedX = x;
        let adjustedY = y;

        if (x + rect.width > viewportWidth) adjustedX = viewportWidth - rect.width - 8;
        if (y + rect.height > viewportHeight) adjustedY = viewportHeight - rect.height - 8;
        if (adjustedX < 0) adjustedX = 8;
        if (adjustedY < 0) adjustedY = 8;

        if (adjustedX !== x || adjustedY !== y) {
          setPosition({ x: adjustedX, y: adjustedY });
        }
      }
    });
  }, [x, y]);

  // Dismiss on click-outside, Escape, or scroll
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', handleScroll, true); // capture so any scroll dismisses
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      if (window.electronAPI?.clipboard) {
        await window.electronAPI.clipboard.writeText(text);
      } else if (navigator.clipboard) {
        // Fallback for non-Electron or preload-unavailable contexts
        await navigator.clipboard.writeText(text);
      } else {
        // No clipboard API available — close silently
        onClose();
        return;
      }
      if (!isMountedRef.current) return;
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        copyTimeoutRef.current = null;
        onClose();
      }, 600);
    } catch {
      // Clipboard write failed — close without showing stale state
      onClose();
    }
  }, [text, onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[140px] py-1 rounded-lg border border-border bg-surface shadow-lg animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={t('selectionMenu.title')}
    >
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors text-left"
        onClick={() => void handleCopy()}
      >
        <Copy className="w-4 h-4 text-text-muted shrink-0" />
        <span>{copied ? t('selectionMenu.copied') : t('selectionMenu.copy')}</span>
      </button>
    </div>
  );
});
