import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plug,
  AlertCircle,
  CheckCircle,
  Edit3,
  Trash2,
  Plus,
  Power,
  PowerOff,
  Loader2,
  ChevronRight,
  ChevronDown,
  X,
} from 'lucide-react';
import type { MCPServerConfig, MCPServerStatus, MCPToolInfo, MCPPreset } from './shared';
import { McpToolPermissions } from './McpToolPermissions';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsConnectors({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [statuses, setStatuses] = useState<MCPServerStatus[]>([]);
  const [tools, setTools] = useState<MCPToolInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [presets, setPresets] = useState<Record<string, MCPPreset>>({});
  const [showPresets, setShowPresets] = useState(true);
  const [configuringPreset, setConfiguringPreset] = useState<{
    key: string;
    preset: MCPPreset;
  } | null>(null);
  const [presetEnvValues, setPresetEnvValues] = useState<Record<string, string>>({});

  // Auto-refresh
  const loadPresets = useCallback(async () => {
    try {
      const loaded = (await window.electronAPI.mcp.getPresets()) as Record<string, MCPPreset>;
      setPresets(loaded || {});
    } catch (err) {
      console.error('Failed to load presets:', err);
    }
  }, []);

  const loadServers = useCallback(async () => {
    try {
      const loaded = (await window.electronAPI.mcp.getServers()) as MCPServerConfig[];
      setServers(loaded || []);
      setError('');
    } catch (err) {
      console.error('Failed to load servers:', err);
      setError(tRef.current('mcp.loadServersFailed'));
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    try {
      const loaded = (await window.electronAPI.mcp.getServerStatus()) as MCPServerStatus[];
      setStatuses(loaded || []);
    } catch (err) {
      console.error('Failed to load statuses:', err);
    }
  }, []);

  const loadTools = useCallback(async () => {
    try {
      const loaded = (await window.electronAPI.mcp.getTools()) as MCPToolInfo[];
      setTools(loaded || []);
    } catch (err) {
      console.error('Failed to load tools:', err);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadServers(), loadStatuses(), loadTools(), loadPresets()]);
  }, [loadPresets, loadServers, loadStatuses, loadTools]);

  useEffect(() => {
    if (!isElectron || !isActive) {
      return;
    }
    void loadAll();
    const interval = setInterval(() => {
      void loadTools();
      void loadStatuses();
    }, 3000);
    return () => clearInterval(interval);
  }, [isActive, loadAll, loadStatuses, loadTools]);

  async function handleAddPreset(presetKey: string) {
    const preset = presets[presetKey];
    if (!preset) return;

    const existing = servers.find((s) => s.name === preset.name && s.command === preset.command);
    if (existing) {
      setError(t('mcp.presetAlreadyConfigured', { name: preset.name }));
      return;
    }

    // Check if preset requires environment variables
    if (preset.requiresEnv && preset.requiresEnv.length > 0) {
      // Initialize env values from preset defaults
      const initialEnv: Record<string, string> = {};
      preset.requiresEnv.forEach((key: string) => {
        initialEnv[key] = preset.env?.[key] || '';
      });
      setPresetEnvValues(initialEnv);
      setConfiguringPreset({ key: presetKey, preset });
      return;
    }

    // No env required, add directly
    await addPresetServer(presetKey, preset, {});
  }

  async function addPresetServer(
    presetKey: string,
    preset: MCPPreset,
    envOverrides: Record<string, string>
  ) {
    const serverConfig: MCPServerConfig = {
      id: `mcp-${presetKey}-${Date.now()}`,
      name: preset.name,
      type: preset.type,
      // STDIO fields
      command: preset.command,
      args: preset.args,
      env: { ...preset.env, ...envOverrides },
      // SSE fields
      url: preset.url,
      headers: preset.headers,
      enabled: false,
    };

    await handleSaveServer(serverConfig);
    setShowPresets(false);
    setConfiguringPreset(null);
    setPresetEnvValues({});
  }

  async function handleSaveServer(server: MCPServerConfig) {
    setIsLoading(true);
    setError('');
    try {
      const result = await window.electronAPI.mcp.saveServer(server);
      if (result && !result.success && result.error) {
        setError(result.error);
        // Keep form open so the user can see and act on the error
        return;
      }
      await loadAll();
      setEditingServer(null);
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcp.saveServerFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteServer(serverId: string) {
    if (!confirm(t('mcp.deleteConnectorConfirm'))) return;
    setIsLoading(true);
    try {
      await window.electronAPI.mcp.deleteServer(serverId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcp.deleteServerFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleToggleEnabled(server: MCPServerConfig) {
    await handleSaveServer({ ...server, enabled: !server.enabled });
  }

  async function handleRegenerateDescription(serverId: string) {
    if (!isElectron || !window.electronAPI?.mcp?.regenerateDescription) {
      throw new Error('API not available');
    }
    const result = await window.electronAPI.mcp.regenerateDescription(serverId);
    if (result.success) {
      const updatedServers = await window.electronAPI.mcp.getServers();
      setServers(updatedServers);
    } else {
      throw new Error(result.error || 'Regeneration failed');
    }
  }

  function getServerStatus(serverId: string) {
    return statuses.find((s) => s.id === serverId);
  }

  function getServerTools(serverId: string) {
    return tools.filter((t) => t.serverId === serverId);
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Add/Edit Form */}
      {(showAddForm || editingServer) && (
        <ServerForm
          server={editingServer || undefined}
          onSave={handleSaveServer}
          onCancel={() => {
            setShowAddForm(false);
            setEditingServer(null);
          }}
          isLoading={isLoading}
        />
      )}

      {/* Server List */}
      {!showAddForm && !editingServer && (
        <div className="space-y-3">
          {servers.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-background text-center py-8 text-text-muted">
              <Plug className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>{t('mcp.noConnectors')}</p>
              <p className="text-sm mt-1">{t('mcp.addConnector')}</p>
            </div>
          ) : (
            servers.map((server) => {
              const status = getServerStatus(server.id);
              const serverTools = getServerTools(server.id);

              return (
                <ServerCard
                  key={server.id}
                  server={server}
                  status={status}
                  toolCount={serverTools.length}
                  tools={serverTools}
                  onEdit={() => setEditingServer(server)}
                  onDelete={() => handleDeleteServer(server.id)}
                  onToggleEnabled={() => handleToggleEnabled(server)}
                  onRegenerateDescription={() => handleRegenerateDescription(server.id)}
                  onUpdateToolPolicy={(policy) => {
                    void handleSaveServer({ ...server, defaultToolPolicy: policy });
                  }}
                  onUpdateToolPermission={(toolShortName, action) => {
                    const current = { ...(server.toolPermissions || {}) };
                    if (action === undefined) {
                      delete current[toolShortName];
                    } else {
                      current[toolShortName] = action;
                    }
                    void handleSaveServer({
                      ...server,
                      toolPermissions: Object.keys(current).length > 0 ? current : undefined,
                    });
                  }}
                  isLoading={isLoading}
                />
              );
            })
          )}
        </div>
      )}

      {/* Preset Environment Configuration Modal */}
      {configuringPreset && (
        <div className="p-4 rounded-lg border border-accent/30 bg-accent/5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary">
              {t('mcp.configure')} {configuringPreset.preset.name}
            </h3>
            <button
              onClick={() => {
                setConfiguringPreset(null);
                setPresetEnvValues({});
              }}
              className="text-text-muted hover:text-text-primary"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-text-muted">
            This connector requires configuration before it can be added.
          </p>
          <div className="space-y-3">
            {configuringPreset.preset.requiresEnv?.map((envKey: string) => (
              <div key={envKey}>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {configuringPreset.preset.envDescription?.[envKey] || envKey}
                </label>
                <input
                  type="password"
                  value={presetEnvValues[envKey] || ''}
                  onChange={(e) =>
                    setPresetEnvValues((prev) => ({ ...prev, [envKey]: e.target.value }))
                  }
                  placeholder={`Enter ${envKey}`}
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setConfiguringPreset(null);
                setPresetEnvValues({});
              }}
              className="px-3 py-1.5 rounded-md text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() =>
                void addPresetServer(
                  configuringPreset.key,
                  configuringPreset.preset,
                  presetEnvValues
                )
              }
              disabled={
                isLoading ||
                configuringPreset.preset.requiresEnv?.some(
                  (key: string) => !presetEnvValues[key]?.trim()
                )
              }
              className="px-4 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {t('common.add')}
            </button>
          </div>
        </div>
      )}

      {/* Preset Servers */}
      {!showAddForm && !editingServer && !configuringPreset && Object.keys(presets).length > 0 && (
        <div className="space-y-3">
          <button
            onClick={() => setShowPresets(!showPresets)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-surface-muted hover:bg-surface transition-colors"
          >
            <h3 className="text-sm font-medium text-text-primary">{t('mcp.quickAddPresets')}</h3>
            <div className="flex items-center gap-1.5 text-text-muted">
              <span className="text-xs">{showPresets ? t('mcp.hide') : t('mcp.show')}</span>
              <ChevronDown
                className={`w-4 h-4 transition-transform ${showPresets ? 'rotate-180' : ''}`}
              />
            </div>
          </button>
          {showPresets && (
            <div className="grid grid-cols-1 gap-2">
              {Object.entries(presets).map(([key, preset]) => {
                const isAdded = servers.some(
                  (s) => s.name === preset.name && s.command === preset.command
                );
                const requiresConfig = preset.requiresEnv && preset.requiresEnv.length > 0;
                return (
                  <div
                    key={key}
                    className={`p-3 rounded-lg border flex items-center gap-3 ${
                      isAdded
                        ? 'border-border bg-surface-muted opacity-60'
                        : 'border-border bg-surface'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-text-primary">{preset.name}</span>
                        {requiresConfig && !isAdded && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/10 text-warning border border-warning/20">
                            {t('mcp.requiresToken')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5 truncate">
                        {preset.type === 'stdio'
                          ? `${preset.command} ${preset.args?.join(' ') || ''}`
                          : preset.url || 'Remote server'}
                      </div>
                    </div>
                    {isAdded ? (
                      <div className="flex items-center gap-1 text-success text-xs whitespace-nowrap">
                        <CheckCircle className="w-4 h-4" />
                        <span>{t('mcp.added')}</span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleAddPreset(key)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 whitespace-nowrap flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {requiresConfig ? t('mcp.configure') : t('common.add')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add Custom Button */}
      {!showAddForm && !editingServer && (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full py-3 px-4 rounded-lg border-2 border-dashed border-border hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent"
        >
          <Plus className="w-5 h-5" />
          {t('mcp.addCustomConnector')}
        </button>
      )}

      {/* Footer info */}
      <div className="text-sm text-text-muted text-center pt-2">
        {t('mcp.toolsAvailable', { count: tools.length })}
      </div>
    </div>
  );
}

function ServerCard({
  server,
  status,
  toolCount,
  tools,
  onEdit,
  onDelete,
  onToggleEnabled,
  onRegenerateDescription,
  onUpdateToolPolicy,
  onUpdateToolPermission,
  isLoading,
}: {
  server: MCPServerConfig;
  status?: MCPServerStatus;
  toolCount: number;
  tools: MCPToolInfo[];
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onRegenerateDescription: () => void;
  onUpdateToolPolicy: (policy: 'allow-all' | 'allow-reads' | 'ask-all' | 'deny-all') => void;
  onUpdateToolPermission: (
    toolShortName: string,
    action: 'allow' | 'ask' | 'deny' | undefined
  ) => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  // Fall back to 'connecting' for enabled servers when status poll hasn't returned yet
  const serverStatus = status?.status ?? (server.enabled ? 'connecting' : 'disabled');
  const [showTools, setShowTools] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const handleRegenerate = async () => {
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
      await onRegenerateDescription();
    } catch (err) {
      setRegenerateError(
        err instanceof Error
          ? err.message
          : t('mcp.regenerateFailed', { defaultValue: 'Failed to regenerate' })
      );
    } finally {
      setIsRegenerating(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <div
                className={`w-3 h-3 rounded-full ${
                  serverStatus === 'connected'
                    ? 'bg-success'
                    : serverStatus === 'failed'
                      ? 'bg-error'
                      : serverStatus === 'connecting'
                        ? 'bg-warning'
                        : 'bg-text-muted'
                }`}
              />
              <h3 className="font-medium text-text-primary">{server.name}</h3>
              <span className="px-2 py-0.5 text-xs rounded bg-surface-muted text-text-muted">
                {server.type.toUpperCase()}
              </span>
            </div>
            <div className="text-sm text-text-muted space-y-1 ml-6 min-w-0">
              {/* Description */}
              {server.description && (
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-text-secondary italic">{server.description}</span>
                  {server.descriptionSource && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-surface-muted text-text-muted"
                      title={
                        server.descriptionSource === 'manual'
                          ? t('mcp.descriptionManual', { defaultValue: 'Manually written' })
                          : t('mcp.descriptionAuto', { defaultValue: 'Auto-generated from tools' })
                      }
                    >
                      {server.descriptionSource === 'manual' ? '✍️' : '✨'}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    disabled={isRegenerating || !server.enabled || serverStatus !== 'connected'}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-surface-muted text-text-muted hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
                    title={t('mcp.regenerateDescription', {
                      defaultValue: 'Regenerate description',
                    })}
                  >
                    {isRegenerating ? '⏳' : '🔄'}
                  </button>
                </div>
              )}
              {!server.description && server.enabled && serverStatus === 'connected' && (
                <button
                  type="button"
                  onClick={handleRegenerate}
                  disabled={isRegenerating}
                  className="text-xs text-accent hover:text-accent-hover mb-1 flex items-center gap-1"
                >
                  {isRegenerating ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('mcp.generating', { defaultValue: 'Generating...' })}
                    </>
                  ) : (
                    t('mcp.generateDescription', { defaultValue: '+ Generate description' })
                  )}
                </button>
              )}
              {regenerateError && (
                <div className="text-[10px] text-warning mb-1">⚠️ {regenerateError}</div>
              )}
              {server.type === 'stdio' && (
                <div
                  className="font-mono text-xs truncate"
                  title={`${server.command} ${server.args?.join(' ') || ''}`}
                >
                  {server.command} {server.args?.join(' ') || ''}
                </div>
              )}
              {server.type === 'sse' && (
                <div className="font-mono text-xs truncate" title={server.url}>
                  {server.url}
                </div>
              )}
              {server.type === 'streamable-http' && (
                <div className="font-mono text-xs truncate" title={server.url}>
                  {server.url}
                </div>
              )}
              {/* Status hint — consistent for all servers */}
              <div
                className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md w-fit ${
                  serverStatus === 'connected'
                    ? 'bg-success/10 text-success'
                    : serverStatus === 'failed'
                      ? 'bg-error/10 text-error'
                      : serverStatus === 'connecting'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-accent/10 text-accent'
                }`}
              >
                {serverStatus === 'connected'
                  ? `✓ ${t('mcp.connected')}`
                  : serverStatus === 'failed'
                    ? t('mcp.failed', { defaultValue: 'Connection failed' })
                    : serverStatus === 'connecting'
                      ? `⏳ ${t('mcp.connecting')}`
                      : t('mcp.disabled', { defaultValue: 'Disabled' })}
              </div>
              <div className="flex items-center gap-4 mt-2">
                <button
                  onClick={() => setShowTools(!showTools)}
                  className="flex items-center gap-1 hover:text-accent transition-colors"
                >
                  <Plug className="w-3 h-3" />
                  <span>{t('mcp.toolsAvailable', { count: toolCount })}</span>
                  {showTools ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </button>
              </div>

              {/* Tools List */}
              {showTools && tools.length > 0 && (
                <div className="mt-3 p-3 rounded-lg bg-surface-muted border border-border">
                  <div className="text-xs font-medium text-text-primary mb-2">
                    {t('mcp.toolsAvailable', { count: tools.length }).split(' ').slice(1).join(' ')}
                    :
                  </div>
                  <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto">
                    {tools.map((tool, idx) => {
                      // Extract only the part after the last double underscore
                      const parts = tool.name.split('__');
                      const displayName = parts.length > 1 ? parts[parts.length - 1] : tool.name;
                      return (
                        <div
                          key={idx}
                          className="px-2 py-1.5 rounded bg-background border border-border text-xs text-text-secondary"
                          title={tool.description || tool.name}
                        >
                          <div className="font-mono text-accent break-words whitespace-normal">
                            {displayName}
                          </div>
                          {tool.description && (
                            <div className="text-text-muted mt-0.5 break-words whitespace-normal">
                              {tool.description}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {showTools && tools.length === 0 && (
                <div className="mt-3 p-3 rounded-lg bg-surface-muted text-xs text-text-muted">
                  {t('mcp.notConnected')}
                </div>
              )}

              {/* Tool Permissions Panel */}
              {server.enabled && tools.length > 0 && (
                <McpToolPermissions
                  server={server}
                  tools={tools}
                  onUpdatePolicy={onUpdateToolPolicy}
                  onUpdateToolPermission={onUpdateToolPermission}
                />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleEnabled}
              disabled={isLoading}
              className={`p-2 rounded-lg transition-colors ${
                server.enabled
                  ? 'bg-success/10 text-success hover:bg-success/20'
                  : 'bg-surface-muted text-text-muted hover:bg-surface-active'
              }`}
              title={
                server.enabled ? t('common.disable') || 'Disable' : t('common.enable') || 'Enable'
              }
            >
              {server.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
            </button>
            <button
              onClick={onEdit}
              disabled={isLoading}
              className="p-2 rounded-lg bg-surface-muted text-text-secondary hover:bg-surface-active transition-colors"
              title={t('common.edit')}
            >
              <Edit3 className="w-4 h-4" />
            </button>
            <button
              onClick={onDelete}
              disabled={isLoading}
              className="p-2 rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors"
              title={t('common.delete')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerForm({
  server,
  onSave,
  onCancel,
  isLoading,
}: {
  server?: MCPServerConfig;
  onSave: (server: MCPServerConfig) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name || '');
  const [description, setDescription] = useState(server?.description || '');
  const [type, setType] = useState<'stdio' | 'sse' | 'streamable-http'>(server?.type || 'stdio');
  const [command, setCommand] = useState(server?.command || '');
  const [args, setArgs] = useState(server?.args?.join(' ') || '');
  const [url, setUrl] = useState(server?.url || '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  // Tool timeout override (0 = use global default)
  const [toolTimeoutSeconds, setToolTimeoutSeconds] = useState(server?.toolTimeoutSeconds ?? 0);
  // Environment variables (for tokens, etc.)
  const [envVars, setEnvVars] = useState<Record<string, string>>(server?.env || {});
  const [showEnvSection, setShowEnvSection] = useState(Object.keys(server?.env || {}).length > 0);

  // HTTP Headers (for auth, etc.)
  const [headers, setHeaders] = useState<Record<string, string>>(server?.headers || {});
  const [showHeadersSection, setShowHeadersSection] = useState(
    Object.keys(server?.headers || {}).length > 0
  );
  const [isAddingHeader, setIsAddingHeader] = useState(false);
  const [newHeaderKey, setNewHeaderKey] = useState('');
  const [newHeaderValue, setNewHeaderValue] = useState('');

  function handleHeaderChange(key: string, value: string) {
    setHeaders((prev) => ({ ...prev, [key]: value }));
  }

  function handleRemoveHeader(key: string) {
    setHeaders((prev) => {
      const newHeaders = { ...prev };
      delete newHeaders[key];
      return newHeaders;
    });
  }

  const handleAddHeader = () => {
    setIsAddingHeader(true);
    setShowHeadersSection(true);
  };

  const handleSaveNewHeader = () => {
    if (newHeaderKey.trim()) {
      setHeaders((prev) => ({ ...prev, [newHeaderKey.trim()]: newHeaderValue.trim() }));
      setNewHeaderKey('');
      setNewHeaderValue('');
      setIsAddingHeader(false);
    }
  };

  const handleCancelNewHeader = () => {
    setNewHeaderKey('');
    setNewHeaderValue('');
    setIsAddingHeader(false);
  };

  function handleEnvChange(key: string, value: string) {
    setEnvVars((prev) => ({ ...prev, [key]: value }));
  }

  const [isAddingEnvVar, setIsAddingEnvVar] = useState(false);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');

  const handleAddEnvVar = () => {
    setIsAddingEnvVar(true);
    setShowEnvSection(true);
  };

  const handleSaveNewEnvVar = () => {
    if (newEnvKey.trim()) {
      setEnvVars((prev) => ({ ...prev, [newEnvKey.trim()]: newEnvValue.trim() }));
      setNewEnvKey('');
      setNewEnvValue('');
      setIsAddingEnvVar(false);
    }
  };

  const handleCancelNewEnvVar = () => {
    setNewEnvKey('');
    setNewEnvValue('');
    setIsAddingEnvVar(false);
  };

  function handleRemoveEnvVar(key: string) {
    setEnvVars((prev) => {
      const newVars = { ...prev };
      delete newVars[key];
      return newVars;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const descTrimmed = description.trim();
    const descChanged = descTrimmed !== (server?.description || '');

    const config: MCPServerConfig = {
      id: server?.id || `mcp-${Date.now()}`,
      name: name.trim(),
      type,
      enabled,
      toolTimeoutSeconds: toolTimeoutSeconds > 0 ? toolTimeoutSeconds : undefined,
    };

    // Description field handling:
    // - Non-empty + changed → set as manual, clear hash (triggers re-evaluation)
    // - Non-empty + unchanged → preserve existing source and hash
    // - Empty → clear description, source, and hash (field absent = cleared)
    if (descTrimmed) {
      config.description = descTrimmed;
      if (descChanged) {
        config.descriptionSource = 'manual';
        // Hash cleared: manual edit invalidates the tool-list association
      } else {
        // Preserve existing metadata when description is untouched
        config.descriptionSource = server?.descriptionSource;
        config.descriptionToolsHash = server?.descriptionToolsHash;
      }
    }
    // When empty: description, descriptionSource, and descriptionToolsHash are absent.
    // electron-store does full-replace, so absent fields = deleted from persisted JSON.

    if (type === 'stdio') {
      if (!command.trim()) {
        alert(t('mcp.commandRequired'));
        return;
      }
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
      // Include environment variables
      if (Object.keys(envVars).length > 0) {
        config.env = envVars;
      }
    } else {
      if (!url.trim()) {
        alert(t('mcp.urlRequired'));
        return;
      }
      config.url = url.trim();
      // Include headers for SSE and Streamable HTTP
      if (Object.keys(headers).length > 0) {
        config.headers = headers;
      }
    }

    onSave(config);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-surface p-4 space-y-4"
    >
      <h3 className="font-medium text-text-primary">
        {server ? t('mcp.editConnector') : t('mcp.addConnectorTitle')}
      </h3>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-2">{t('mcp.name')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('mcp.namePlaceholder')}
          className="w-full px-4 py-2 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-2">
          {t('mcp.description', { defaultValue: 'Description' })}
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('mcp.descriptionPlaceholder', {
            defaultValue: 'What this server does (helps AI choose the right tools)',
          })}
          className="w-full px-4 py-2 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 text-sm"
          maxLength={200}
        />
        <p className="text-xs text-text-muted mt-1">
          {t('mcp.descriptionHint', {
            defaultValue: 'Optional. Auto-generated if left empty when server connects.',
          })}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-2">{t('mcp.type')}</label>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setType('stdio')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              type === 'stdio'
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-text-secondary hover:bg-surface-active'
            }`}
          >
            {t('mcp.typeStdioLocal')}
          </button>
          <button
            type="button"
            onClick={() => setType('sse')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              type === 'sse'
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-text-secondary hover:bg-surface-active'
            }`}
          >
            {t('mcp.typeSseRemote')}
          </button>
          <button
            type="button"
            onClick={() => setType('streamable-http')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              type === 'streamable-http'
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-text-secondary hover:bg-surface-active'
            }`}
          >
            {t('mcp.typeStreamableHttp')}
          </button>
        </div>
      </div>

      {type === 'stdio' ? (
        <>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              {t('mcp.command')}
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('mcp.commandPlaceholder')}
              className="w-full px-4 py-2 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              {t('mcp.arguments')}
            </label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t('mcp.argumentsPlaceholder')}
              className="w-full px-4 py-2 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono text-sm"
            />
            <p className="text-xs text-text-muted mt-1">{t('mcp.spaceSeparated')}</p>
          </div>

          {/* Environment Variables Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-primary">
                {t('credentials.envVars')}
              </label>
              <button
                type="button"
                onClick={() => setShowEnvSection(!showEnvSection)}
                className="text-xs text-accent hover:text-accent-hover"
              >
                {showEnvSection ? t('mcp.hide') : t('mcp.show')}
              </button>
            </div>
            {showEnvSection && (
              <div className="space-y-2 p-3 rounded-lg bg-surface-muted border border-border">
                {Object.entries(envVars).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span
                      className="text-xs font-mono text-text-secondary w-32 truncate"
                      title={key}
                    >
                      {key}
                    </span>
                    <input
                      type="password"
                      value={value}
                      onChange={(e) => handleEnvChange(key, e.target.value)}
                      placeholder={`${t('mcp.envValuePlaceholder')}: ${key}`}
                      className="flex-1 px-3 py-1.5 rounded bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveEnvVar(key)}
                      className="p-1.5 rounded hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                      title={t('mcp.removeVar')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {Object.keys(envVars).length === 0 && !isAddingEnvVar && (
                  <p className="text-xs text-text-muted text-center py-2">
                    {t('credentials.noEnvVars')}
                  </p>
                )}
                {isAddingEnvVar && (
                  <div className="space-y-2 p-2 rounded bg-background border border-accent/30">
                    <input
                      type="text"
                      value={newEnvKey}
                      onChange={(e) => setNewEnvKey(e.target.value)}
                      placeholder="NOTION_TOKEN"
                      className="w-full px-3 py-1.5 rounded bg-surface border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                      autoFocus
                    />
                    <input
                      type="password"
                      value={newEnvValue}
                      onChange={(e) => setNewEnvValue(e.target.value)}
                      placeholder={t('mcp.envValuePlaceholder')}
                      className="w-full px-3 py-1.5 rounded bg-surface border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSaveNewEnvVar}
                        disabled={!newEnvKey.trim()}
                        className="flex-1 py-1 px-3 rounded bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelNewEnvVar}
                        className="flex-1 py-1 px-3 rounded bg-surface-muted text-text-secondary text-xs hover:bg-surface-active transition-colors"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {!isAddingEnvVar && (
                  <button
                    type="button"
                    onClick={handleAddEnvVar}
                    className="w-full mt-2 py-1.5 px-3 rounded border border-dashed border-border hover:border-accent hover:bg-accent/5 text-xs text-text-secondary hover:text-accent transition-colors flex items-center justify-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('credentials.envVars')}
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-text-muted">{t('credentials.usedForTokens')}</p>
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              {t('mcp.url')}
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="w-full px-4 py-2 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono text-sm"
              required
            />
          </div>

          {/* Headers Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-primary">{t('mcp.headers')}</label>
              <button
                type="button"
                onClick={() => setShowHeadersSection(!showHeadersSection)}
                className="text-xs text-accent hover:text-accent-hover"
              >
                {showHeadersSection ? t('mcp.hide') : t('mcp.show')}
              </button>
            </div>
            {showHeadersSection && (
              <div className="space-y-2 p-3 rounded-lg bg-surface-muted border border-border">
                {Object.entries(headers).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span
                      className="text-xs font-mono text-text-secondary w-32 truncate"
                      title={key}
                    >
                      {key}
                    </span>
                    <input
                      type="password"
                      value={value}
                      onChange={(e) => handleHeaderChange(key, e.target.value)}
                      placeholder={`${t('mcp.headerValuePlaceholder')}`}
                      className="flex-1 px-3 py-1.5 rounded bg-background border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveHeader(key)}
                      className="p-1.5 rounded hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                      title={t('mcp.removeVar')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {Object.keys(headers).length === 0 && !isAddingHeader && (
                  <p className="text-xs text-text-muted text-center py-2">{t('mcp.noHeaders')}</p>
                )}
                {isAddingHeader && (
                  <div className="space-y-2 p-2 rounded bg-background border border-accent/30">
                    <input
                      type="text"
                      value={newHeaderKey}
                      onChange={(e) => setNewHeaderKey(e.target.value)}
                      placeholder={t('mcp.headerKeyPlaceholder')}
                      className="w-full px-3 py-1.5 rounded bg-surface border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                      autoFocus
                    />
                    <input
                      type="password"
                      value={newHeaderValue}
                      onChange={(e) => setNewHeaderValue(e.target.value)}
                      placeholder={t('mcp.headerValuePlaceholder')}
                      className="w-full px-3 py-1.5 rounded bg-surface border border-border text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSaveNewHeader}
                        disabled={!newHeaderKey.trim()}
                        className="flex-1 py-1 px-3 rounded bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelNewHeader}
                        className="flex-1 py-1 px-3 rounded bg-surface-muted text-text-secondary text-xs hover:bg-surface-active transition-colors"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {!isAddingHeader && (
                  <button
                    type="button"
                    onClick={handleAddHeader}
                    className="w-full mt-2 py-1.5 px-3 rounded border border-dashed border-border hover:border-accent hover:bg-accent/5 text-xs text-text-secondary hover:text-accent transition-colors flex items-center justify-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('mcp.headers')}
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-text-muted">{t('mcp.headersDescription')}</p>
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
        />
        <label htmlFor="enabled" className="text-sm text-text-primary">
          {t('mcp.enableConnector')}
        </label>
      </div>

      {/* Per-server tool timeout override */}
      <div className="space-y-1">
        <label htmlFor="toolTimeout" className="text-sm text-text-secondary">
          {t('mcp.toolTimeoutLabel', 'Tool timeout (seconds)')}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            id="toolTimeout"
            min={0}
            max={600}
            step={10}
            value={toolTimeoutSeconds}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 0 && val <= 600) {
                // Normalize: 0 = global default, otherwise clamp to 10-600
                setToolTimeoutSeconds(val === 0 ? 0 : Math.max(10, val));
              }
            }}
            className="w-24 px-3 py-1.5 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <span className="text-xs text-text-muted">
            {t('mcp.toolTimeoutHint', '0 = use global default, min 10s')}
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 py-2 px-4 rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('common.saving')}
            </>
          ) : (
            t('common.save')
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="px-4 py-2 rounded-lg bg-surface-muted text-text-secondary hover:bg-surface-active transition-colors"
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
