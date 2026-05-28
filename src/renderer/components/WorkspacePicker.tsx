import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderPlus, Check } from 'lucide-react';
import { useAppStore } from '../store';

interface WorkspacePickerProps {
  currentPath: string | null;
  onSelectPath: (path: string) => void;
  onBrowse: () => void;
  className?: string;
}

/**
 * A dropdown that shows known workspaces (from session history)
 * with a "Browse..." option to open the native folder picker.
 */
export function WorkspacePicker({
  currentPath,
  onSelectPath,
  onBrowse,
  className = '',
}: WorkspacePickerProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessions = useAppStore((state) => state.sessions);

  // Derive unique workspace paths from session history
  const knownWorkspaces = useMemo(() => {
    const pathSet = new Map<string, { path: string; label: string; count: number }>();
    for (const session of sessions) {
      if (session.cwd && session.cwd.trim()) {
        const path = session.cwd;
        const existing = pathSet.get(path);
        if (existing) {
          existing.count++;
        } else {
          const segments = path.split(/[/\\]/);
          const label = segments[segments.length - 1] || path;
          pathSet.set(path, { path, label, count: 1 });
        }
      }
    }
    // Sort by usage count (most used first), then alphabetically
    return [...pathSet.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    );
  }, [sessions]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const displayLabel = currentPath
    ? currentPath.split(/[/\\]/).pop() || currentPath
    : t('welcome.selectWorkingFolder');

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 text-sm transition-colors ${
          currentPath
            ? 'text-text-secondary hover:text-text-primary'
            : 'text-accent hover:text-accent-hover'
        }`}
        title={currentPath || t('welcome.selectWorkingFolder')}
      >
        <FolderOpen className="w-4 h-4" />
        <span>{displayLabel}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[280px] max-w-[420px] rounded-xl border border-border bg-background shadow-lg overflow-hidden">
          <div className="max-h-[240px] overflow-y-auto py-1">
            {knownWorkspaces.length === 0 && (
              <p className="px-3 py-2 text-xs text-text-muted">
                {t('welcome.noRecentWorkspaces', 'No recent workspaces')}
              </p>
            )}
            {knownWorkspaces.map((ws) => {
              const isCurrent = ws.path === currentPath;
              return (
                <button
                  key={ws.path}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) {
                      onSelectPath(ws.path);
                    }
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    isCurrent
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-primary hover:bg-surface-hover'
                  }`}
                  title={ws.path}
                >
                  <FolderOpen className="w-3.5 h-3.5 shrink-0 text-text-muted" />
                  <span className="truncate flex-1">{ws.label}</span>
                  {isCurrent && <Check className="w-3.5 h-3.5 shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border-muted">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onBrowse();
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <FolderPlus className="w-3.5 h-3.5 shrink-0" />
              <span>{t('welcome.browseFolder', 'Browse...')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
