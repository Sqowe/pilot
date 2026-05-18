import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon, X, MessageSquareText, Info } from 'lucide-react';
import { useAppStore } from '../store';
import type { MemorySearchResult, Session } from '../types';

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}

interface SearchResultItem {
  sessionId: string;
  title: string;
  summary?: string;
  timestamp: number;
  score?: number;
}

export function SearchOverlay({ isOpen, onClose, onSelectSession }: SearchOverlayProps) {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const appConfig = useAppStore((s) => s.appConfig);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const memoryEnabled = appConfig?.memoryEnabled ?? true;

  // Focus input and reset state when overlay opens; invalidate in-flight on close
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setIsSearching(false);
      requestIdRef.current++;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // Overlay closed — invalidate any pending/in-flight search
      requestIdRef.current++;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of sessions) {
      map.set(session.id, session);
    }
    return map;
  }, [sessions]);

  const fallbackTitleSearch = useCallback(
    (searchQuery: string): SearchResultItem[] => {
      const normalized = searchQuery.toLowerCase();
      return sessions
        .filter((s) => s.title.toLowerCase().includes(normalized))
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .slice(0, 20)
        .map((s) => ({
          sessionId: s.id,
          title: s.title,
          timestamp: s.updatedAt || s.createdAt,
        }));
    },
    [sessions]
  );

  const performMemorySearch = useCallback(
    async (searchQuery: string) => {
      try {
        const memoryResults: MemorySearchResult[] = await window.electronAPI.memory.search({
          query: searchQuery,
          scope: 'all',
          limit: 20,
        });

        // Map memory results to sessions
        const items: SearchResultItem[] = [];
        const seenSessionIds = new Set<string>();

        for (const result of memoryResults) {
          const sessionId = result.sourceSessionId || result.sessionId;
          if (!sessionId || seenSessionIds.has(sessionId)) continue;

          // Only include results that map to an existing session
          const session = sessionMap.get(sessionId);
          if (!session) continue;

          seenSessionIds.add(sessionId);
          items.push({
            sessionId,
            title: session.title,
            summary: result.contentPreview || result.summary,
            timestamp: session.updatedAt || session.createdAt,
            score: result.score,
          });
        }

        return items;
      } catch (error) {
        console.error('[SearchOverlay] Memory search failed:', error);
        return [];
      }
    },
    [sessionMap]
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      setSelectedIndex(0);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        requestIdRef.current++;
        setResults([]);
        setIsSearching(false);
        return;
      }

      if (!memoryEnabled) {
        // Immediate title-only search
        requestIdRef.current++;
        setIsSearching(false);
        setResults(fallbackTitleSearch(trimmed));
        return;
      }

      // Debounced memory search with staleness guard
      setIsSearching(true);
      const currentRequestId = ++requestIdRef.current;

      debounceRef.current = setTimeout(async () => {
        const memoryResults = await performMemorySearch(trimmed);

        // Only apply results if this is still the latest request
        if (requestIdRef.current !== currentRequestId) return;

        // Merge with title matches to ensure we don't miss obvious title hits
        const titleResults = fallbackTitleSearch(trimmed);
        const seenIds = new Set(memoryResults.map((r) => r.sessionId));
        const merged = [...memoryResults];

        for (const titleResult of titleResults) {
          if (!seenIds.has(titleResult.sessionId)) {
            merged.push(titleResult);
          }
        }

        setResults(merged);
        setIsSearching(false);
      }, 300);
    },
    [memoryEnabled, fallbackTitleSearch, performMemorySearch]
  );

  // Clamp selectedIndex when results change
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (results.length === 0) return 0;
      return Math.min(prev, results.length - 1);
    });
  }, [results]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) {
        onSelectSession(selected.sessionId);
        onClose();
      }
    }
  };

  // Scroll selected item into view using data-index attribute
  useEffect(() => {
    if (!resultsRef.current || results.length === 0) return;
    const selectedEl = resultsRef.current.querySelector(
      `[data-result-index="${selectedIndex}"]`
    ) as HTMLElement | null;
    selectedEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, results.length]);

  const groupedResults = useMemo(() => {
    if (results.length === 0) return [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const startOfPreviousWeek = startOfToday - 7 * 86_400_000;

    const groups: { label: string; items: SearchResultItem[] }[] = [
      { label: t('sidebar.today'), items: [] },
      { label: t('sidebar.yesterday'), items: [] },
      { label: t('sidebar.previousWeek'), items: [] },
      { label: t('sidebar.older'), items: [] },
    ];

    for (const item of results) {
      if (item.timestamp >= startOfToday) {
        groups[0].items.push(item);
      } else if (item.timestamp >= startOfYesterday) {
        groups[1].items.push(item);
      } else if (item.timestamp >= startOfPreviousWeek) {
        groups[2].items.push(item);
      } else {
        groups[3].items.push(item);
      }
    }

    return groups.filter((g) => g.items.length > 0);
  }, [results, t]);

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/30 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] mx-4 bg-background rounded-2xl shadow-elevated border border-border-subtle overflow-hidden animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-muted">
          <SearchIcon className="w-5 h-5 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('searchOverlay.placeholder')}
            className="flex-1 bg-transparent text-base text-text-primary placeholder:text-text-muted outline-none"
          />
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Memory disabled note */}
        {!memoryEnabled && query.trim() && (
          <div className="px-5 py-2 flex items-center gap-2 text-[12px] text-text-muted bg-surface/50 border-b border-border-muted">
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{t('searchOverlay.memoryDisabledNote')}</span>
          </div>
        )}

        {/* Results */}
        <div ref={resultsRef} className="max-h-[50vh] overflow-y-auto">
          {isSearching && (
            <div className="px-5 py-6 text-center text-sm text-text-muted">
              {t('searchOverlay.searching')}
            </div>
          )}

          {!isSearching && query.trim() && results.length === 0 && (
            <div className="px-5 py-6 text-center text-sm text-text-muted">
              {t('searchOverlay.noResults')}
            </div>
          )}

          {!isSearching && groupedResults.length > 0 && (
            <div className="py-2">
              {groupedResults.map((group) => (
                <div key={group.label}>
                  <div className="px-5 py-1.5 text-[11px] font-medium tracking-wide text-text-muted uppercase">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const currentFlatIndex = flatIndex++;
                    const isSelected = currentFlatIndex === selectedIndex;
                    return (
                      <button
                        key={item.sessionId}
                        data-result-index={currentFlatIndex}
                        onClick={() => {
                          onSelectSession(item.sessionId);
                          onClose();
                        }}
                        onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                        className={`w-full text-left px-5 py-2.5 flex items-start gap-3 transition-colors ${
                          isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'
                        }`}
                      >
                        <MessageSquareText className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-text-primary truncate">
                            {item.title}
                          </div>
                          {item.summary && (
                            <div className="text-[12px] text-text-muted truncate mt-0.5">
                              {item.summary}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {!query.trim() && (
            <div className="px-5 py-6 text-center text-sm text-text-muted">
              {t('searchOverlay.hint')}
            </div>
          )}
        </div>

        {/* Footer with shortcut hint */}
        <div className="px-5 py-2.5 border-t border-border-muted flex items-center justify-between text-[11px] text-text-muted">
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border-muted font-mono text-[10px]">
              ↑↓
            </kbd>{' '}
            {t('searchOverlay.navigate')}{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border-muted font-mono text-[10px]">
              ↵
            </kbd>{' '}
            {t('searchOverlay.open')}{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border-muted font-mono text-[10px]">
              esc
            </kbd>{' '}
            {t('searchOverlay.close')}
          </span>
        </div>
      </div>
    </div>
  );
}
