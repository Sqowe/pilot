import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EmbeddingProviderType,
  ExperienceDbStatus,
  LocalEmbeddingProgress,
  MemoryDebugFileContent,
  MemoryDebugFileInfo,
  MemoryInspectSessionResult,
  MemoryModelCheckResult,
  MemoryOverview,
  MemoryReadResult,
  MemoryRuntimeConfig,
  MemorySearchResult,
  MemorySearchScope,
} from '../../types';
import { useAppStore } from '../../store';
import { SettingsContentSection } from './shared';
import { classifyEmbeddingModel } from './embedding-model-validation';

type SearchMode = 'workspace' | 'all' | 'global';

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${(bytes / TB).toFixed(2)} TB`;
}

function formatRelativeTime(timestamp: number, locale?: string): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  try {
    const rtf = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' });
    if (diffSeconds < 60) return rtf.format(-diffSeconds, 'second');
    if (diffMinutes < 60) return rtf.format(-diffMinutes, 'minute');
    if (diffHours < 24) return rtf.format(-diffHours, 'hour');
    if (diffDays < 7) return rtf.format(-diffDays, 'day');
  } catch {
    // Fallback if Intl is unavailable
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(locale);
}

function classifyIngestionError(error: string): string {
  const normalized = error.toLowerCase();
  if (/maximum context length|max.*token|requested about/.test(normalized)) {
    return 'contextWindow';
  }
  if (/timeout|etimedout/.test(normalized)) {
    return 'timeout';
  }
  if (/401|unauthorized/.test(normalized)) {
    return 'authFailed';
  }
  if (/429|rate.?limit/.test(normalized)) {
    return 'rateLimited';
  }
  if (/50[023]|server error|internal error/.test(normalized)) {
    return 'serverError';
  }
  return 'unknown';
}

/**
 * UI-side fallback defaults, mirroring config-store.ts defaultConfig.memoryRuntime.
 * Design decisions D3 (local-by-default for new installs) and D4 (existing installs
 * frozen via schema v2 migration) are implemented in the main process config layer.
 * These UI defaults only apply when appConfig.memoryRuntime is absent (e.g., tests
 * or pre-hydration render). See docs/design/local-embeddings-default.md §7.
 */
const DEFAULT_MEMORY_RUNTIME: MemoryRuntimeConfig = {
  llm: {
    inheritFromActive: true,
    apiKey: '',
    baseUrl: '',
    model: '',
    timeoutMs: 180000,
  },
  embedding: {
    inheritFromActive: false,
    provider: 'local' as EmbeddingProviderType,
    apiKey: '',
    baseUrl: '',
    model: '',
    timeoutMs: 180000,
  },
  useEmbedding: true,
  maxNavSteps: 2,
  ingestionConcurrency: 4,
  storageRoot: '',
  evalEnabled: false,
  evalWorkspaces: [],
  evalMaxRounds: 12,
  evalArtifactsRoot: '',
  promptIterationRounds: 2,
  recencyFloor: 0.05,
  recencyCeiling: 0.25,
  recencyDecayDays: 90,
  supersessionPenalty: 0.2,
  supersessionKeywordThreshold: 0.5,
};

/**
 * Deterministic JSON with recursively-sorted object keys, so two configs that
 * differ only in key order compare equal. Used for dirty-checking the runtime
 * config and detecting model-config changes.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return val;
  });
}

function cloneRuntimeConfig(runtime?: MemoryRuntimeConfig): MemoryRuntimeConfig {
  const source = runtime || DEFAULT_MEMORY_RUNTIME;
  return {
    llm: { ...DEFAULT_MEMORY_RUNTIME.llm, ...source.llm },
    embedding: { ...DEFAULT_MEMORY_RUNTIME.embedding, ...source.embedding },
    useEmbedding: source.useEmbedding ?? DEFAULT_MEMORY_RUNTIME.useEmbedding,
    maxNavSteps: source.maxNavSteps ?? DEFAULT_MEMORY_RUNTIME.maxNavSteps,
    ingestionConcurrency:
      source.ingestionConcurrency ?? DEFAULT_MEMORY_RUNTIME.ingestionConcurrency,
    storageRoot: source.storageRoot ?? DEFAULT_MEMORY_RUNTIME.storageRoot,
    evalEnabled: source.evalEnabled ?? DEFAULT_MEMORY_RUNTIME.evalEnabled,
    evalWorkspaces: Array.isArray(source.evalWorkspaces)
      ? [...source.evalWorkspaces]
      : [...(DEFAULT_MEMORY_RUNTIME.evalWorkspaces || [])],
    evalMaxRounds: source.evalMaxRounds ?? DEFAULT_MEMORY_RUNTIME.evalMaxRounds,
    evalArtifactsRoot: source.evalArtifactsRoot ?? DEFAULT_MEMORY_RUNTIME.evalArtifactsRoot,
    promptIterationRounds:
      source.promptIterationRounds ?? DEFAULT_MEMORY_RUNTIME.promptIterationRounds,
    recencyFloor: source.recencyFloor ?? DEFAULT_MEMORY_RUNTIME.recencyFloor,
    recencyCeiling: source.recencyCeiling ?? DEFAULT_MEMORY_RUNTIME.recencyCeiling,
    recencyDecayDays: source.recencyDecayDays ?? DEFAULT_MEMORY_RUNTIME.recencyDecayDays,
    supersessionPenalty: source.supersessionPenalty ?? DEFAULT_MEMORY_RUNTIME.supersessionPenalty,
    supersessionKeywordThreshold:
      source.supersessionKeywordThreshold ?? DEFAULT_MEMORY_RUNTIME.supersessionKeywordThreshold,
  };
}

/**
 * `isActive` follows the SettingsSkills/SettingsConnectors convention: SettingsPanel
 * keeps visited tabs mounted (hidden via CSS), so without it the overview would stay
 * frozen at whatever it was when the tab was first opened. The embedding-coverage
 * card in particular reports a live condition and must not show a stale snapshot.
 */
export function SettingsMemory({ isActive = true }: { isActive?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const workingDir = useAppStore((state) => state.workingDir);
  const appConfig = useAppStore((state) => state.appConfig);

  const currentSession = sessions.find((session) => session.id === activeSessionId);
  const currentWorkspace = currentSession?.cwd || workingDir || '';
  const hasWorkspace = Boolean(currentWorkspace);

  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchMode>(currentWorkspace ? 'workspace' : 'all');
  const [sourceWorkspaceFilter, setSourceWorkspaceFilter] = useState<string>('');
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  const [selected, setSelected] = useState<MemoryReadResult | null>(null);
  const [inspectedSession, setInspectedSession] = useState<MemoryInspectSessionResult | null>(null);
  const [files, setFiles] = useState<MemoryDebugFileInfo[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<MemoryDebugFileContent | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<MemoryRuntimeConfig>(
    cloneRuntimeConfig(appConfig?.memoryRuntime)
  );
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // "Check models availability" step: when the LLM/embedding config changes, the
  // user must run a successful check before Save is enabled. checkedSignature holds
  // the model signature that last passed; a later edit changes the signature and
  // re-requires a check.
  const [isChecking, setIsChecking] = useState(false);
  const [checkedSignature, setCheckedSignature] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<MemoryModelCheckResult | null>(null);
  // True when stored local embeddings predate a format change (e.g. the prefix fix).
  const [embeddingFormatStale, setEmbeddingFormatStale] = useState(false);
  // Separate §7 condition: stored vectors were embedded with a different model than
  // the one now configured, so retrieval has silently degraded to lexical-only.
  const [embeddingModelStale, setEmbeddingModelStale] = useState(false);

  // Experience DB (memory.db) status card — populated when the sqlite entry is selected.
  const [experienceDbStatus, setExperienceDbStatus] = useState<ExperienceDbStatus | null>(null);
  const [isVacuuming, setIsVacuuming] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Selection request sequencing: bumped on each selection/refresh so that in-flight
  // reads/status fetches whose selection has since changed are discarded (stale-guard).
  const selectionRequestRef = useRef(0);

  const refreshEmbeddingFormatStale = useCallback(async () => {
    try {
      const { stale, modelStale } = await window.electronAPI.memory.isEmbeddingFormatStale();
      setEmbeddingFormatStale(stale);
      setEmbeddingModelStale(modelStale);
    } catch {
      setEmbeddingFormatStale(false);
      setEmbeddingModelStale(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    void refreshEmbeddingFormatStale();
  }, [refreshEmbeddingFormatStale, isActive]);

  // Backfill progress arrives from the main process per row (throttled there).
  // Subscribed unconditionally rather than only while running, so a backfill
  // started before this tab was opened still reports itself.
  useEffect(() => {
    return window.electronAPI.memory.onBackfillProgress((p) => {
      setBackfillProgress(p);
      // Track the running flag from the events themselves, so a panel mounted
      // mid-run reports correctly and does not stay stuck on "running" at the end
      // (the handler's own finally only fires in the tab that started the run).
      setIsBackfilling(p.processed < p.total);
    });
  }, []);

  const enabled = overview?.enabled ?? appConfig?.memoryEnabled ?? true;

  const selectedFile =
    selectedFilePath != null ? (files.find((f) => f.filePath === selectedFilePath) ?? null) : null;
  const selectedIsSqlite = selectedFile?.storage === 'sqlite';

  const groupedResults = useMemo(() => {
    return {
      core: results.filter((item) => item.kind === 'core'),
      sessions: results.filter((item) => item.kind === 'experience_session'),
      chunks: results.filter((item) => item.kind === 'experience_chunk'),
      raw: results.filter((item) => item.kind === 'raw_session'),
    };
  }, [results]);

  useEffect(() => {
    setRuntimeDraft(cloneRuntimeConfig(appConfig?.memoryRuntime));
  }, [appConfig?.memoryRuntime]);

  useEffect(() => {
    if (!hasWorkspace && scope === 'workspace') {
      setScope('all');
    }
  }, [hasWorkspace, scope]);

  const refreshOverview = async () => {
    const nextOverview = await window.electronAPI.memory.getOverview(currentWorkspace || undefined);
    setOverview(nextOverview);
  };

  // Fetch the experience DB status card data. When `requestId` is supplied it acts as a
  // stale-guard: if the selection has since changed (token bumped) the result is discarded.
  // `silent` skips touching the shared `status` message — used by actions (e.g. vacuum) that
  // set their own status and don't want it cleared by this refresh.
  const refreshExperienceDbStatus = async (opts?: { requestId?: number; silent?: boolean }) => {
    const { requestId, silent = false } = opts ?? {};
    const isStale = () => requestId != null && requestId !== selectionRequestRef.current;
    try {
      const result = await window.electronAPI.memory.getExperienceDbStatus();
      if (isStale()) return;
      if (result.success) {
        setExperienceDbStatus(result.status);
        // Clear any prior error so a successful reload doesn't leave stale error text.
        if (!silent) setStatus(null);
      } else {
        setExperienceDbStatus(null);
        if (!silent) {
          setStatus(
            `${t('memory.experienceDbStatusError')}${result.error ? `: ${result.error}` : ''}`
          );
        }
      }
    } catch (error) {
      if (isStale()) return;
      setExperienceDbStatus(null);
      if (!silent) setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshFiles = async () => {
    const nextFiles = await window.electronAPI.memory.listFiles();
    setFiles(nextFiles);
    const selectedEntry = nextFiles.find((item) => item.filePath === selectedFilePath);
    if (selectedFilePath && selectedEntry?.exists) {
      const requestId = ++selectionRequestRef.current;
      // Experience memory lives in a binary SQLite DB; the backend refuses raw reads,
      // so fetch structured status instead of trying to parse the file.
      if (selectedEntry.storage === 'sqlite') {
        setFileContent(null); // clear the raw pane when viewing the DB card
        await refreshExperienceDbStatus({ requestId });
      } else {
        setExperienceDbStatus(null); // clear the DB card when viewing a raw file
        try {
          const nextContent = await window.electronAPI.memory.readFile(selectedFilePath);
          if (requestId === selectionRequestRef.current) setFileContent(nextContent);
        } catch (error) {
          if (requestId === selectionRequestRef.current) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        }
      }
    } else {
      // Selection no longer valid (file removed/missing): invalidate any in-flight
      // fetch for the previous entry before resetting the pane.
      ++selectionRequestRef.current;
      setSelectedFilePath(null);
      setFileContent(null);
      setExperienceDbStatus(null);
    }
  };

  // Re-reads whenever the tab becomes visible again, so counters that move in the
  // background (ingestion, embedding coverage) are current rather than a snapshot
  // from when the panel was first opened.
  useEffect(() => {
    if (!isActive) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [nextOverview, nextFiles] = await Promise.all([
          window.electronAPI.memory.getOverview(currentWorkspace || undefined),
          window.electronAPI.memory.listFiles(),
        ]);
        if (!cancelled) {
          setOverview(nextOverview);
          setFiles(nextFiles);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspace, isActive]);

  const handleToggle = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.memory.setEnabled(!enabled);
      await refreshOverview();
      setStatus(!enabled ? t('memory.enabledStatus') : t('memory.disabledStatus'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSelected(null);
      setInspectedSession(null);
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      const nextResults = await window.electronAPI.memory.search({
        query: trimmed,
        cwd: hasWorkspace ? currentWorkspace : undefined,
        scope: scope as MemorySearchScope,
        sourceWorkspace:
          scope === 'workspace' && hasWorkspace
            ? currentWorkspace
            : sourceWorkspaceFilter || undefined,
        limit: 20,
      });
      setResults(nextResults);
      if (nextResults.length > 0) {
        const detail = await window.electronAPI.memory.read(nextResults[0].id);
        setSelected(detail);
        setInspectedSession(null);
      } else {
        setSelected(null);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSelectResult = async (id: string) => {
    setIsBusy(true);
    setStatus(null);
    try {
      const detail = await window.electronAPI.memory.read(id);
      setSelected(detail);
      setInspectedSession(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleInspectSession = async (sessionId: string, workspaceKey?: string) => {
    setIsBusy(true);
    setStatus(null);
    try {
      const detail = await window.electronAPI.memory.inspectSession(sessionId, workspaceKey);
      setInspectedSession(detail);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSelectFile = async (filePath: string) => {
    const entry = files.find((item) => item.filePath === filePath);
    if (entry && !entry.exists) {
      // Supersede any in-flight fetch for the prior entry; nothing to load here.
      ++selectionRequestRef.current;
      setSelectedFilePath(filePath);
      setFileContent(null);
      setExperienceDbStatus(null);
      setIsBusy(false);
      setStatus(
        entry.storage === 'sqlite'
          ? t('memory.experienceDbNotCreatedYet')
          : t('memory.fileNotCreatedYet')
      );
      return;
    }
    // Bump on each selection so in-flight reads/status fetches for the previous entry
    // are discarded once they resolve (stale-guard against out-of-order resolution).
    const requestId = ++selectionRequestRef.current;
    setSelectedFilePath(filePath);
    setStatus(null);
    setIsBusy(true);
    try {
      // Experience memory lives in a binary SQLite DB (memory.db); the backend refuses
      // raw reads, so fetch the structured status instead of trying to parse the file.
      if (entry?.storage === 'sqlite') {
        setFileContent(null);
        await refreshExperienceDbStatus({ requestId });
      } else {
        setExperienceDbStatus(null);
        const nextContent = await window.electronAPI.memory.readFile(filePath);
        if (requestId === selectionRequestRef.current) setFileContent(nextContent);
      }
    } catch (error) {
      if (requestId === selectionRequestRef.current) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === selectionRequestRef.current) setIsBusy(false);
    }
  };

  const handleVacuumExperienceDb = async () => {
    // Capture the selection token so a selection change mid-vacuum doesn't clobber the
    // newly-selected entry's status / DB card with this action's result.
    const requestId = selectionRequestRef.current;
    const stillCurrent = () => requestId === selectionRequestRef.current;
    setIsVacuuming(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.memory.vacuumExperienceDb();
      if (result.success) {
        if (stillCurrent()) setStatus(t('memory.vacuumSuccess'));
        // Silent refresh so this success message isn't cleared by the status reload.
        await refreshExperienceDbStatus({ requestId, silent: true });
      } else if (stillCurrent()) {
        setStatus(`${t('memory.vacuumFailed')}${result.error ? `: ${result.error}` : ''}`);
      }
    } catch (error) {
      if (stillCurrent()) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsVacuuming(false);
    }
  };

  const handleBackfillEmbeddings = async () => {
    const counts = await window.electronAPI.memory.countEmbeddingBackfill();
    const total = counts.chunkCount + counts.sessionCount;
    if (!total) {
      setStatus(t('memory.backfillNothingToDo'));
      return;
    }
    if (!window.confirm(t('memory.backfillConfirm', { count: total }))) {
      return;
    }
    setIsBackfilling(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.memory.backfillEmbeddings();
      if (result.success) {
        setStatus(t('memory.backfillDone', { embedded: result.embedded, failed: result.failed }));
      } else {
        setStatus(`${t('memory.backfillFailed')}${result.error ? `: ${result.error}` : ''}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBackfilling(false);
      setBackfillProgress(null);
      // Redraw regardless of outcome: on success the coverage card must show the new
      // numbers, on failure it must show the recorded reason.
      await Promise.all([
        refreshOverview(),
        refreshEmbeddingFormatStale(),
        refreshExperienceDbStatus({ silent: true }),
      ]);
    }
  };

  const handleExportExperienceJson = async () => {
    const requestId = selectionRequestRef.current;
    const stillCurrent = () => requestId === selectionRequestRef.current;
    setIsExporting(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.memory.exportExperienceMemoryToFile();
      if (!stillCurrent()) return;
      if (result.success) {
        setStatus(t('memory.exportSuccess', { path: result.path }));
      } else if ('canceled' in result && result.canceled) {
        // User dismissed the save dialog — no message.
      } else {
        // Failure (carries `error`) or any unexpected shape — surface it rather than
        // silently misclassifying it as a cancellation.
        const detail = 'error' in result && result.error ? `: ${result.error}` : '';
        setStatus(`${t('memory.exportFailed')}${detail}`);
      }
    } catch (error) {
      if (stillCurrent()) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  };

  // Block saving when a Custom-mode embedding override is a chat model (won't embed).
  // A 'prefix' issue (E5/Nomic) is only a soft warning and does not block.
  const embeddingModelBlocked =
    runtimeDraft.useEmbedding &&
    resolveEmbeddingMode(runtimeDraft.embedding) === 'custom' &&
    classifyEmbeddingModel(runtimeDraft.embedding.model ?? '') === 'chat';

  // Dirty-check the whole runtime section (compared against a same-shape clone of
  // the saved config so key order can't cause false positives).
  const savedRuntimeClone = cloneRuntimeConfig(appConfig?.memoryRuntime);
  const runtimeDirty = stableStringify(runtimeDraft) !== stableStringify(savedRuntimeClone);

  // Did the model config specifically change? Embedding changes only matter when
  // embeddings are enabled.
  const llmChanged = stableStringify(runtimeDraft.llm) !== stableStringify(savedRuntimeClone.llm);
  const embeddingChanged =
    stableStringify(runtimeDraft.embedding) !== stableStringify(savedRuntimeClone.embedding);
  const useEmbeddingChanged = runtimeDraft.useEmbedding !== savedRuntimeClone.useEmbedding;
  const modelConfigChanged =
    llmChanged || useEmbeddingChanged || (runtimeDraft.useEmbedding && embeddingChanged);

  // Signature of the model-affecting config; a passed check is only valid while
  // this stays identical.
  const modelSignature = stableStringify({
    llm: runtimeDraft.llm,
    useEmbedding: runtimeDraft.useEmbedding,
    embedding: runtimeDraft.embedding,
  });
  const checkPassed = checkedSignature === modelSignature;
  // Must run a successful availability check before saving a model-config change.
  const needsCheck = modelConfigChanged && !checkPassed;

  const handleCheckModels = async () => {
    setIsChecking(true);
    setStatus(null);
    setCheckResult(null);
    try {
      const result = await window.electronAPI.memory.checkModelAvailability(runtimeDraft);
      setCheckResult(result);
      if (result.llm.ok && result.embedding.ok) {
        setCheckedSignature(modelSignature);
        setStatus(t('memory.modelCheckPassed'));
      } else {
        const parts: string[] = [];
        if (!result.llm.ok) parts.push(`LLM — ${result.llm.error ?? 'failed'}`);
        if (!result.embedding.ok) parts.push(`Embedding — ${result.embedding.error ?? 'failed'}`);
        setStatus(`${t('memory.modelCheckFailed')} ${parts.join(' · ')}`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setIsChecking(false);
    }
  };

  const handleSaveRuntime = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      // Detect embedding provider or model change before saving.
      // Switching provider/model changes vector dimensions (768 vs 1536+), making
      // existing stored vectors incompatible with new ones (§8 of local-embeddings-default.md).
      const savedEmbedding = appConfig?.memoryRuntime?.embedding;
      const draftEmbedding = runtimeDraft.embedding;
      const providerChanged = draftEmbedding.provider !== savedEmbedding?.provider;
      const modelChanged =
        (draftEmbedding.model ?? '') !== (savedEmbedding?.model ?? '') &&
        // Only flag a model change when not using local (local's model ID is hardcoded,
        // not stored in config, so the model field is irrelevant for local mode).
        draftEmbedding.provider !== 'local' &&
        savedEmbedding?.provider !== 'local';
      const willUseEmbedding = runtimeDraft.useEmbedding;
      const embeddingIndexAffected = willUseEmbedding && (providerChanged || modelChanged);

      await window.electronAPI.config.save({
        memoryRuntime: runtimeDraft,
      });
      await Promise.all([refreshOverview(), refreshEmbeddingFormatStale()]);
      setStatus(t('memory.runtimeSaved'));

      // Prompt for rebuild after saving so the new config is already persisted.
      if (embeddingIndexAffected) {
        if (window.confirm(t('memory.rebuildOnProviderChange'))) {
          setIsBusy(true);
          setStatus(null);
          try {
            const result = await window.electronAPI.memory.rebuildAll();
            await Promise.all([refreshOverview(), refreshEmbeddingFormatStale()]);
            setStatus(t('memory.rebuildAllSuccess', { sessions: result.sessionCount }));
          } catch (rebuildError) {
            setStatus(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
          } finally {
            setIsBusy(false);
          }
        }
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRebuildWorkspace = async () => {
    if (!currentWorkspace) {
      return;
    }
    if (!window.confirm(t('memory.rebuildConfirm'))) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.memory.rebuildWorkspace(currentWorkspace);
      await Promise.all([refreshOverview(), refreshFiles()]);
      setStatus(t('memory.rebuildSuccess'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRebuildAll = async () => {
    if (!window.confirm(t('memory.rebuildAllConfirm'))) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.memory.rebuildAll();
      await Promise.all([refreshOverview(), refreshFiles(), refreshEmbeddingFormatStale()]);
      setStatus(
        t('memory.rebuildAllSuccess', {
          sessions: result.sessionCount,
        })
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleClearWorkspace = async () => {
    if (!currentWorkspace) {
      return;
    }
    if (!window.confirm(t('memory.clearWorkspaceConfirm'))) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.memory.clearWorkspace(currentWorkspace);
      setResults([]);
      setSelected(null);
      setInspectedSession(null);
      await Promise.all([refreshOverview(), refreshFiles()]);
      setStatus(t('memory.clearWorkspaceSuccess'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleClearCore = async () => {
    if (!window.confirm(t('memory.clearCoreConfirm'))) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.memory.clearCoreMemory();
      setResults([]);
      setSelected(null);
      await Promise.all([refreshOverview(), refreshFiles()]);
      setStatus(t('memory.clearCoreSuccess'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsContentSection title={t('memory.title')} description={t('memory.description')}>
        <div className="flex flex-col gap-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-text-primary">
                {enabled ? t('memory.enabled') : t('memory.disabled')}
              </p>
              <p className="mt-1 text-xs text-text-muted">{t('memory.toggleHint')}</p>
            </div>
            <button
              onClick={() => {
                void handleToggle();
              }}
              disabled={isBusy}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                enabled
                  ? 'bg-accent text-white hover:opacity-90'
                  : 'bg-surface hover:bg-surface-hover text-text-primary border border-border'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {enabled ? t('memory.disableAction') : t('memory.enableAction')}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label={t('memory.coreCount')} value={overview?.coreCount ?? 0} />
            <MetricCard
              label={t('memory.sessionCount')}
              value={overview?.experienceSessionCount ?? 0}
            />
            <MetricCard
              label={t('memory.chunkCount')}
              value={overview?.experienceChunkCount ?? 0}
            />
            <MetricCard
              label={t('memory.workspaceCount')}
              value={overview?.sourceWorkspaceCount ?? 0}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard
              label={t('memory.latestIngestion')}
              value={
                overview?.latestIngestionAt
                  ? formatRelativeTime(overview.latestIngestionAt, i18n.language)
                  : t('memory.noIngestionYet')
              }
              secondary={
                overview?.latestIngestionAt
                  ? new Date(overview.latestIngestionAt).toLocaleString()
                  : undefined
              }
            />
            {overview?.failedSessionCount ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 text-xs dark:border-rose-900/40 dark:bg-rose-950/20">
                <p className="font-medium text-text-secondary">{t('memory.ingestionStatus')}</p>
                <p className="mt-1 text-text-primary">
                  {t('memory.failedSessions', { count: overview.failedSessionCount })}
                </p>
                {overview.latestErrorAt ? (
                  <p className="mt-1 text-text-muted">
                    {t('memory.lastFailure', {
                      time: new Date(overview.latestErrorAt).toLocaleString(i18n.language),
                    })}
                  </p>
                ) : null}
                {overview.latestError ? (
                  <p className="mt-1.5 text-text-muted">
                    {t(`memory.error.${classifyIngestionError(overview.latestError)}`)}
                  </p>
                ) : null}
                <div className="mt-2 flex gap-3">
                  <button
                    onClick={async () => {
                      setIsBusy(true);
                      try {
                        await window.electronAPI.memory.dismissIngestionErrors();
                        await refreshOverview();
                      } catch (error) {
                        setStatus(error instanceof Error ? error.message : String(error));
                      } finally {
                        setIsBusy(false);
                      }
                    }}
                    disabled={isBusy}
                    className="text-xs font-medium text-accent hover:underline disabled:opacity-60"
                  >
                    {t('memory.dismissErrors')}
                  </button>
                </div>
              </div>
            ) : (
              <InfoCard
                label={t('memory.ingestionStatus')}
                status="healthy"
                value={t('memory.healthy')}
              />
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard
              label={t('memory.currentWorkspace')}
              value={currentWorkspace || t('memory.noWorkspace')}
              secondary={
                overview?.topSourceWorkspaces?.length
                  ? overview.topSourceWorkspaces
                      .slice(0, 3)
                      .map(
                        (item) =>
                          `${item.workspaceKey.split('/').pop() || item.workspaceKey} — ${t('memory.sourceStats', { sessions: item.sessionCount, chunks: item.chunkCount })}`
                      )
                      .join('\n')
                  : undefined
              }
            />
            {/* Embedding coverage is deliberately its own card rather than part of
                "Ingestion status": a chunk stored without a vector was ingested
                successfully, it is just invisible to semantic search. Folding the
                two together would report a failure that did not happen — and hide
                one that did. */}
            {overview?.embeddingEnabled ? (
              <InfoCard
                label={t('memory.embeddingCoverage')}
                status={
                  overview.embeddingError
                    ? 'error'
                    : overview.embeddedChunkCount < overview.experienceChunkCount
                      ? 'warning'
                      : 'healthy'
                }
                value={t('memory.embeddingCoverageValue', {
                  embedded: overview.embeddedChunkCount,
                  total: overview.experienceChunkCount,
                  percent: overview.experienceChunkCount
                    ? Math.round(
                        (overview.embeddedChunkCount / overview.experienceChunkCount) * 100
                      )
                    : 0,
                })}
                secondary={
                  // While a backfill runs, progress is the only thing worth saying:
                  // the coverage number above is a snapshot and cannot move on its own.
                  isBackfilling && backfillProgress
                    ? t('memory.backfillProgress', {
                        processed: backfillProgress.processed,
                        total: backfillProgress.total,
                      })
                    : overview.embeddingError
                      ? [
                          overview.embeddingError,
                          overview.embeddingErrorAt
                            ? t('memory.lastFailure', {
                                time: new Date(overview.embeddingErrorAt).toLocaleString(
                                  i18n.language
                                ),
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join('\n')
                      : overview.embeddedChunkCount < overview.experienceChunkCount
                        ? t('memory.embeddingCoverageHint')
                        : undefined
                }
                // Offered only when there is something to fix. Unlike "Rebuild all"
                // this runs no LLM extraction and deletes nothing — it just computes
                // the missing vectors from text already in the database.
                action={
                  overview.embeddedChunkCount < overview.experienceChunkCount
                    ? {
                        label: isBackfilling
                          ? t('memory.backfillRunning')
                          : t('memory.backfillAction'),
                        onClick: () => {
                          if (!isBackfilling) void handleBackfillEmbeddings();
                        },
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('memory.runtimeTitle')}
        description={t('memory.runtimeDescription')}
      >
        <div className="space-y-4 rounded-xl border border-border-muted bg-background-secondary/60 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <LabeledField label={t('memory.storageRoot')}>
              <input
                value={runtimeDraft.storageRoot || ''}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({ ...prev, storageRoot: event.target.value }))
                }
                placeholder={overview?.storageRoot || ''}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
            <LabeledField label={t('memory.maxNavSteps')}>
              <input
                type="number"
                min={0}
                max={4}
                value={runtimeDraft.maxNavSteps}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({
                    ...prev,
                    maxNavSteps: Number(event.target.value || 0),
                  }))
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
            <LabeledField label={t('memory.ingestionConcurrency')}>
              <input
                type="number"
                min={1}
                max={16}
                value={runtimeDraft.ingestionConcurrency}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({
                    ...prev,
                    ingestionConcurrency: Number(event.target.value || 1),
                  }))
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
            <ToggleField
              label={t('memory.useEmbedding')}
              checked={runtimeDraft.useEmbedding}
              onChange={(checked) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  useEmbedding: checked,
                }))
              }
            />
            <ToggleField
              label={t('memory.evalEnabled')}
              checked={runtimeDraft.evalEnabled ?? false}
              onChange={(checked) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  evalEnabled: checked,
                }))
              }
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <LabeledField label={t('memory.evalArtifactsRoot')}>
              <input
                value={runtimeDraft.evalArtifactsRoot || ''}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({ ...prev, evalArtifactsRoot: event.target.value }))
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
            <LabeledField label={t('memory.evalMaxRounds')}>
              <input
                type="number"
                min={1}
                max={100}
                value={runtimeDraft.evalMaxRounds ?? 12}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({
                    ...prev,
                    evalMaxRounds: Number(event.target.value || 12),
                  }))
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
            <LabeledField label={t('memory.promptIterationRounds')}>
              <input
                type="number"
                min={0}
                max={10}
                value={runtimeDraft.promptIterationRounds ?? 2}
                onChange={(event) =>
                  setRuntimeDraft((prev) => ({
                    ...prev,
                    promptIterationRounds: Number(event.target.value || 2),
                  }))
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
              />
            </LabeledField>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border-muted bg-background/80 p-3">
              <p className="text-sm font-medium text-text-primary">{t('memory.llmConfig')}</p>
              <ToggleField
                label={t('memory.inheritActive')}
                checked={runtimeDraft.llm.inheritFromActive}
                onChange={(checked) =>
                  setRuntimeDraft((prev) => ({
                    ...prev,
                    llm: { ...prev.llm, inheritFromActive: checked },
                  }))
                }
              />
              <LabeledField label={t('memory.modelOverride')}>
                <input
                  value={runtimeDraft.llm.model || ''}
                  onChange={(event) =>
                    setRuntimeDraft((prev) => ({
                      ...prev,
                      llm: { ...prev.llm, model: event.target.value },
                    }))
                  }
                  placeholder={appConfig?.model || ''}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              </LabeledField>
              <LabeledField label={t('memory.baseUrlOverride')}>
                <input
                  value={runtimeDraft.llm.baseUrl || ''}
                  onChange={(event) =>
                    setRuntimeDraft((prev) => ({
                      ...prev,
                      llm: { ...prev.llm, baseUrl: event.target.value },
                    }))
                  }
                  placeholder={appConfig?.baseUrl || ''}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              </LabeledField>
              <LabeledField label={t('memory.apiKeyOverride')}>
                <input
                  type="password"
                  value={runtimeDraft.llm.apiKey || ''}
                  onChange={(event) =>
                    setRuntimeDraft((prev) => ({
                      ...prev,
                      llm: { ...prev.llm, apiKey: event.target.value },
                    }))
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              </LabeledField>
            </div>
            {(embeddingFormatStale || embeddingModelStale) && (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {embeddingModelStale
                    ? t('memory.rebuildOnProviderChange')
                    : t('memory.embeddingFormatStaleWarning')}
                </p>
                <button
                  type="button"
                  onClick={() => void handleRebuildAll()}
                  disabled={isBusy}
                  className="shrink-0 rounded-lg border border-amber-400 bg-background px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-300 dark:hover:bg-amber-900/40"
                >
                  {t('memory.rebuildNow')}
                </button>
              </div>
            )}
            <EmbeddingConfigBlock
              runtimeDraft={runtimeDraft}
              setRuntimeDraft={setRuntimeDraft}
              savedStorageRoot={appConfig?.memoryRuntime?.storageRoot ?? ''}
              isBusy={isBusy}
              setIsBusy={setIsBusy}
              setStatus={setStatus}
            />
          </div>
          <div className="flex justify-end">
            {needsCheck ? (
              <button
                onClick={() => {
                  void handleCheckModels();
                }}
                disabled={isBusy || isChecking || embeddingModelBlocked || !appConfig}
                title={embeddingModelBlocked ? t('memory.embeddingModelChatError') : undefined}
                className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isChecking ? t('memory.checkingModels') : t('memory.checkModelsAvailability')}
              </button>
            ) : (
              <button
                onClick={() => {
                  void handleSaveRuntime();
                }}
                disabled={isBusy || !appConfig || !runtimeDirty || embeddingModelBlocked}
                title={embeddingModelBlocked ? t('memory.embeddingModelChatError') : undefined}
                className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('memory.saveRuntime')}
              </button>
            )}
          </div>
          {checkResult && (
            <div className="flex flex-col items-end gap-0.5 text-xs">
              <span
                className={
                  checkResult.llm.ok
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-rose-600 dark:text-rose-400'
                }
              >
                {checkResult.llm.ok ? '✓' : '✗'} {t('memory.checkLlmLabel')}
              </span>
              <span
                className={
                  checkResult.embedding.skipped
                    ? 'text-text-muted'
                    : checkResult.embedding.ok
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-rose-600 dark:text-rose-400'
                }
              >
                {checkResult.embedding.skipped ? '—' : checkResult.embedding.ok ? '✓' : '✗'}{' '}
                {t('memory.checkEmbeddingLabel')}
                {checkResult.embedding.skipped ? ` (${t('memory.checkSkipped')})` : ''}
              </span>
            </div>
          )}
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('memory.searchTitle')}
        description={t('memory.searchDescription')}
      >
        <div className="space-y-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('memory.searchPlaceholder')}
              className="min-w-0 flex-1 sm:min-w-[180px] rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent"
            />
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as SearchMode)}
              className="shrink-0 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none"
            >
              {hasWorkspace && <option value="workspace">{t('memory.scopeWorkspace')}</option>}
              <option value="all">{t('memory.scopeAll')}</option>
              <option value="global">{t('memory.scopeGlobal')}</option>
            </select>
            <select
              value={sourceWorkspaceFilter}
              onChange={(event) => setSourceWorkspaceFilter(event.target.value)}
              className="shrink-0 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none"
            >
              <option value="">{t('memory.allSources')}</option>
              {overview?.topSourceWorkspaces?.map((item) => (
                <option key={item.workspaceKey} value={item.workspaceKey}>
                  {item.workspaceKey}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                void handleSearch();
              }}
              disabled={isBusy || !query.trim()}
              className="shrink-0 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('memory.searchAction')}
            </button>
          </div>
          {hasWorkspace && (
            <p className="text-xs text-text-muted">
              {t('memory.currentWorkspace')}: {currentWorkspace}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <ResultGroup
                title={t('memory.groupCore')}
                items={groupedResults.core}
                selectedId={selected?.id || null}
                onSelect={handleSelectResult}
                emptyLabel={t('memory.noResults')}
              />
              <ResultGroup
                title={t('memory.groupSessions')}
                items={groupedResults.sessions}
                selectedId={selected?.id || null}
                onSelect={handleSelectResult}
                emptyLabel={t('memory.noResults')}
              />
              <ResultGroup
                title={t('memory.groupChunks')}
                items={groupedResults.chunks}
                selectedId={selected?.id || null}
                onSelect={handleSelectResult}
                emptyLabel={t('memory.noResults')}
              />
              <ResultGroup
                title={t('memory.groupRawSessions')}
                items={groupedResults.raw}
                selectedId={selected?.id || null}
                onSelect={handleSelectResult}
                emptyLabel={t('memory.noResults')}
              />
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-border-muted bg-background/80 p-4">
                <p className="text-sm font-semibold text-text-primary">{t('memory.detailTitle')}</p>
                {selected ? (
                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-text-muted">
                        {selected.kind}
                      </p>
                      <p className="mt-1 text-sm font-medium text-text-primary">{selected.title}</p>
                    </div>
                    <p className="text-sm text-text-secondary whitespace-pre-wrap">
                      {selected.summary}
                    </p>
                    {selected.sourceFile && (
                      <p className="text-xs text-text-muted">
                        {t('memory.sourceFile')}: {selected.sourceFile}
                      </p>
                    )}
                    {selected.sessionId && (
                      <button
                        onClick={() => {
                          void handleInspectSession(
                            selected.sessionId!,
                            selected.sourceWorkspace || selected.workspaceKey
                          );
                        }}
                        className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary"
                      >
                        {t('memory.inspectSession')}
                      </button>
                    )}
                    {selected.details && (
                      <pre className="max-h-56 overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                        {selected.details}
                      </pre>
                    )}
                    {selected.rawText && (
                      <pre className="max-h-64 overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                        {selected.rawText}
                      </pre>
                    )}
                    {selected.sourceExcerpt && (
                      <div className="rounded-lg border border-border-muted bg-background-secondary/60 p-3 text-xs text-text-secondary whitespace-pre-wrap">
                        {selected.sourceExcerpt}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-text-muted">{t('memory.noSelection')}</p>
                )}
              </div>

              <div className="rounded-xl border border-border-muted bg-background/80 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-text-primary">
                    {t('memory.inspectSession')}
                  </p>
                  {inspectedSession?.filePath && (
                    <button
                      onClick={() => {
                        void window.electronAPI.showItemInFolder(inspectedSession.filePath);
                      }}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary"
                    >
                      {t('memory.revealInFinder')}
                    </button>
                  )}
                </div>
                {inspectedSession ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-border-muted bg-background-secondary/60 p-3">
                      <p className="text-xs text-text-muted">
                        {inspectedSession.sourceWorkspace || t('memory.noWorkspace')}
                      </p>
                      <p className="mt-1 text-sm font-medium text-text-primary">
                        {inspectedSession.session.summary}
                      </p>
                    </div>
                    <pre className="max-h-48 overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                      {JSON.stringify(inspectedSession.session.rawSession, null, 2)}
                    </pre>
                    <div className="space-y-2">
                      {inspectedSession.chunks.map((chunk) => (
                        <div
                          key={chunk.id}
                          className="rounded-lg border border-border-muted bg-background-secondary/60 p-3"
                        >
                          <p className="text-sm font-medium text-text-primary">{chunk.summary}</p>
                          <p className="mt-1 text-xs text-text-muted">
                            turns: {chunk.sourceTurns.join(', ')}
                          </p>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                            {chunk.rawText}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-text-muted">{t('memory.inspectSessionHint')}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('memory.filesTitle')}
        description={t('memory.filesDescription')}
      >
        <div className="grid gap-4 rounded-xl border border-border-muted bg-background-secondary/60 p-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {t('memory.fileList')}
              </p>
              <button
                onClick={() => {
                  void refreshFiles();
                }}
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary"
              >
                {t('memory.refreshFiles')}
              </button>
            </div>
            {files.length > 0 ? (
              files.map((file) => (
                <button
                  key={file.filePath}
                  onClick={() => {
                    void handleSelectFile(file.filePath);
                  }}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    selectedFilePath === file.filePath
                      ? 'border-accent bg-accent/5'
                      : 'border-border-muted bg-background/80 hover:bg-surface-hover'
                  }`}
                >
                  <p className="text-sm font-medium text-text-primary">
                    {file.label}
                    {file.storage === 'sqlite' && (
                      <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-accent">
                        SQLite
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">{file.filePath}</p>
                  <p className="mt-2 text-[11px] text-text-muted">
                    {file.sizeBytes} bytes
                    {typeof file.sessionCount === 'number'
                      ? ` · ${file.sessionCount} sessions`
                      : ''}
                    {typeof file.chunkCount === 'number' ? ` · ${file.chunkCount} chunks` : ''}
                  </p>
                </button>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border-muted bg-background/50 p-3 text-sm text-text-muted">
                {t('memory.noFiles')}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border-muted bg-background/80 p-4">
            {selectedIsSqlite ? (
              <ExperienceDbStatusCard
                status={experienceDbStatus}
                exists={selectedFile?.exists ?? false}
                isVacuuming={isVacuuming}
                isExporting={isExporting}
                onVacuum={() => {
                  void handleVacuumExperienceDb();
                }}
                onExport={() => {
                  void handleExportExperienceJson();
                }}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {t('memory.fileContent')}
                    </p>
                    {fileContent?.filePath && (
                      <p className="mt-1 text-xs text-text-muted">{fileContent.filePath}</p>
                    )}
                  </div>
                  {fileContent?.filePath && (
                    <button
                      onClick={() => {
                        void window.electronAPI.showItemInFolder(fileContent.filePath);
                      }}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary"
                    >
                      {t('memory.revealInFinder')}
                    </button>
                  )}
                </div>
                {fileContent ? (
                  <pre className="mt-3 max-h-[34rem] overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                    {fileContent.parsed
                      ? JSON.stringify(fileContent.parsed, null, 2)
                      : fileContent.text || t('memory.emptyFile')}
                  </pre>
                ) : (
                  <p className="mt-3 text-sm text-text-muted">{t('memory.selectFileHint')}</p>
                )}
              </>
            )}
          </div>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('memory.maintenanceTitle')}
        description={t('memory.maintenanceDescription')}
      >
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              void handleRebuildWorkspace();
            }}
            disabled={!hasWorkspace || isBusy}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('memory.rebuildWorkspace')}
          </button>
          <button
            onClick={() => {
              void handleRebuildAll();
            }}
            disabled={isBusy}
            className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('memory.rebuildAll')}
          </button>
          <button
            onClick={() => {
              void handleClearWorkspace();
            }}
            disabled={!hasWorkspace || isBusy}
            className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            {t('memory.clearWorkspace')}
          </button>
          <button
            onClick={() => {
              void handleClearCore();
            }}
            disabled={isBusy}
            className="rounded-lg border border-rose-300/60 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
          >
            {t('memory.clearCore')}
          </button>
        </div>
      </SettingsContentSection>

      {/* Advanced Configuration */}
      <AdvancedMemoryConfig
        runtimeDraft={runtimeDraft}
        setRuntimeDraft={setRuntimeDraft}
        isBusy={isBusy}
        setIsBusy={setIsBusy}
        setStatus={setStatus}
      />

      {status && (
        <div className="rounded-lg border border-border-muted bg-background-secondary/70 px-4 py-3 text-sm text-text-secondary">
          {status}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Embedding configuration block — 3-way provider selector
// ---------------------------------------------------------------------------

type EmbeddingMode = 'local' | 'inherit' | 'custom';

function resolveEmbeddingMode(embedding: MemoryRuntimeConfig['embedding']): EmbeddingMode {
  if (embedding.provider === 'local') return 'local';
  if (embedding.inheritFromActive) return 'inherit';
  return 'custom';
}

function EmbeddingConfigBlock({
  runtimeDraft,
  setRuntimeDraft,
  savedStorageRoot,
  isBusy,
  setIsBusy,
  setStatus,
}: {
  runtimeDraft: MemoryRuntimeConfig;
  setRuntimeDraft: (fn: (prev: MemoryRuntimeConfig) => MemoryRuntimeConfig) => void;
  /** The last-saved storageRoot from appConfig — used to detect unsaved changes. */
  savedStorageRoot: string;
  isBusy: boolean;
  setIsBusy: (busy: boolean) => void;
  setStatus: (status: string | null) => void;
}) {
  const { t } = useTranslation();
  const mode = resolveEmbeddingMode(runtimeDraft.embedding);

  // Custom-mode model-override validation (only meaningful in custom mode).
  const modelIssue =
    mode === 'custom' ? classifyEmbeddingModel(runtimeDraft.embedding.model ?? '') : null;

  // True when the draft storageRoot differs from the saved one — removal IPC
  // would target the old saved root, not the pending new one.
  const isStorageRootDirty = (runtimeDraft.storageRoot ?? '') !== savedStorageRoot;

  // Local model download progress
  const [downloadProgress, setDownloadProgress] = useState<LocalEmbeddingProgress | null>(null);
  // Whether the model is already cached — seeded from status, updated by progress events
  const [localModelDownloaded, setLocalModelDownloaded] = useState<boolean | null>(null);
  // Persistent error message when the model failed to download (survives missed events).
  const [modelError, setModelError] = useState<string | null>(null);
  // True while a manual retry download is in flight.
  const [isRetrying, setIsRetrying] = useState(false);

  // Fetch initial status to seed downloaded + any persistent error state.
  useEffect(() => {
    window.electronAPI.memory
      .getLocalModelStatus()
      .then((status) => {
        setLocalModelDownloaded(status.downloaded);
        setModelError(status.state === 'error' ? (status.error ?? '') : null);
      })
      .catch(() => setLocalModelDownloaded(false));
  }, []);

  // Subscribe to download progress events
  useEffect(() => {
    const unsub = window.electronAPI.memory.onLocalEmbeddingProgress((p) => {
      setDownloadProgress(p);
      if (p.status === 'ready') {
        setLocalModelDownloaded(true);
        setModelError(null);
        setDownloadProgress(null);
      } else if (p.status === 'error') {
        // Persist the error for a stable banner, and re-check actual cache state rather
        // than forcing false so a network blip doesn't mark an already-downloaded model
        // as absent.
        setModelError(p.message ?? '');
        window.electronAPI.memory
          .getLocalModelStatus()
          .then((status) => setLocalModelDownloaded(status.downloaded))
          .catch(() => {
            /* keep current state on IPC failure */
          });
      }
    });
    return () => unsub();
  }, []);

  const handleRetryDownload = async () => {
    setIsRetrying(true);
    setModelError(null);
    setDownloadProgress(null);
    try {
      // force=true clears any backoff window so the attempt fires immediately.
      const status = await window.electronAPI.memory.warmUpLocalModel(true);
      setLocalModelDownloaded(status.downloaded);
      setModelError(status.state === 'error' ? (status.error ?? '') : null);
    } catch (err) {
      setModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRetrying(false);
    }
  };

  const handleModeChange = (next: EmbeddingMode) => {
    if (next === 'local') {
      // Warm-up on select: start the download immediately (fire-and-forget) so any
      // failure surfaces while the user is looking at this panel, not silently on the
      // next ingestion. Progress/errors arrive via the onLocalEmbeddingProgress
      // subscription and the status refetch below. force=false respects any backoff.
      void window.electronAPI.memory
        .warmUpLocalModel(false)
        .then((status) => {
          setLocalModelDownloaded(status.downloaded);
          setModelError(status.state === 'error' ? (status.error ?? '') : null);
        })
        .catch(() => {
          /* status subscription still reflects outcome */
        });
    }
    setRuntimeDraft((prev) => {
      const base = { ...prev.embedding };
      if (next === 'local') {
        // Selecting local mode enables embeddings — selecting local is an explicit opt-in.
        return {
          ...prev,
          useEmbedding: true,
          embedding: {
            ...base,
            provider: 'local' as EmbeddingProviderType,
            inheritFromActive: false,
          },
        };
      }
      if (next === 'inherit') {
        return {
          ...prev,
          // provider: undefined + inheritFromActive: true — main process normalizeModelConfig
          // falls back to the active API provider (line 84 in memory-llm-client.ts).
          // Clear override fields so hidden values cannot affect future modes or cause confusion.
          // useEmbedding is left unchanged — the user controls it via the toggle above.
          embedding: {
            ...base,
            provider: undefined,
            inheritFromActive: true,
            model: '',
            baseUrl: '',
            apiKey: '',
          },
        };
      }
      // custom — provider: undefined + inheritFromActive: false.
      // normalizeModelConfig resolves undefined provider to the active API provider
      // (input?.provider || activeProvider at line 84 of memory-llm-client.ts),
      // so model/baseUrl/apiKey overrides apply on top of the active provider.
      // useEmbedding is left unchanged — the user controls it via the toggle above.
      return {
        ...prev,
        embedding: { ...base, provider: undefined, inheritFromActive: false },
      };
    });
  };

  const handleRemoveModel = async () => {
    if (!window.confirm(t('memory.removeDownloadedModelConfirm'))) return;
    setIsBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.memory.removeLocalModel();
      if (!result.success) {
        setStatus(result.error ?? t('memory.embeddingModelDownloadFailed'));
        return;
      }
      setLocalModelDownloaded(false);
      setDownloadProgress(null);
      setStatus(t('memory.removeDownloadedModelSuccess'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const modeOptions: { value: EmbeddingMode; label: string }[] = [
    { value: 'local', label: t('memory.embeddingProviderLocal') },
    { value: 'inherit', label: t('memory.embeddingProviderInherit') },
    { value: 'custom', label: t('memory.embeddingProviderCustom') },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-border-muted bg-background/80 p-3">
      <p className="text-sm font-medium text-text-primary">{t('memory.embeddingConfig')}</p>

      {/* Provider selector */}
      <div className="flex flex-wrap gap-1.5">
        {modeOptions.map((opt) => (
          <button
            type="button"
            key={opt.value}
            onClick={() => handleModeChange(opt.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === opt.value
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-background text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Local mode status */}
      {mode === 'local' && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">{t('memory.localModelDescription')}</p>

          {/* Download progress */}
          {downloadProgress?.status === 'downloading' || isRetrying ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>
                  {t('memory.localModelDownloading', {
                    progress: Math.round(downloadProgress?.progress ?? 0),
                  })}
                </span>
                {downloadProgress?.file && (
                  <span className="max-w-[200px] truncate text-text-muted">
                    {downloadProgress.file.split(/[/\\]/).pop()}
                  </span>
                )}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-200"
                  style={{ width: `${downloadProgress?.progress ?? 0}%` }}
                />
              </div>
            </div>
          ) : modelError !== null ? (
            <div className="space-y-1.5 rounded border border-rose-300 bg-rose-50 p-2 dark:border-rose-900/60 dark:bg-rose-950/30">
              <p className="text-xs text-rose-600 dark:text-rose-400">
                {t('memory.embeddingModelDownloadFailed')}
              </p>
              <p className="text-xs text-text-muted">
                {t('memory.localModelErrorLexicalFallback')}
              </p>
              <button
                type="button"
                onClick={() => void handleRetryDownload()}
                disabled={isBusy || isRetrying}
                className="rounded border border-border bg-background px-2 py-1 text-xs text-text-secondary hover:text-accent disabled:opacity-60"
              >
                {t('memory.localModelRetryDownload')}
              </button>
            </div>
          ) : localModelDownloaded === true ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-green-700 dark:text-green-400">
                ✓ {t('memory.localModelReady')}
              </p>
              <button
                type="button"
                onClick={() => void handleRemoveModel()}
                disabled={isBusy || isStorageRootDirty}
                title={isStorageRootDirty ? t('memory.saveRuntime') : undefined}
                className="rounded border border-border bg-background px-2 py-1 text-xs text-text-muted hover:text-rose-600 disabled:opacity-60"
              >
                {t('memory.removeDownloadedModel')}
              </button>
            </div>
          ) : (
            <p className="text-xs text-text-muted">{t('memory.localModelNotDownloaded')}</p>
          )}
        </div>
      )}

      {/* Inherit mode — no extra fields */}
      {mode === 'inherit' && (
        <p className="text-xs text-text-muted">{t('memory.runtimeDescription')}</p>
      )}

      {/* Custom mode — model / baseUrl / apiKey */}
      {mode === 'custom' && (
        <div className="space-y-3">
          <LabeledField label={t('memory.modelOverride')}>
            <input
              value={runtimeDraft.embedding.model || ''}
              onChange={(event) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  embedding: { ...prev.embedding, model: event.target.value },
                }))
              }
              className={`w-full rounded-lg border bg-background px-3 py-2.5 text-sm text-text-primary outline-none ${
                modelIssue === 'chat'
                  ? 'border-rose-400 focus:border-rose-500'
                  : 'border-border focus:border-accent'
              }`}
            />
            {modelIssue === 'chat' && (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                {t('memory.embeddingModelChatError')}
              </p>
            )}
            {modelIssue === 'prefix' && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('memory.embeddingModelPrefixWarning')}
              </p>
            )}
          </LabeledField>
          <LabeledField label={t('memory.baseUrlOverride')}>
            <input
              value={runtimeDraft.embedding.baseUrl || ''}
              onChange={(event) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  embedding: { ...prev.embedding, baseUrl: event.target.value },
                }))
              }
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
            />
          </LabeledField>
          <LabeledField label={t('memory.apiKeyOverride')}>
            <input
              type="password"
              value={runtimeDraft.embedding.apiKey || ''}
              onChange={(event) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  embedding: { ...prev.embedding, apiKey: event.target.value },
                }))
              }
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
            />
          </LabeledField>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border-muted bg-background/80 p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function InfoCard({
  label,
  value,
  secondary,
  status,
  action,
}: {
  label: string;
  value: string;
  secondary?: string;
  status?: 'healthy' | 'warning' | 'error';
  action?: { label: string; onClick: () => void };
}) {
  const statusColors = {
    healthy: 'border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-950/20',
    warning: 'border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20',
    error: 'border-rose-200 bg-rose-50/50 dark:border-rose-900/40 dark:bg-rose-950/20',
  };
  const borderClass = status ? statusColors[status] : 'border-border-muted bg-background/80';

  return (
    <div className={`rounded-lg border p-3 text-xs text-text-muted ${borderClass}`}>
      <p className="font-medium text-text-secondary">{label}</p>
      <p className="mt-1 break-all">{value}</p>
      {secondary ? (
        <p className="mt-1.5 whitespace-pre-line break-all text-text-muted">{secondary}</p>
      ) : null}
      {action ? (
        <button
          onClick={action.onClick}
          className="mt-2 text-xs font-medium text-accent hover:underline"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-background/70 px-3 py-2.5">
      <span className="text-sm text-text-primary">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ResultGroup({
  title,
  items,
  selectedId,
  onSelect,
  emptyLabel,
}: {
  title: string;
  items: MemorySearchResult[];
  selectedId: string | null;
  onSelect: (id: string) => void | Promise<void>;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</p>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                void onSelect(item.id);
              }}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${
                selectedId === item.id
                  ? 'border-accent bg-accent/5'
                  : 'border-border-muted bg-background/80 hover:bg-surface-hover'
              }`}
            >
              <p className="text-sm font-medium text-text-primary">{item.title}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{item.contentPreview}</p>
              {(item.sourceWorkspace || item.sourceSessionTitle) && (
                <p className="mt-2 text-[11px] text-text-muted">
                  {[item.sourceWorkspace, item.sourceSessionTitle].filter(Boolean).join(' · ')}
                </p>
              )}
              {item.sourceFile && (
                <p className="mt-2 text-[11px] text-text-muted">{item.sourceFile}</p>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-muted bg-background/50 p-3 text-sm text-text-muted">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

function AdvancedMemoryConfig({
  runtimeDraft,
  setRuntimeDraft,
  isBusy,
  setIsBusy,
  setStatus,
}: {
  runtimeDraft: MemoryRuntimeConfig;
  setRuntimeDraft: (fn: (prev: MemoryRuntimeConfig) => MemoryRuntimeConfig) => void;
  isBusy: boolean;
  setIsBusy: (busy: boolean) => void;
  setStatus: (status: string | null) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showBuiltinPrompt, setShowBuiltinPrompt] = useState(false);
  const [builtinPrompt, setBuiltinPrompt] = useState('');
  const [customPromptExists, setCustomPromptExists] = useState(false);

  // Check if custom prompt file exists
  useEffect(() => {
    window.electronAPI.memory
      .getCustomExtractionPrompt()
      .then((result) => {
        setCustomPromptExists(result.exists);
      })
      .catch(() => setCustomPromptExists(false));
  }, []);

  const handleShowBuiltin = useCallback(async () => {
    const prompt = await window.electronAPI.memory.getBuiltinExtractionPrompt();
    setBuiltinPrompt(prompt);
    setShowBuiltinPrompt(true);
  }, []);

  const handleCreateCustom = useCallback(async () => {
    const result = await window.electronAPI.memory.createCustomExtractionPrompt();
    if (result?.success) {
      setCustomPromptExists(true);
      await window.electronAPI.memory.openFileInEditor();
    }
  }, []);

  const handleOpenInEditor = useCallback(async () => {
    await window.electronAPI.memory.openFileInEditor();
  }, []);

  const handleResetPrompt = useCallback(async () => {
    if (!window.confirm(t('memory.promptResetConfirm'))) return;
    await window.electronAPI.memory.deleteCustomExtractionPrompt();
    setCustomPromptExists(false);
  }, [t]);

  const handleSaveAdvanced = useCallback(async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.config.save({ memoryRuntime: runtimeDraft });
      setStatus(t('memory.advancedSaved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }, [runtimeDraft, setIsBusy, setStatus, t]);

  const handleResetAll = useCallback(() => {
    if (!window.confirm(t('memory.advancedResetConfirm'))) return;
    setRuntimeDraft((prev) => ({
      ...prev,
      recencyFloor: 0.05,
      recencyCeiling: 0.25,
      recencyDecayDays: 90,
      supersessionPenalty: 0.2,
      supersessionKeywordThreshold: 0.5,
    }));
  }, [setRuntimeDraft, t]);

  const updateField = useCallback(
    (field: keyof MemoryRuntimeConfig, value: number | string) => {
      setRuntimeDraft((prev) => ({ ...prev, [field]: value }));
    },
    [setRuntimeDraft]
  );

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-border-muted bg-background/70 px-4 py-3 text-left text-sm font-medium text-text-secondary hover:bg-surface-hover"
      >
        <span className="text-xs">▶</span>
        {t('memory.advancedTitle')}
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border-muted bg-background/70 p-4">
      {/* Header */}
      <button
        onClick={() => setExpanded(false)}
        className="flex w-full items-center gap-2 text-left text-sm font-medium text-text-primary"
      >
        <span className="text-xs">▼</span>
        {t('memory.advancedTitle')}
      </button>

      {/* Warning + Help */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
        <span className="text-amber-600 dark:text-amber-400">⚠️</span>
        <p className="flex-1 text-xs text-amber-900 dark:text-amber-200">
          {t('memory.advancedWarning')}
        </p>
        <button
          onClick={() => setShowHelp(true)}
          className="rounded border border-amber-400/60 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:border-amber-500/40 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
        >
          {t('memory.advancedHelpButton')}
        </button>
      </div>

      {/* Retrieval Scoring */}
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {t('memory.advancedScoringTitle')}
        </p>
        <NumberField
          label={t('memory.recencyFloor')}
          hint={t('memory.recencyFloorHint')}
          value={runtimeDraft.recencyFloor ?? 0.05}
          onChange={(v) => updateField('recencyFloor', v)}
          min={0.01}
          max={0.2}
          step={0.01}
        />
        <NumberField
          label={t('memory.recencyCeiling')}
          hint={t('memory.recencyCeilingHint')}
          value={runtimeDraft.recencyCeiling ?? 0.25}
          onChange={(v) => updateField('recencyCeiling', v)}
          min={0.1}
          max={0.5}
          step={0.01}
        />
        <NumberField
          label={t('memory.recencyDecayDays')}
          hint={t('memory.recencyDecayDaysHint')}
          value={runtimeDraft.recencyDecayDays ?? 90}
          onChange={(v) => updateField('recencyDecayDays', v)}
          min={30}
          max={180}
          step={1}
        />
        <NumberField
          label={t('memory.supersessionPenalty')}
          hint={t('memory.supersessionPenaltyHint')}
          value={runtimeDraft.supersessionPenalty ?? 0.2}
          onChange={(v) => updateField('supersessionPenalty', v)}
          min={0}
          max={0.5}
          step={0.01}
        />
        <NumberField
          label={t('memory.supersessionKeywordThreshold')}
          hint={t('memory.supersessionKeywordThresholdHint')}
          value={runtimeDraft.supersessionKeywordThreshold ?? 0.5}
          onChange={(v) => updateField('supersessionKeywordThreshold', v)}
          min={0.3}
          max={0.8}
          step={0.05}
        />
      </div>

      {/* Extraction Prompt */}
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {t('memory.advancedPromptTitle')}
        </p>
        <p className="text-xs text-text-secondary">
          {customPromptExists ? t('memory.promptUsingCustom') : t('memory.promptUsingBuiltin')}
        </p>
        <div className="flex flex-wrap gap-2">
          {!customPromptExists ? (
            <>
              <button
                onClick={() => void handleShowBuiltin()}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-hover"
              >
                {t('memory.promptShowBuiltin')}
              </button>
              <button
                onClick={() => void handleCreateCustom()}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-hover"
              >
                {t('memory.promptCreateCustom')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => void handleOpenInEditor()}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-hover"
              >
                {t('memory.promptOpenInEditor')}
              </button>
              <button
                onClick={() => void handleResetPrompt()}
                className="rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-900 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
              >
                {t('memory.promptResetToDefault')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 border-t border-border-muted pt-3">
        <button
          onClick={() => void handleSaveAdvanced()}
          disabled={isBusy}
          className="rounded-lg border border-accent bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('memory.advancedSave')}
        </button>
        <button
          onClick={handleResetAll}
          className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-hover"
        >
          {t('memory.advancedResetAll')}
        </button>
      </div>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-text-primary">
                {t('memory.advancedHelpTitle')}
              </h3>
              <button
                onClick={() => setShowHelp(false)}
                className="text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4 text-sm text-text-secondary">
              <p>{t('memory.advancedHelpIntro')}</p>
              <p className="font-medium text-text-primary">{t('memory.advancedHelpFormula')}</p>

              <div className="space-y-2">
                <h4 className="font-semibold text-text-primary">
                  {t('memory.advancedHelpRecencyTitle')}
                </h4>
                <p>{t('memory.advancedHelpRecencyDesc')}</p>
                <ul className="ml-4 list-disc space-y-1 text-xs">
                  <li>{t('memory.advancedHelpRecencyCeiling')}</li>
                  <li>{t('memory.advancedHelpRecencyFloor')}</li>
                  <li>{t('memory.advancedHelpRecencyDecay')}</li>
                </ul>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold text-text-primary">
                  {t('memory.advancedHelpSupersessionTitle')}
                </h4>
                <p>{t('memory.advancedHelpSupersessionDesc')}</p>
                <ul className="ml-4 list-disc space-y-1 text-xs">
                  <li>{t('memory.advancedHelpSupersessionPenalty')}</li>
                  <li>{t('memory.advancedHelpSupersessionThreshold')}</li>
                </ul>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold text-text-primary">
                  {t('memory.advancedHelpPromptTitle')}
                </h4>
                <p>{t('memory.advancedHelpPromptDesc')}</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowHelp(false)}
                className="rounded-lg border border-accent bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20"
              >
                {t('memory.advancedHelpGotIt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Built-in Prompt Modal (read-only) */}
      {showBuiltinPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-text-primary">
                {t('memory.promptBuiltinTitle')}
              </h3>
              <button
                onClick={() => setShowBuiltinPrompt(false)}
                className="text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </div>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border-muted bg-background-secondary p-4 text-xs text-text-secondary">
              {builtinPrompt}
            </pre>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowBuiltinPrompt(false)}
                className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover"
              >
                {t('memory.promptClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-background/70 px-3 py-2.5">
      <div className="flex-1">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="text-[11px] text-text-muted">{hint}</p>
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        min={min}
        max={max}
        step={step}
        className="w-20 rounded border border-border bg-background px-2 py-1 text-right text-sm text-text-primary"
      />
    </div>
  );
}

function ExperienceDbStatusCard({
  status,
  exists,
  isVacuuming,
  isExporting,
  onVacuum,
  onExport,
}: {
  status: ExperienceDbStatus | null;
  /** Whether the selected memory.db entry exists on disk. */
  exists: boolean;
  isVacuuming: boolean;
  isExporting: boolean;
  onVacuum: () => void;
  onExport: () => void;
}) {
  const { t } = useTranslation();
  // Defensive normalization: the backend type guarantees these fields, but guard the
  // render boundary against partial/undefined payloads (older schema, IPC mismatch)
  // so the card degrades gracefully instead of throwing or rendering NaN.
  const breakdown = status?.workspaceBreakdown ?? [];
  const sizeLabel =
    status && typeof status.sizeBytes === 'number' ? formatFileSize(status.sizeBytes) : '—';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">{t('memory.experienceDbTitle')}</p>
          <p className="mt-1 text-xs text-text-muted">memory.db</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onExport}
            disabled={!status || isExporting}
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isExporting ? t('memory.exporting') : t('memory.exportJson')}
          </button>
          <button
            onClick={onVacuum}
            disabled={!status || isVacuuming}
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isVacuuming ? t('memory.vacuuming') : t('memory.vacuum')}
          </button>
        </div>
      </div>

      {!exists ? (
        <p className="text-sm text-text-muted">{t('memory.experienceDbNotCreatedYet')}</p>
      ) : status ? (
        <div className="space-y-2">
          <p className="text-[11px] text-text-muted">
            {t('memory.experienceDbSchema', { version: status.schemaVersion ?? 1 })} ·{' '}
            {status.journalMode ? status.journalMode.toUpperCase() : '—'} · {sizeLabel}
          </p>
          <p className="text-sm text-text-primary">
            {t('memory.experienceDbCounts', {
              sessions: status.sessionCount ?? 0,
              chunks: status.chunkCount ?? 0,
            })}
          </p>
          <p className="text-xs text-text-secondary">
            <span className="text-text-muted">{t('memory.embeddingModel')}:</span>{' '}
            {status.embeddingModel ? (
              <>
                {status.embeddingModel}
                {status.embeddingDim != null
                  ? ` · ${t('memory.dimensionShort')} ${status.embeddingDim}`
                  : ''}
              </>
            ) : (
              t('memory.noEmbeddingModel')
            )}
          </p>
          <p className="text-xs text-text-secondary">
            <span className="text-text-muted">{t('memory.integrity')}:</span>{' '}
            {status.integrityOk ? t('memory.integrityOk') : t('memory.integrityFailed')}
          </p>

          <div>
            <p className="text-xs text-text-muted">{t('memory.byWorkspace')}</p>
            {breakdown.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {breakdown.map((ws, idx) => {
                  const key =
                    ws.workspaceKey && ws.workspaceKey !== '(none)' ? ws.workspaceKey : '';
                  const label = key
                    ? (key.split(/[\\/]/).filter(Boolean).pop() ?? key)
                    : t('memory.globalWorkspace');
                  return (
                    <li
                      key={`${ws.workspaceKey || '(none)'}-${idx}`}
                      className="flex items-center justify-between gap-2 text-xs text-text-secondary"
                      title={ws.workspaceKey || undefined}
                    >
                      <span className="truncate">{label}</span>
                      <span className="shrink-0 text-text-muted">
                        {ws.sessionCount ?? 0} · {ws.chunkCount ?? 0}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-text-muted">{t('memory.noWorkspaces')}</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t('memory.experienceDbStatusMissing')}</p>
      )}
    </div>
  );
}
