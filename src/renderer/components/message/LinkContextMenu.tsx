import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Globe, ExternalLink } from 'lucide-react';

interface InstalledBrowser {
  bundleId: string;
  name: string;
}

export interface LinkContextMenuProps {
  url: string;
  x: number;
  y: number;
  onClose: () => void;
}

export const LinkContextMenu = memo(function LinkContextMenu({
  url,
  x,
  y,
  onClose,
}: LinkContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [browsers, setBrowsers] = useState<InstalledBrowser[]>([]);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ x, y });

  // Load installed browsers on mount (with error handling and unmount guard)
  useEffect(() => {
    let cancelled = false;
    if (window.electronAPI?.getInstalledBrowsers) {
      void window.electronAPI
        .getInstalledBrowsers()
        .then((result) => {
          if (!cancelled) {
            setBrowsers(result || []);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setBrowsers([]);
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset position whenever x/y props change, then clamp to viewport
  useEffect(() => {
    // Start at the requested position
    setPosition({ x, y });

    // After render, adjust if overflowing viewport
    requestAnimationFrame(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let adjustedX = x;
        let adjustedY = y;

        if (x + rect.width > viewportWidth) {
          adjustedX = viewportWidth - rect.width - 8;
        }
        if (y + rect.height > viewportHeight) {
          adjustedY = viewportHeight - rect.height - 8;
        }
        if (adjustedX < 0) adjustedX = 8;
        if (adjustedY < 0) adjustedY = 8;

        if (adjustedX !== x || adjustedY !== y) {
          setPosition({ x: adjustedX, y: adjustedY });
        }
      }
    });
  }, [x, y]);

  // Re-clamp when browser list loads (menu height changes)
  useEffect(() => {
    if (browsers.length === 0) return;
    requestAnimationFrame(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        if (rect.bottom > viewportHeight) {
          setPosition((prev) => ({
            ...prev,
            y: Math.max(8, viewportHeight - rect.height - 8),
          }));
        }
      }
    });
  }, [browsers]);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (window.electronAPI?.clipboard) {
      await window.electronAPI.clipboard.writeText(url);
      setCopied(true);
      // Clear any previous timeout before setting a new one
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        copyTimeoutRef.current = null;
        onClose();
      }, 600);
    }
  }, [url, onClose]);

  const handleOpenDefault = useCallback(() => {
    if (window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(url);
    }
    onClose();
  }, [url, onClose]);

  const handleOpenInBrowser = useCallback(
    (bundleId: string) => {
      if (window.electronAPI?.openUrlInBrowser) {
        void window.electronAPI.openUrlInBrowser(url, bundleId);
      }
      onClose();
    },
    [url, onClose]
  );

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[200px] max-w-[280px] py-1 rounded-lg border border-border bg-surface shadow-lg animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={t('linkMenu.title')}
    >
      {/* Copy Link */}
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors text-left"
        onClick={() => void handleCopyLink()}
      >
        <Copy className="w-4 h-4 text-text-muted shrink-0" />
        <span>{copied ? t('linkMenu.copied') : t('linkMenu.copyLink')}</span>
      </button>

      {/* Open in default browser */}
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors text-left"
        onClick={handleOpenDefault}
      >
        <ExternalLink className="w-4 h-4 text-text-muted shrink-0" />
        <span>{t('linkMenu.openDefault')}</span>
      </button>

      {/* Divider + Browser list */}
      {browsers.length > 0 && (
        <>
          <div className="my-1 border-t border-border" role="separator" />
          <div className="px-3 py-1 text-[11px] text-text-muted uppercase tracking-wider">
            {t('linkMenu.openWith')}
          </div>
          {browsers.map((browser) => (
            <button
              key={browser.bundleId}
              type="button"
              role="menuitem"
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors text-left"
              onClick={() => handleOpenInBrowser(browser.bundleId)}
            >
              <Globe className="w-4 h-4 text-text-muted shrink-0" />
              <span className="truncate">{browser.name}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
});
