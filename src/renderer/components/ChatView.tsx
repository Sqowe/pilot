import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useActiveSessionId,
  useCurrentSession,
  useActiveSessionMessages,
  useActivePartialContent,
  useActiveTurn,
  usePendingTurns,
  useActiveExecutionClock,
  useAppConfig,
} from '../store/selectors';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { GroupedMessages } from './message/GroupedMessages';
import { ExportSelectionBar } from './ExportSelectionBar';
import { ExportOptionsDialog } from './ExportOptionsDialog';
import type { ExportOptions } from './ExportOptionsDialog';
import type { Message, ContentBlock } from '../types';
import { Send, Square, Plus, Loader2, Plug, X, Clock, Layers, Download } from 'lucide-react';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

export function ChatView() {
  const { t } = useTranslation();
  // Scoped selectors — each subscription only re-renders when its slice changes
  const activeSessionId = useActiveSessionId();
  const activeSession = useCurrentSession();
  const messages = useActiveSessionMessages();
  const { partialMessage, partialThinking } = useActivePartialContent();
  const activeTurn = useActiveTurn();
  const pendingTurns = usePendingTurns();
  const executionClock = useActiveExecutionClock();
  const appConfig = useAppConfig();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const setIsConfigured = useAppStore((s) => s.setIsConfigured);
  const { continueSession, stopSession, isElectron } = useIPC();
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitchingSet, setIsSwitchingSet] = useState(false);
  const switchRequestRef = useRef(0);
  const [activeConnectors, setActiveConnectors] = useState<
    { id: string; name: string; connected: boolean; toolCount: number }[]
  >([]);
  const [showConnectorLabel, setShowConnectorLabel] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const connectorMeasureRef = useRef<HTMLDivElement>(null);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // Export selection mode
  const [isExportSelectMode, setIsExportSelectMode] = useState(false);
  const [exportSelectedIds, setExportSelectedIds] = useState<Set<string>>(new Set());
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showExportDropdown, setShowExportDropdown] = useState(false);

  // Reset export selection state when switching sessions
  useEffect(() => {
    setIsExportSelectMode(false);
    setExportSelectedIds(new Set());
    setShowExportOptions(false);
    setShowExportDropdown(false);
  }, [activeSessionId]);

  // Shared helper: determine if a message is exportable
  // A message is exportable if it's not partial/system.
  // The serializer handles skipping messages with no visible content.
  const isExportableMessage = useCallback(
    (m: Message) => !m.id.startsWith('partial-') && m.role !== 'system',
    []
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevPartialLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const isScrollingRef = useRef(false);

  const hasActiveTurn = Boolean(activeTurn);
  const pendingCount = pendingTurns.length;
  const isSessionRunning = activeSession?.status === 'running';
  const canStop = isSessionRunning || hasActiveTurn || pendingCount > 0;

  // Track last memory retrieval timestamp for the "memory contributed" badge
  const [lastRetrievalTimestamp, setLastRetrievalTimestamp] = useState<number | undefined>();
  const fetchRetrievalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  // Derive a stable signal for "last turn completed" — the latest assistant message timestamp
  const lastAssistantTimestamp = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i].id.startsWith('partial-')) {
        return messages[i].timestamp;
      }
    }
    return 0;
  }, [messages]);

  useEffect(() => {
    // Reset only on session switch or memory disabled
    if (prevSessionIdRef.current !== activeSessionId) {
      prevSessionIdRef.current = activeSessionId ?? null;
      setLastRetrievalTimestamp(undefined);
    }

    if (!activeSessionId || !activeSession?.memoryEnabled) {
      setLastRetrievalTimestamp(undefined);
      return;
    }

    let cancelled = false;

    // Debounce: wait 500ms after last assistant message changes before fetching
    if (fetchRetrievalRef.current) clearTimeout(fetchRetrievalRef.current);
    fetchRetrievalRef.current = setTimeout(async () => {
      try {
        const state = await window.electronAPI.memory.getPanelState(
          activeSession.cwd || undefined,
          activeSessionId
        );
        if (cancelled) return;
        if (state?.lastRetrieval?.tokensInjected && state.lastRetrieval.tokensInjected > 0) {
          setLastRetrievalTimestamp(state.lastRetrieval.timestamp);
        } else {
          setLastRetrievalTimestamp(undefined);
        }
      } catch {
        // Ignore — badge just won't show
      }
    }, 500);

    return () => {
      cancelled = true;
      if (fetchRetrievalRef.current) clearTimeout(fetchRetrievalRef.current);
    };
  }, [activeSessionId, activeSession?.memoryEnabled, activeSession?.cwd, lastAssistantTimestamp]);

  // Config set selection
  const configSets = appConfig?.configSets ?? [];
  const activeConfigSetId = appConfig?.activeConfigSetId ?? '';

  const handleConfigSetSwitch = useCallback(
    async (setId: string) => {
      if (!isElectron || !window.electronAPI || setId === activeConfigSetId || isSwitchingSet)
        return;
      const requestId = ++switchRequestRef.current;
      setIsSwitchingSet(true);
      try {
        const result = await window.electronAPI.config.switchSet({ id: setId });
        if (switchRequestRef.current === requestId) {
          setAppConfig(result.config);
          setIsConfigured(Boolean(result.config?.isConfigured));
        }
      } catch (error) {
        console.error('[ChatView] Failed to switch config set:', error);
      } finally {
        if (switchRequestRef.current === requestId) {
          setIsSwitchingSet(false);
        }
      }
    },
    [isElectron, activeConfigSetId, isSwitchingSet, setAppConfig, setIsConfigured]
  );

  const displayedMessages = useMemo(() => {
    if (!activeSessionId) return messages;
    // Show streaming message if we have partial text OR partial thinking
    const hasStreamingContent = partialMessage || partialThinking;
    if (!hasStreamingContent || !activeTurn?.userMessageId) return messages;
    const anchorIndex = messages.findIndex((message) => message.id === activeTurn.userMessageId);
    if (anchorIndex === -1) return messages;

    let insertIndex = anchorIndex + 1;
    while (insertIndex < messages.length) {
      if (messages[insertIndex].role === 'user') break;
      insertIndex += 1;
    }

    const contentBlocks: ContentBlock[] = [];
    if (partialThinking) {
      contentBlocks.push({ type: 'thinking', thinking: partialThinking });
    }
    if (partialMessage) {
      contentBlocks.push({ type: 'text', text: partialMessage });
    }

    const streamingMessage: Message = {
      id: `partial-${activeSessionId}`,
      sessionId: activeSessionId,
      role: 'assistant',
      content: contentBlocks,
      timestamp: Date.now(),
    };

    return [...messages.slice(0, insertIndex), streamingMessage, ...messages.slice(insertIndex)];
  }, [activeSessionId, activeTurn?.userMessageId, messages, partialMessage, partialThinking]);

  // Format execution time for display
  const formatExecutionTime = useCallback((ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }, []);

  // --- Real-time execution timer ---
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const isActive = Boolean(executionClock?.startAt && executionClock.endAt === null);
    if (!isActive) {
      return;
    }
    setClockNow(Date.now());
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 100);
    return () => clearInterval(interval);
  }, [executionClock?.startAt, executionClock?.endAt]);

  const liveElapsed =
    executionClock?.startAt == null
      ? 0
      : Math.max(0, (executionClock.endAt ?? clockNow) - executionClock.startAt);
  const timerActive = Boolean(executionClock?.startAt && executionClock.endAt === null);

  // Debounced scroll function to prevent scroll conflicts
  const scrollToBottom = useRef((behavior: ScrollBehavior = 'auto', immediate: boolean = false) => {
    // Cancel any pending scroll requests
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    const performScroll = () => {
      if (!isUserAtBottomRef.current) return;

      // Mark as scrolling to prevent concurrent scrolls
      isScrollingRef.current = true;

      messagesEndRef.current?.scrollIntoView({ behavior });

      // Reset scrolling flag after a short delay
      setTimeout(
        () => {
          isScrollingRef.current = false;
        },
        behavior === 'smooth' ? 300 : 50
      );
    };

    if (immediate) {
      performScroll();
    } else {
      // Use RAF + timeout for debouncing
      scrollRequestRef.current = requestAnimationFrame(() => {
        scrollTimeoutRef.current = setTimeout(performScroll, 16); // ~1 frame delay
      });
    }
  }).current;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const updateScrollState = () => {
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserAtBottomRef.current = distanceToBottom <= 80;
    };
    updateScrollState();
    // 用户阅读旧消息时，阻止新消息自动滚动打断视线
    const onScroll = () => updateScrollState();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const messageCount = messages.length;
    const partialLength = partialMessage.length + partialThinking.length;
    const hasNewMessage = messageCount !== prevMessageCountRef.current;
    const isStreamingTick = partialLength !== prevPartialLengthRef.current && !hasNewMessage;

    // Skip scroll if already scrolling (prevent conflicts)
    if (isScrollingRef.current) {
      prevMessageCountRef.current = messageCount;
      prevPartialLengthRef.current = partialLength;
      return;
    }

    if (isUserAtBottomRef.current) {
      if (!isStreamingTick) {
        // New message - use smooth scroll but with debounce
        const behavior: ScrollBehavior = hasNewMessage ? 'smooth' : 'auto';
        scrollToBottom(behavior, false);
      } else {
        // Streaming tick - use instant scroll with debounce
        scrollToBottom('auto', false);
      }
    }

    prevMessageCountRef.current = messageCount;
    prevPartialLengthRef.current = partialLength;
  }, [messages.length, partialMessage.length, partialThinking.length]);

  // Additional scroll trigger for content height changes (e.g., TodoWrite expand/collapse)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const messagesContainer = messagesContainerRef.current;
    if (!container || !messagesContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      // Don't interfere with ongoing scrolls
      if (!isScrollingRef.current && isUserAtBottomRef.current) {
        // Scroll to bottom when content height changes
        scrollToBottom('auto', false);
      }
    });

    resizeObserver.observe(messagesContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, []); // ResizeObserver is stable — no need to recreate on message count changes

  // Cleanup scroll timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (scrollRequestRef.current) {
        cancelAnimationFrame(scrollRequestRef.current);
      }
    };
  }, []);

  // Scroll to bottom when switching sessions so user sees the latest messages
  useEffect(() => {
    if (activeSessionId) {
      isUserAtBottomRef.current = true;
      // Use requestAnimationFrame to ensure DOM has rendered the new messages
      const rafId = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [activeSessionId]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId]);

  // Auto-restore config set when opening an existing session.
  // A monotonic request token is incremented on EVERY effect run so that
  // in-flight IPC calls from prior sessions are always invalidated.
  // Serialization uses a promise chain (not polling) for efficiency.
  // If a stale IPC call mutates main-process config, a corrective switch
  // is issued to restore consistency.
  const lastRestoredSessionRef = useRef<string | null>(null);
  const restoreRequestRef = useRef(0);
  const restoreChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Immediately invalidate any prior in-flight request on every effect run.
    const requestToken = ++restoreRequestRef.current;

    if (!activeSessionId || !activeSession || !isElectron) return;
    if (configSets.length <= 1) return;

    // Only restore once per successful session restore
    if (lastRestoredSessionRef.current === activeSessionId) return;

    // Determine which config set to restore: prefer stored configSetId, fallback to model matching
    let targetConfigSetId: string | undefined = activeSession.configSetId;

    if (!targetConfigSetId && activeSession.model) {
      // Fallback: match by model name for sessions created before configSetId was stored.
      // Only apply when exactly one config set matches to avoid ambiguous selection.
      const matchingSets = configSets.filter((set) => {
        const profile = set.profiles?.[set.activeProfileKey];
        return profile?.model === activeSession.model;
      });
      if (matchingSets.length === 1) {
        targetConfigSetId = matchingSets[0].id;
      }
    }

    if (!targetConfigSetId) {
      // Cannot determine target — do NOT mark as handled so we retry when
      // configSets update (they may load asynchronously after session data).
      return;
    }
    if (targetConfigSetId === activeConfigSetId) {
      // Already on the correct set — mark as definitively restored
      lastRestoredSessionRef.current = activeSessionId;
      return;
    }
    if (!configSets.some((s) => s.id === targetConfigSetId)) {
      // Target config set not found — do NOT mark as handled; configSets may
      // still be loading. Will retry on next configSets update.
      return;
    }

    const capturedSessionId = activeSessionId;
    const capturedTargetId = targetConfigSetId;

    // Chain onto the previous restore promise so switches are serialized
    // without polling. Each link checks staleness before and after IPC.
    restoreChainRef.current = restoreChainRef.current.then(async () => {
      // Pre-IPC staleness check: abort if a newer effect run has fired
      if (restoreRequestRef.current !== requestToken) return;

      try {
        const result = await window.electronAPI!.config.switchSet({ id: capturedTargetId });

        // Post-IPC staleness check
        if (restoreRequestRef.current !== requestToken) {
          // Stale IPC mutated main-process config. Issue a corrective switch
          // to restore the config set that the latest effect run expects.
          // The latest effect will re-run and handle its own restore, but we
          // need main-process state to not be left on the wrong set.
          // Re-read current desired state from the latest active config set.
          const currentActiveSetId = useAppStore.getState().appConfig?.activeConfigSetId;
          if (currentActiveSetId && currentActiveSetId !== capturedTargetId) {
            await window.electronAPI!.config.switchSet({ id: currentActiveSetId });
          }
          return;
        }

        setAppConfig(result.config);
        setIsConfigured(Boolean(result.config?.isConfigured));

        // Mark as definitively restored only after successful application
        lastRestoredSessionRef.current = capturedSessionId;

        const setName = configSets.find((s) => s.id === capturedTargetId)?.name || capturedTargetId;
        setGlobalNotice({
          id: `config-set-restore-${capturedSessionId}`,
          type: 'info',
          message: t('chat.configSetRestored', { name: setName }),
        });
      } catch (error) {
        console.error('[ChatView] Failed to auto-restore config set:', error);
        // Do not mark as restored — will retry on next render cycle
      }
    });
  }, [
    activeSessionId,
    activeSession,
    configSets,
    activeConfigSetId,
    isElectron,
    setAppConfig,
    setIsConfigured,
    setGlobalNotice,
    t,
  ]);

  // Auto-resize textarea based on content, capped at max-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [prompt]);

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      } catch (err) {
        // Notify the user instead of silently dropping the error
        setGlobalNotice({
          id: `image-paste-failed-${Date.now()}`,
          type: 'warning',
          message: t('chat.imageProcessFailed'),
        });
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result is not a string'));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const parts = result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Resize and compress image if needed to stay under 5MB base64 limit
  const resizeImageIfNeeded = async (blob: Blob): Promise<Blob> => {
    // Claude API limit is 5MB for base64 encoded images
    // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
    const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

    if (blob.size <= MAX_BLOB_SIZE) {
      return blob; // No need to resize
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate scaling factor to reduce file size
        // We use a more aggressive approach: scale down until size is acceptable
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Start with a scale factor based on size ratio
        const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
        const quality = 0.9;

        const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
          canvas.width = Math.floor(img.width * currentScale);
          canvas.height = Math.floor(img.height * currentScale);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          return new Promise((resolveBlob) => {
            canvas.toBlob(
              (compressedBlob) => {
                if (!compressedBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                // If still too large, try again with lower quality or scale
                if (
                  compressedBlob.size > MAX_BLOB_SIZE &&
                  (currentQuality > 0.5 || currentScale > 0.3)
                ) {
                  const newQuality = Math.max(0.5, currentQuality - 0.1);
                  const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                  attemptCompress(newScale, newQuality).then(resolveBlob);
                } else {
                  resolveBlob(compressedBlob);
                }
              },
              blob.type || 'image/jpeg',
              currentQuality
            );
          });
        };

        attemptCompress(scale, quality).then(resolve).catch(reject);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[ChatView] Not in Electron, file selection not available');
      return;
    }

    try {
      const filePaths = await window.electronAPI.selectFiles();
      if (filePaths.length === 0) return;

      // Get file info for each selected file
      const newFiles = filePaths.map((filePath) => {
        const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
        return {
          name: fileName,
          path: filePath,
          size: 0, // Will be set by backend when copying
          type: 'application/octet-stream',
        };
      });

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('[ChatView] Error selecting files:', error);
    }
  };

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

    // Process images
    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type,
          });
        } catch (err) {
          // Notify the user instead of silently dropping the error
          setGlobalNotice({
            id: `image-drop-failed-${Date.now()}`,
            type: 'warning',
            message: t('chat.imageProcessFailed'),
          });
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    // Process other files
    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  // Load active MCP connectors
  useEffect(() => {
    if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
      const loadConnectors = async () => {
        try {
          const statuses = await window.electronAPI.mcp.getServerStatus();
          const active =
            (
              statuses as Array<{ id: string; name: string; connected: boolean; toolCount: number }>
            )?.filter((s) => s.connected && s.toolCount > 0) || [];
          setActiveConnectors(active);
        } catch (err) {
          console.error('Failed to load MCP connectors:', err);
        }
      };
      loadConnectors();
      // Refresh every 5 seconds
      const interval = setInterval(loadConnectors, 5000);
      return () => clearInterval(interval);
    }
  }, [isElectron]);

  useEffect(() => {
    const titleEl = titleRef.current;
    const headerEl = headerRef.current;
    const measureEl = connectorMeasureRef.current;
    if (!titleEl || !headerEl || !measureEl) {
      setShowConnectorLabel(true);
      return;
    }
    const updateLabelVisibility = () => {
      const isTruncated = titleEl.scrollWidth > titleEl.clientWidth;
      const headerStyle = window.getComputedStyle(headerEl);
      const paddingLeft = Number.parseFloat(headerStyle.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(headerStyle.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const titleWidth = titleEl.getBoundingClientRect().width;
      const rightColumnWidth = Math.max(0, (contentWidth - titleWidth) / 2);
      const connectorFullWidth = measureEl.getBoundingClientRect().width;
      setShowConnectorLabel(!isTruncated && rightColumnWidth >= connectorFullWidth);
    };
    updateLabelVisibility();
    const observer = new ResizeObserver(() => {
      updateLabelVisibility();
    });
    observer.observe(titleEl);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [activeSession?.title, activeConnectors.length]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() && pastedImages.length === 0 && attachedFiles.length === 0) ||
      !activeSessionId ||
      isSubmitting
    )
      return;

    setIsSubmitting(true);
    try {
      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add images first
      pastedImages.forEach((img) => {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        });
      });

      // Add file attachments
      attachedFiles.forEach((file) => {
        contentBlocks.push({
          type: 'file_attachment',
          filename: file.name,
          relativePath: file.path, // Will be processed by backend to copy to .tmp
          size: file.size,
          mimeType: file.type,
          inlineDataBase64: file.inlineDataBase64,
        });
      });

      // Add text if present
      if (currentPrompt.trim()) {
        contentBlocks.push({
          type: 'text',
          text: currentPrompt.trim(),
        });
      }

      // Send message with content blocks
      await continueSession(activeSessionId, contentBlocks);

      // Clean up
      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.value = '';
        textareaRef.current.style.height = 'auto';
      }
      pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
      setPastedImages([]);
      setAttachedFiles([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      stopSession(activeSessionId);
    }
  };

  const handleExportFull = async () => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI.chat.exportMarkdown({
        sessionId: activeSessionId,
      });
      if (result.success && result.path) {
        setGlobalNotice({
          id: `chat-export-${Date.now()}`,
          type: 'info',
          message: t('chat.exportSuccess'),
        });
      } else if (result.error && result.error !== 'Export cancelled') {
        setGlobalNotice({
          id: `chat-export-error-${Date.now()}`,
          type: 'warning',
          message: t('chat.exportFailed', { error: result.error }),
        });
      }
    } catch (error) {
      console.error('[ChatView] Export failed:', error);
      setGlobalNotice({
        id: `chat-export-error-${Date.now()}`,
        type: 'warning',
        message: t('chat.exportFailed', { error: 'Unexpected error' }),
      });
    }
  };

  const handleExportSelectedWithOptions = async (options: ExportOptions) => {
    if (!activeSessionId) return;
    try {
      // Build messageIds in chat chronological order, filtered by selection and exportability.
      // Note: splitTurnMessages creates synthetic IDs with -answer/-process suffixes.
      // We need to map those back to the original message IDs for the backend.
      const resolveOriginalId = (id: string): string => id.replace(/-(?:answer|process)$/, '');

      const allExportable = displayedMessages.filter(isExportableMessage);
      // Resolve selected IDs to original DB IDs and deduplicate
      const resolvedSelectedIds = new Set(Array.from(exportSelectedIds).map(resolveOriginalId));
      const messageIds = allExportable
        .filter((m) => resolvedSelectedIds.has(resolveOriginalId(m.id)))
        .map((m) => resolveOriginalId(m.id));
      // Deduplicate (a message split into -answer and -process maps to same original)
      const uniqueMessageIds = [...new Set(messageIds)];

      if (uniqueMessageIds.length === 0) {
        setGlobalNotice({
          id: `chat-export-empty-${Date.now()}`,
          type: 'warning',
          message: t('chat.nothingToExport'),
        });
        return;
      }
      const result = await window.electronAPI.chat.exportMarkdown({
        sessionId: activeSessionId,
        messageIds: uniqueMessageIds,
        options,
      });
      if (result.success && result.path) {
        setGlobalNotice({
          id: `chat-export-${Date.now()}`,
          type: 'info',
          message: t('chat.exportSuccess'),
        });
        setIsExportSelectMode(false);
        setExportSelectedIds(new Set());
      } else if (result.error && result.error !== 'Export cancelled') {
        setGlobalNotice({
          id: `chat-export-error-${Date.now()}`,
          type: 'warning',
          message: t('chat.exportFailed', { error: result.error }),
        });
      }
    } catch (error) {
      console.error('[ChatView] Export failed:', error);
      setGlobalNotice({
        id: `chat-export-error-${Date.now()}`,
        type: 'warning',
        message: t('chat.exportFailed', { error: 'Unexpected error' }),
      });
    }
  };

  const handleEnterSelectMode = () => {
    setIsExportSelectMode(true);
    setExportSelectedIds(new Set());
    setShowExportDropdown(false);
  };

  const handleExitSelectMode = () => {
    setIsExportSelectMode(false);
    setExportSelectedIds(new Set());
    setShowExportOptions(false);
  };

  const handleToggleSelectMessage = useCallback((messageId: string) => {
    setExportSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(displayedMessages.filter(isExportableMessage).map((m) => m.id));
    setExportSelectedIds(allIds);
  }, [displayedMessages, isExportableMessage]);

  const handleExportSelected = () => {
    setShowExportOptions(true);
  };

  const handleExportWithOptions = (options: ExportOptions) => {
    setShowExportOptions(false);
    handleExportSelectedWithOptions(options);
  };

  // Keyboard shortcuts for export selection mode
  useEffect(() => {
    if (!isExportSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleExitSelectMode();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        // Don't intercept when focus is in an editable element
        const target = e.target as HTMLElement;
        const tagName = target.tagName.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        handleSelectAll();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExportSelectMode, handleSelectAll]);

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <span>{t('chat.loadingConversation')}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div
        ref={headerRef}
        className="relative h-12 border-b border-border-muted grid grid-cols-[1fr_auto_1fr] items-center px-4 lg:px-8 bg-background/88 backdrop-blur-md"
      >
        <div className="text-[11px] font-medium tracking-[0.08em] uppercase text-text-muted">
          Sqowe Pilot
        </div>
        <div className="flex items-center gap-1.5 justify-center">
          <h2
            ref={titleRef}
            className="text-[15px] font-medium text-text-primary text-center truncate max-w-[40vw] lg:max-w-[32rem]"
          >
            {activeSession.title}
          </h2>
          {displayedMessages.length > 0 && (
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setShowExportDropdown((prev) => !prev)}
                className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                title={t('chat.exportMarkdown')}
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              {showExportDropdown && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowExportDropdown(false)}
                  />
                  <div className="absolute top-full right-0 mt-1 z-50 bg-background border border-border-muted rounded-xl shadow-lg py-1 min-w-[180px] animate-fade-in">
                    <button
                      onClick={() => {
                        setShowExportDropdown(false);
                        handleExportFull();
                      }}
                      className="w-full px-4 py-2 text-left text-[13px] text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      {t('export.fullExport')}
                    </button>
                    <button
                      onClick={handleEnterSelectMode}
                      className="w-full px-4 py-2 text-left text-[13px] text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      {t('export.selectExport')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {activeConnectors.length > 0 && (
          <>
            <div
              ref={connectorMeasureRef}
              aria-hidden="true"
              className="absolute left-0 top-0 -z-10 opacity-0 pointer-events-none"
            >
              <div className="flex items-center gap-2 px-2 py-1 rounded-lg border border-mcp/20">
                <Plug className="w-3.5 h-3.5" />
                <span className="text-xs font-medium whitespace-nowrap">
                  {t('chat.connectorCount', { count: activeConnectors.length })}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-mcp/8 border border-mcp/15 justify-self-end">
              <Plug className="w-3.5 h-3.5 text-mcp" />
              <span className="text-xs text-mcp font-medium">
                {showConnectorLabel
                  ? t('chat.connectorCount', { count: activeConnectors.length })
                  : activeConnectors.length}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div
          ref={messagesContainerRef}
          className="w-full max-w-[920px] mx-auto py-8 px-5 lg:px-8 space-y-5"
        >
          {displayedMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-28 text-text-muted space-y-3 text-center">
              <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted/80">
                Sqowe Pilot
              </p>
              <p className="text-base text-text-secondary">{t('chat.startConversation')}</p>
            </div>
          ) : (
            <GroupedMessages
              messages={displayedMessages}
              hasActiveTurn={hasActiveTurn}
              memoryEnabled={activeSession?.memoryEnabled}
              lastRetrievalTimestamp={lastRetrievalTimestamp}
              selectable={isExportSelectMode}
              selectedIds={exportSelectedIds}
              onToggleSelect={handleToggleSelectMessage}
              isExportable={isExportableMessage}
            />
          )}

          {/* Processing indicator - show when we have an active turn but no streaming content yet */}
          {hasActiveTurn &&
            (!partialMessage || partialMessage.trim() === '') &&
            !partialThinking && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-full bg-background/80 border border-border-subtle max-w-fit">
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
                <span className="text-sm text-text-secondary">{t('chat.processing')}</span>
              </div>
            )}

          {/* Real-time execution timer */}
          {liveElapsed > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-1 ml-0.5">
              <Clock className="w-3 h-3" />
              <span>
                {timerActive
                  ? formatExecutionTime(liveElapsed)
                  : t('messageCard.executionTime', { time: formatExecutionTime(liveElapsed) })}
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Export Selection Bar */}
      {isExportSelectMode && (
        <ExportSelectionBar
          selectedCount={exportSelectedIds.size}
          totalCount={displayedMessages.filter(isExportableMessage).length}
          onSelectAll={handleSelectAll}
          onExport={handleExportSelected}
          onCancel={handleExitSelectMode}
        />
      )}

      {/* Export Options Dialog */}
      {showExportOptions && (
        <ExportOptionsDialog
          messageCount={exportSelectedIds.size || displayedMessages.length}
          onExport={handleExportWithOptions}
          onCancel={() => setShowExportOptions(false)}
        />
      )}

      {/* Input */}
      <div className="border-t border-border-muted bg-background/92 backdrop-blur-md">
        <div className="max-w-[920px] mx-auto px-5 lg:px-8 py-5">
          <form
            onSubmit={handleSubmit}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative w-full"
          >
            {/* Image previews */}
            {pastedImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
                {pastedImages.map((img, index) => (
                  <div key={img.url || `pasted-image-${index}`} className="relative group">
                    <img
                      src={img.url}
                      alt={t('common.pastedImageAlt', { index: index + 1 })}
                      className="w-full aspect-square object-cover rounded-lg border border-border block"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* File attachments */}
            {attachedFiles.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachedFiles.map((file, index) => (
                  <div
                    key={file.path || `attached-file-${index}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{file.name}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className={`flex items-end gap-2 p-3.5 rounded-[1.75rem] bg-background/88 border border-border-muted shadow-soft transition-colors ${
                isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
              }`}
            >
              <button
                type="button"
                onClick={handleFileSelect}
                className="w-9 h-9 rounded-2xl flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                title={t('welcome.attachFiles')}
              >
                <Plus className="w-5 h-5" />
              </button>

              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  // Enter to send, Shift+Enter for new line
                  if (e.key === 'Enter' && !e.shiftKey) {
                    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
                      return;
                    }
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={t('chat.typeMessage')}
                disabled={isSubmitting}
                rows={1}
                className="flex-1 resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[15px] py-2 min-h-[40px] max-h-[200px] overflow-y-auto leading-6"
              />

              <div className="flex items-center gap-2">
                {/* Config Set Selector */}
                {configSets.length > 1 ? (
                  <div className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border-subtle bg-background/60 text-xs text-text-muted">
                    <Layers className="w-3 h-3 shrink-0" />
                    <select
                      value={activeConfigSetId}
                      onChange={(e) => {
                        void handleConfigSetSwitch(e.target.value);
                      }}
                      disabled={isSwitchingSet}
                      className="bg-transparent border-none outline-none text-xs text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed max-w-[120px] truncate"
                    >
                      {configSets.map((set) => (
                        <option key={set.id} value={set.id}>
                          {set.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <span className="hidden sm:inline-flex px-2.5 py-1 rounded-full border border-border-subtle bg-background/60 text-xs text-text-muted">
                    {appConfig?.model || t('chat.noModel')}
                  </span>
                )}

                {canStop && (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center bg-error/10 text-error hover:bg-error/20 transition-colors"
                    title={t('chat.stop')}
                  >
                    <Square className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={
                    (!prompt.trim() &&
                      !textareaRef.current?.value.trim() &&
                      pastedImages.length === 0 &&
                      attachedFiles.length === 0) ||
                    isSubmitting
                  }
                  className="w-9 h-9 rounded-2xl flex items-center justify-center bg-accent text-background disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover transition-colors"
                  title={t('chat.sendMessage')}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-[11px] text-text-muted/60 text-center mt-2.5">
              {t('chat.disclaimer')}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
