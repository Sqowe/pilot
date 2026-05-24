import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import type { ContentBlock, MCPServerInfo, Skill } from '../types';
import { getInitialSessionTitle } from '../../shared/session-title';
import { MAX_PINNED_SKILLS_PER_SESSION } from '../../shared/skill-pinning-constants';
import { ArrowRight, X, Paperclip, Layers, Plug, ChevronDown, ChevronUp, Star } from 'lucide-react';
import { WorkspacePicker } from './WorkspacePicker';
import { deriveDisabledServerIds } from '../utils/mcp-profile-derive';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

import welcomeLogoSrc from '../assets/logo.png';

export function WelcomeView() {
  const { t } = useTranslation();
  const welcomeDraft = useAppStore((state) => state.welcomeDraft);
  const setWelcomeDraft = useAppStore((state) => state.setWelcomeDraft);
  const [prompt, setPromptLocal] = useState(welcomeDraft);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isComposingRef = useRef(false);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { startSession, changeWorkingDir, setWorkingDirDirect, getMCPServers, isElectron } =
    useIPC();
  const workingDir = useAppStore((state) => state.workingDir);
  const setGlobalNotice = useAppStore((state) => state.setGlobalNotice);
  const isConfigured = useAppStore((state) => state.isConfigured);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);

  // MCP server selection state
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [mcpServersLoaded, setMcpServersLoaded] = useState(false);
  const [mcpServersLoadFailed, setMcpServersLoadFailed] = useState(false);
  const [mcpDisabledIds, setMcpDisabledIds] = useState<Set<string>>(new Set());
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [mcpProfilePending, setMcpProfilePending] = useState(false);

  // Skill pinning state
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [pinnedSkillIds, setPinnedSkillIds] = useState<Set<string>>(new Set());
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  // Sync local prompt to store on every change (persists across navigation)
  const setPrompt = (value: string) => {
    setPromptLocal(value);
    setWelcomeDraft(value);
  };

  const canSubmit =
    (prompt.trim().length > 0 || pastedImages.length > 0 || attachedFiles.length > 0) &&
    !mcpProfilePending;

  // Config set selection
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const setIsConfiguredStore = useAppStore((state) => state.setIsConfigured);
  const configSets = appConfig?.configSets ?? [];
  const activeConfigSetId = appConfig?.activeConfigSetId ?? '';
  const [isSwitchingSet, setIsSwitchingSet] = useState(false);
  const switchRequestRef = useRef(0);

  const handleConfigSetSwitch = async (setId: string) => {
    if (!isElectron || !window.electronAPI || setId === activeConfigSetId || isSwitchingSet) return;
    const requestId = ++switchRequestRef.current;
    setIsSwitchingSet(true);
    try {
      const result = await window.electronAPI.config.switchSet({ id: setId });
      // Only apply if this is still the latest request (guards against rapid switching)
      if (switchRequestRef.current === requestId) {
        setAppConfig(result.config);
        setIsConfiguredStore(Boolean(result.config?.isConfigured));
      }
    } catch (error) {
      console.error('[WelcomeView] Failed to switch config set:', error);
    } finally {
      if (switchRequestRef.current === requestId) {
        setIsSwitchingSet(false);
      }
    }
  };

  const handleSelectFolder = async () => {
    try {
      const result = await changeWorkingDir(undefined, workingDir || undefined);
      if (!result.success && result.error && result.error !== 'User cancelled') {
        setGlobalNotice({
          id: `notice-workdir-select-${Date.now()}`,
          type: 'warning',
          message: `${t('welcome.selectWorkingFolderFailed')}: ${result.error}`,
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-workdir-select-${Date.now()}`,
        type: 'error',
        message:
          error instanceof Error && error.message
            ? `${t('welcome.selectWorkingFolderFailed')}: ${error.message}`
            : t('welcome.selectWorkingFolderFailed'),
      });
    }
  };

  // Load MCP servers on mount
  useEffect(() => {
    const loadServers = async () => {
      try {
        const servers = await getMCPServers();
        setMcpServers(servers || []);
        setMcpServersLoadFailed(false);
      } catch (error) {
        console.error('[WelcomeView] Failed to load MCP servers:', error);
        setMcpServersLoadFailed(true);
      } finally {
        setMcpServersLoaded(true);
      }
    };
    loadServers();
  }, [getMCPServers]);

  // Raw workspace profile — fetched only when workingDir changes
  const [workspaceProfile, setWorkspaceProfile] = useState<{
    disabled?: string[];
    enabled?: string[];
  } | null>(null);
  // Track whether user has manually toggled servers (overrides profile derivation)
  const [userToggledMcp, setUserToggledMcp] = useState(false);

  // Load workspace MCP profile when workingDir changes (fetch only, no derivation)
  useEffect(() => {
    if (!isElectron || !workingDir) {
      setWorkspaceProfile(null);
      setUserToggledMcp(false);
      setMcpDisabledIds(new Set());
      return;
    }
    let cancelled = false;
    // Immediately clear stale state from previous workspace before async fetch
    setWorkspaceProfile(null);
    setUserToggledMcp(false);
    setMcpDisabledIds(new Set());
    const loadProfile = async () => {
      try {
        const profile = await window.electronAPI?.mcp?.getWorkspaceProfile(workingDir);
        if (cancelled) return;
        setWorkspaceProfile(profile || null);
      } catch (error) {
        if (!cancelled) {
          console.error('[WelcomeView] Failed to load workspace MCP profile:', error);
          setWorkspaceProfile(null);
        }
      }
    };
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [workingDir, isElectron]);

  // Derive disabled IDs from profile + server list (no IPC, no re-fetch).
  // Only applies when user hasn't manually toggled servers this session.
  // `mcpProfilePending` tracks whether derivation is incomplete (allowlist waiting for servers).

  useEffect(() => {
    if (userToggledMcp) {
      setMcpProfilePending(false);
      return; // User overrode — don't reset
    }

    if (!workspaceProfile) {
      setMcpDisabledIds(new Set());
      setMcpProfilePending(false);
      return;
    }

    const derived = deriveDisabledServerIds(workspaceProfile, mcpServers);
    if (derived === null) {
      // Allowlist mode but servers not loaded yet.
      if (mcpServersLoaded) {
        if (mcpServersLoadFailed) {
          // Server load failed — keep pending (fail-safe: don't enable everything)
          setMcpProfilePending(true);
        } else {
          // Loaded successfully with zero servers — nothing to disable, unblock
          setMcpDisabledIds(new Set());
          setMcpProfilePending(false);
        }
      } else {
        setMcpProfilePending(true);
      }
      return;
    }

    setMcpDisabledIds(derived);
    setMcpProfilePending(false);
  }, [workspaceProfile, mcpServers, mcpServersLoaded, mcpServersLoadFailed, userToggledMcp]);

  // Load available skills on mount
  useEffect(() => {
    const loadSkills = async () => {
      try {
        const skills = await window.electronAPI?.skills?.getAll();
        setAvailableSkills((skills || []).filter((s) => s.enabled));
      } catch (error) {
        console.error('[WelcomeView] Failed to load skills:', error);
      }
    };
    loadSkills();
  }, []);

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
          mediaType: resizedBlob.type,
        });
      } catch (err) {
        console.error('Failed to process pasted image:', err);
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
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
      console.log('[WelcomeView] Not in Electron, file selection not available');
      return;
    }

    try {
      const filePaths = await window.electronAPI.selectFiles();
      if (filePaths.length === 0) return;

      const newFiles = filePaths.map((filePath) => {
        const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
        return {
          name: fileName,
          path: filePath,
          size: 0,
          type: 'application/octet-stream',
        };
      });

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('[WelcomeView] Error selecting files:', error);
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
          console.error('Failed to process dropped image:', err);
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

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

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() && pastedImages.length === 0 && attachedFiles.length === 0) ||
      isSubmitting
    )
      return;

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
        relativePath: file.path,
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

    // Use the global working directory (always available after app startup)
    setIsSubmitting(true);
    try {
      const sessionTitle = getInitialSessionTitle(currentPrompt, attachedFiles[0]?.name);
      const session = await startSession(
        sessionTitle,
        contentBlocks,
        workingDir || undefined,
        mcpDisabledIds.size > 0 ? Array.from(mcpDisabledIds) : undefined,
        pinnedSkillIds.size > 0 ? Array.from(pinnedSkillIds) : undefined
      );
      if (session) {
        setPrompt('');
        if (textareaRef.current) {
          textareaRef.current.value = '';
        }
        pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
        setPastedImages([]);
        setAttachedFiles([]);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auto-adjust textarea height based on content
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set max height to 200px (about 8 lines), then scroll
      const maxHeight = 200;
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      // Show scrollbar if content exceeds max height
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  };

  // Adjust height when prompt changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [prompt]);

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto px-5 py-10 md:px-8 md:py-14">
      <div className="max-w-[840px] w-full space-y-7 animate-fade-in my-auto">
        <div className="space-y-4 text-center">
          <div className="flex items-center justify-center gap-4">
            <img
              src={welcomeLogoSrc}
              alt={t('welcome.logoAlt')}
              className="w-16 h-16 md:w-20 md:h-20 rounded-[1.4rem] object-cover border border-border-subtle bg-background/60 shadow-soft"
            />
            <div className="text-left">
              <h1 className="text-[2.35rem] md:text-[3.1rem] leading-none font-semibold tracking-[-0.05em] text-text-primary">
                Sqowe Pilot
              </h1>
            </div>
          </div>
          <p className="heading-serif text-[1.15rem] md:text-[1.45rem] font-medium tracking-[-0.02em] text-text-secondary text-center">
            {t('welcome.title')}
          </p>
        </div>

        {/* API Not Configured Hint */}
        {!isConfigured && (
          <p className="text-sm text-text-muted text-center">
            {t('welcome.apiNotConfigured')}{' '}
            <button
              type="button"
              onClick={() => {
                setSettingsTab('api');
                setShowSettings(true);
              }}
              className="inline-flex items-center gap-1 text-accent hover:text-accent-hover transition-colors"
            >
              {t('welcome.goToSettings')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </p>
        )}

        {/* Main Input Card - Right aligned */}
        <form
          onSubmit={handleSubmit}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-[1.9rem] border border-border-muted bg-background/85 shadow-soft px-5 py-5 space-y-4 transition-colors ${
            isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
          }`}
        >
          {/* Image previews */}
          {pastedImages.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 pb-2 border-b border-border w-full">
              {pastedImages.map((img, index) => (
                <div key={index} className="relative group">
                  <img
                    src={img.url}
                    alt={t('welcome.pastedImageAlt', { index: index + 1 })}
                    className="w-full aspect-square object-cover rounded-lg border border-border"
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
                  key={index}
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

          {/* Text Input - Auto-resizing */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              adjustTextareaHeight();
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={handlePaste}
            placeholder={t('welcome.placeholder')}
            rows={1}
            style={{ minHeight: '72px', maxHeight: '200px' }}
            className="w-full resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-base leading-relaxed overflow-hidden"
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
          />

          {/* Bottom Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-border-muted">
            <div className="flex items-center gap-3">
              <WorkspacePicker
                currentPath={workingDir}
                onSelectPath={async (path) => {
                  try {
                    const result = await setWorkingDirDirect(path);
                    if (!result.success && result.error) {
                      setGlobalNotice({
                        id: `notice-workdir-set-${Date.now()}`,
                        type: 'warning',
                        message: `${t('welcome.selectWorkingFolderFailed')}: ${result.error}`,
                      });
                    }
                  } catch (error) {
                    setGlobalNotice({
                      id: `notice-workdir-set-${Date.now()}`,
                      type: 'error',
                      message:
                        error instanceof Error && error.message
                          ? `${t('welcome.selectWorkingFolderFailed')}: ${error.message}`
                          : t('welcome.selectWorkingFolderFailed'),
                    });
                  }
                }}
                onBrowse={handleSelectFolder}
              />

              {isElectron && (
                <button
                  type="button"
                  onClick={handleFileSelect}
                  className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  <Paperclip className="w-4 h-4" />
                  <span>{t('welcome.attachFiles')}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Config Set Selector — only shown when multiple sets exist */}
              {configSets.length > 1 && (
                <div className="flex items-center gap-1.5 text-sm text-text-secondary">
                  <Layers className="w-4 h-4 text-text-muted shrink-0" />
                  <select
                    value={activeConfigSetId}
                    onChange={(e) => {
                      void handleConfigSetSwitch(e.target.value);
                    }}
                    disabled={isSwitchingSet}
                    className="bg-transparent border-none outline-none text-sm text-text-secondary hover:text-text-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed max-w-[140px] truncate"
                    title={t('welcome.configSet')}
                  >
                    {configSets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit || isSubmitting}
                className="btn btn-primary px-5 py-2.5 rounded-2xl disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>{isSubmitting ? t('welcome.starting') : t('welcome.letsGo')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>

        {/* MCP Server Picker */}
        {mcpServers.length > 0 && (
          <div className="space-y-2">
            {/* Collapsed summary line */}
            <button
              type="button"
              onClick={() => setMcpExpanded(!mcpExpanded)}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-border-muted bg-background/60 hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Plug className="w-4 h-4 text-mcp" />
                <span>
                  {mcpServers.length}/{mcpServers.filter((s) => s.connected).length}/
                  {mcpServers.filter((s) => s.connected && !mcpDisabledIds.has(s.id)).length}{' '}
                  {t('welcome.mcpServersActive')}
                </span>
                {mcpDisabledIds.size > 0 && (
                  <span className="text-xs text-text-muted">
                    · {t('welcome.mcpTokensSaved', { count: mcpDisabledIds.size })}
                  </span>
                )}
              </div>
              {mcpExpanded ? (
                <ChevronUp className="w-4 h-4 text-text-muted" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-muted" />
              )}
            </button>

            {/* Expanded grid */}
            {mcpExpanded && (
              <div className="rounded-xl border border-border-muted bg-background/60 px-4 py-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                    {t('welcome.mcpServersForChat')}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setUserToggledMcp(true);
                        setMcpDisabledIds(new Set());
                      }}
                      className="text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      {t('welcome.mcpAllOn')}
                    </button>
                    <span className="text-text-muted">·</span>
                    <button
                      type="button"
                      onClick={() => {
                        setUserToggledMcp(true);
                        setMcpDisabledIds(new Set(mcpServers.map((s) => s.id)));
                      }}
                      className="text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      {t('welcome.mcpAllOff')}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {mcpServers.map((server) => {
                    const isDisabled = mcpDisabledIds.has(server.id);
                    return (
                      <button
                        key={server.id}
                        type="button"
                        onClick={() => {
                          setUserToggledMcp(true);
                          setMcpDisabledIds((prev) => {
                            const next = new Set(prev);
                            if (prev.has(server.id)) {
                              next.delete(server.id);
                            } else {
                              next.add(server.id);
                            }
                            return next;
                          });
                        }}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors text-left ${
                          isDisabled
                            ? 'border-border-muted bg-surface-muted opacity-50'
                            : 'border-mcp/30 bg-mcp/5 hover:bg-mcp/10'
                        }`}
                      >
                        <div
                          className={`w-5 h-3 rounded-full relative shrink-0 transition-colors ${
                            isDisabled ? 'bg-border' : 'bg-mcp'
                          }`}
                        >
                          <div
                            className={`absolute top-0.5 w-2 h-2 rounded-full bg-white shadow transition-transform ${
                              isDisabled ? 'left-0.5' : 'translate-x-2.5'
                            }`}
                          />
                        </div>
                        <span
                          className={`text-sm flex-1 truncate ${
                            isDisabled ? 'text-text-muted line-through' : 'text-text-primary'
                          }`}
                        >
                          {server.name}
                        </span>
                        <span className="text-xs text-text-muted shrink-0">{server.toolCount}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Skill Pinning Picker */}
        {availableSkills.length > 0 && (
          <div className="space-y-2">
            {/* Collapsed summary line */}
            <button
              type="button"
              onClick={() => setSkillsExpanded(!skillsExpanded)}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-border-muted bg-background/60 hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Star className="w-4 h-4 text-amber-500" />
                <span>
                  {pinnedSkillIds.size > 0
                    ? `${pinnedSkillIds.size}/${MAX_PINNED_SKILLS_PER_SESSION} ${t('welcome.skillsPinned', { count: pinnedSkillIds.size })}`
                    : t('welcome.skillsForChat')}
                </span>
              </div>
              {skillsExpanded ? (
                <ChevronUp className="w-4 h-4 text-text-muted" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-muted" />
              )}
            </button>

            {/* Expanded grid */}
            {skillsExpanded && (
              <div className="rounded-xl border border-border-muted bg-background/60 px-4 py-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                    {t('welcome.skillsForChat')}
                  </span>
                  {pinnedSkillIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setPinnedSkillIds(new Set())}
                      className="text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      {t('welcome.skillsClearAll')}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {availableSkills.map((skill) => {
                    const isPinned = pinnedSkillIds.has(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => {
                          setPinnedSkillIds((prev) => {
                            const next = new Set(prev);
                            if (prev.has(skill.id)) {
                              next.delete(skill.id);
                            } else {
                              // Enforce client-side limit
                              if (next.size >= MAX_PINNED_SKILLS_PER_SESSION) return prev;
                              next.add(skill.id);
                            }
                            return next;
                          });
                        }}
                        disabled={!isPinned && pinnedSkillIds.size >= MAX_PINNED_SKILLS_PER_SESSION}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors text-left ${
                          isPinned
                            ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
                            : pinnedSkillIds.size >= MAX_PINNED_SKILLS_PER_SESSION
                              ? 'border-border-muted bg-surface-muted opacity-40 cursor-not-allowed'
                              : 'border-border-muted bg-surface-muted hover:bg-surface-hover'
                        }`}
                      >
                        <Star
                          className={`w-4 h-4 shrink-0 transition-colors ${
                            isPinned ? 'text-amber-500 fill-amber-500' : 'text-text-muted'
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <span
                            className={`text-sm truncate block ${
                              isPinned ? 'text-text-primary' : 'text-text-muted'
                            }`}
                          >
                            {skill.name}
                          </span>
                          {skill.description && (
                            <span className="text-xs text-text-muted truncate block">
                              {skill.description}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
