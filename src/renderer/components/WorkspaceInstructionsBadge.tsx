/**
 * WorkspaceInstructionsBadge — shows a compact indicator in the ContextPanel
 * confirming whether workspace instructions (e.g. CLAUDE.md) are loaded and
 * active for the current session.
 *
 * Gives the user visible proof that their instructions file is being injected
 * into the system prompt — solving the common pain point of "is the LLM
 * actually reading my rules?"
 */
import { useState, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { WorkspaceInstructionsStatus } from '../../shared/workspace-instructions-status';

interface WorkspaceInstructionsBadgeProps {
  /** Working directory to check — triggers re-fetch when it changes. */
  cwd?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const WorkspaceInstructionsBadge = memo(function WorkspaceInstructionsBadge({
  cwd,
}: WorkspaceInstructionsBadgeProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkspaceInstructionsStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.workspaceInstructions?.getStatus) {
      return;
    }

    let cancelled = false;
    setLoading(true);

    const fetchStatus = async () => {
      try {
        const result = await window.electronAPI.workspaceInstructions.getStatus();
        if (!cancelled) {
          setStatus(result);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[WorkspaceInstructionsBadge] Failed to fetch status:', error);
          setStatus(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchStatus();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Nothing to show if no file is configured
  if (loading || !status || !status.configuredFile) {
    return null;
  }

  const isLoaded = status.loaded;

  return (
    <div className="px-4 py-2.5 border-b border-border-muted space-y-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left text-xs transition-colors group"
      >
        <FileText
          className={`w-3.5 h-3.5 flex-shrink-0 ${isLoaded ? 'text-emerald-400' : 'text-warning'}`}
        />
        <span className="flex-1 min-w-0 truncate text-text-secondary group-hover:text-text-primary">
          {status.configuredFile}
        </span>
        {isLoaded ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
        ) : (
          <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0" />
        )}
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-muted flex-shrink-0 opacity-0 group-hover:opacity-100" />
        )}
      </button>

      {expanded && (
        <div className="ml-5 space-y-0.5 text-[11px] text-text-muted animate-fade-in">
          {isLoaded ? (
            <>
              <div className="flex items-center gap-1">
                <span className="text-emerald-400/80">
                  {t('workspaceInstructions.active', 'Active — injected into system prompt')}
                </span>
              </div>
              {status.sizeBytes != null && (
                <div>
                  {t('workspaceInstructions.size', 'Size')}: {formatSize(status.sizeBytes)}
                  {status.truncated && (
                    <span className="text-warning ml-1">
                      ({t('workspaceInstructions.truncated', 'truncated to 64 KB')})
                    </span>
                  )}
                </div>
              )}
              {status.fingerprintShort && (
                <div className="font-mono text-[10px] text-text-muted/60">
                  SHA: {status.fingerprintShort}…
                </div>
              )}
            </>
          ) : (
            <div className="text-warning/80">
              {status.error ||
                t('workspaceInstructions.notFound', 'File not found at workspace root')}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
