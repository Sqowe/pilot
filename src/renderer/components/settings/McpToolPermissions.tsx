/**
 * MCP Tool Permissions Panel
 *
 * Displays per-server tool permission settings with:
 * - Server-level default policy selector
 * - Auto-classified tool tiers (read-only vs write)
 * - Per-tool override toggles (exception-based)
 * - Progressive trust suggestions
 */
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  ChevronDown,
  ChevronRight,
  Eye,
  Pencil,
  AlertTriangle,
} from 'lucide-react';
import type { MCPServerConfig, MCPToolInfo } from './shared';
import { isToolLikelyReadOnly, getToolShortName } from '../../../shared/mcp-tool-classification';

// ---------------------------------------------------------------------------
// Policy options
// ---------------------------------------------------------------------------

type DefaultPolicy = 'allow-all' | 'allow-reads' | 'ask-all' | 'deny-all';
type ToolAction = 'allow' | 'ask' | 'deny';

const POLICY_OPTIONS: Array<{ value: DefaultPolicy; labelKey: string; icon: typeof Shield }> = [
  { value: 'ask-all', labelKey: 'mcp.policyAskAll', icon: Shield },
  { value: 'allow-reads', labelKey: 'mcp.policyAllowReads', icon: ShieldCheck },
  { value: 'allow-all', labelKey: 'mcp.policyAllowAll', icon: ShieldAlert },
  { value: 'deny-all', labelKey: 'mcp.policyDenyAll', icon: ShieldOff },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface McpToolPermissionsProps {
  server: MCPServerConfig;
  tools: MCPToolInfo[];
  onUpdatePolicy: (policy: DefaultPolicy) => void;
  onUpdateToolPermission: (toolShortName: string, action: ToolAction | undefined) => void;
}

export function McpToolPermissions({
  server,
  tools,
  onUpdatePolicy,
  onUpdateToolPermission,
}: McpToolPermissionsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);

  const currentPolicy = server.defaultToolPolicy || 'ask-all';
  const toolPermissions = server.toolPermissions || {};

  // Classify tools into tiers
  const { readOnlyTools, writeTools, overriddenTools } = useMemo(() => {
    const readOnly: MCPToolInfo[] = [];
    const write: MCPToolInfo[] = [];
    const overridden: Array<MCPToolInfo & { override: ToolAction }> = [];

    for (const tool of tools) {
      const shortName = getToolShortName(tool.name);
      const override = toolPermissions[shortName];
      if (override) {
        overridden.push({ ...tool, override });
      } else if (isToolLikelyReadOnly(shortName)) {
        readOnly.push(tool);
      } else {
        write.push(tool);
      }
    }

    return { readOnlyTools: readOnly, writeTools: write, overriddenTools: overridden };
  }, [tools, toolPermissions]);

  // Compute effective counts
  const effectiveCounts = useMemo(() => {
    let allowed = 0;
    let asked = 0;
    let denied = 0;

    for (const tool of tools) {
      const shortName = getToolShortName(tool.name);
      const override = toolPermissions[shortName];
      if (override) {
        if (override === 'allow') allowed++;
        else if (override === 'deny') denied++;
        else asked++;
      } else {
        switch (currentPolicy) {
          case 'allow-all':
            allowed++;
            break;
          case 'deny-all':
            denied++;
            break;
          case 'ask-all':
            asked++;
            break;
          case 'allow-reads':
            if (isToolLikelyReadOnly(shortName)) allowed++;
            else asked++;
            break;
        }
      }
    }

    return { allowed, asked, denied };
  }, [tools, toolPermissions, currentPolicy]);

  return (
    <div className="mt-3 border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-muted hover:bg-surface transition-colors"
      >
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">
            {t('mcp.toolPermissions', { defaultValue: 'Tool Permissions' })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Summary badges */}
          <div className="flex items-center gap-1.5 text-xs">
            {effectiveCounts.allowed > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-success/10 text-success">
                ✓ {effectiveCounts.allowed}
              </span>
            )}
            {effectiveCounts.asked > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                🤚 {effectiveCounts.asked}
              </span>
            )}
            {effectiveCounts.denied > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-error/10 text-error">
                ⊘ {effectiveCounts.denied}
              </span>
            )}
          </div>
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 py-3 space-y-4 border-t border-border">
          {/* Default policy selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-text-secondary">
              {t('mcp.defaultPolicy', { defaultValue: 'Default policy' })}
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {POLICY_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => onUpdatePolicy(value)}
                  className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-medium transition-all ${
                    currentPolicy === value
                      ? 'bg-accent/15 text-accent border-2 border-accent/50 shadow-sm'
                      : 'bg-surface border border-border text-text-secondary hover:bg-surface-muted hover:border-border-active'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${currentPolicy === value ? 'text-accent' : ''}`} />
                  {t(labelKey, { defaultValue: value })}
                </button>
              ))}
            </div>
            {/* Policy description */}
            <p className="text-[11px] text-text-muted leading-relaxed">
              {currentPolicy === 'allow-all' &&
                t('mcp.policyAllowAllDesc', {
                  defaultValue:
                    'All tools auto-approved without prompting. Use for fully trusted servers.',
                })}
              {currentPolicy === 'allow-reads' &&
                t('mcp.policyAllowReadsDesc', {
                  defaultValue:
                    'Read-only tools (get_*, list_*, search_*) auto-approved. Write tools still prompt.',
                })}
              {currentPolicy === 'ask-all' &&
                t('mcp.policyAskAllDesc', {
                  defaultValue: 'Every tool requires manual approval (default behavior).',
                })}
              {currentPolicy === 'deny-all' &&
                t('mcp.policyDenyAllDesc', {
                  defaultValue: "All tools blocked. Use to temporarily disable a server's tools.",
                })}
            </p>
          </div>

          {/* Tool classification summary */}
          {tools.length > 0 && currentPolicy === 'allow-reads' && (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs text-text-muted">
                <span className="flex items-center gap-1">
                  <Eye className="w-3 h-3 text-success" />
                  {t('mcp.readOnlyCount', {
                    count: readOnlyTools.length,
                    defaultValue: `${readOnlyTools.length} read-only (auto-allowed)`,
                  })}
                </span>
                <span className="flex items-center gap-1">
                  <Pencil className="w-3 h-3 text-warning" />
                  {t('mcp.writeCount', {
                    count: writeTools.length,
                    defaultValue: `${writeTools.length} write (will prompt)`,
                  })}
                </span>
              </div>
            </div>
          )}

          {/* Per-tool overrides */}
          {tools.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowOverrides(!showOverrides)}
                className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
              >
                {showOverrides ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                {t('mcp.toolOverrides', {
                  defaultValue: `Tool overrides (${Object.keys(toolPermissions).length})`,
                })}
              </button>

              {showOverrides && (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {/* Existing overrides first */}
                  {overriddenTools.length > 0 && (
                    <div className="mb-2">
                      <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                        {t('mcp.activeOverrides', { defaultValue: 'Active overrides' })}
                      </div>
                      {overriddenTools.map((tool) => {
                        const shortName = getToolShortName(tool.name);
                        return (
                          <ToolOverrideRow
                            key={tool.name}
                            shortName={shortName}
                            description={tool.description}
                            currentAction={tool.override}
                            onChangeAction={(action) => onUpdateToolPermission(shortName, action)}
                            onRemoveOverride={() => onUpdateToolPermission(shortName, undefined)}
                          />
                        );
                      })}
                    </div>
                  )}

                  {/* All tools (for adding overrides) */}
                  <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    {t('mcp.allTools', { defaultValue: 'All tools' })}
                  </div>
                  {tools.map((tool) => {
                    const shortName = getToolShortName(tool.name);
                    const hasOverride = shortName in toolPermissions;
                    if (hasOverride) return null; // Already shown above
                    const readOnly = isToolLikelyReadOnly(shortName);
                    return (
                      <ToolRow
                        key={tool.name}
                        shortName={shortName}
                        description={tool.description}
                        isReadOnly={readOnly}
                        effectiveAction={
                          currentPolicy === 'allow-all'
                            ? 'allow'
                            : currentPolicy === 'deny-all'
                              ? 'deny'
                              : currentPolicy === 'allow-reads' && readOnly
                                ? 'allow'
                                : 'ask'
                        }
                        onAddOverride={(action) => onUpdateToolPermission(shortName, action)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Warning for allow-all */}
          {currentPolicy === 'allow-all' && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-warning/5 border border-warning/20">
              <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
              <p className="text-[11px] text-warning leading-relaxed">
                {t('mcp.allowAllWarning', {
                  defaultValue:
                    'All tools from this server will execute without prompting. Only use for fully trusted servers.',
                })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolOverrideRow({
  shortName,
  description,
  currentAction,
  onChangeAction,
  onRemoveOverride,
}: {
  shortName: string;
  description?: string;
  currentAction: ToolAction;
  onChangeAction: (action: ToolAction) => void;
  onRemoveOverride: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1.5 rounded bg-background border border-border">
      <div className="flex-1 min-w-0 mr-2">
        <div className="font-mono text-xs text-text-primary truncate">{shortName}</div>
        {description && <div className="text-[10px] text-text-muted truncate">{description}</div>}
      </div>
      <div className="flex items-center gap-1">
        <ActionToggle value={currentAction} onChange={onChangeAction} />
        <button
          onClick={onRemoveOverride}
          className="ml-1 text-[10px] text-text-muted hover:text-error transition-colors"
          title="Remove override"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ToolRow({
  shortName,
  description,
  isReadOnly: readOnly,
  effectiveAction,
  onAddOverride,
}: {
  shortName: string;
  description?: string;
  isReadOnly: boolean;
  effectiveAction: ToolAction;
  onAddOverride: (action: ToolAction) => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded hover:bg-surface-muted transition-colors group">
      <div className="flex-1 min-w-0 mr-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-text-secondary truncate">{shortName}</span>
          {readOnly && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success shrink-0">
              read
            </span>
          )}
        </div>
        {description && <div className="text-[10px] text-text-muted truncate">{description}</div>}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onAddOverride(effectiveAction === 'allow' ? 'ask' : 'allow')}
          className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted hover:text-accent hover:border-accent/30 transition-colors"
        >
          {effectiveAction === 'allow' ? '→ ask' : '→ allow'}
        </button>
      </div>
    </div>
  );
}

function ActionToggle({
  value,
  onChange,
}: {
  value: ToolAction;
  onChange: (action: ToolAction) => void;
}) {
  const actions: Array<{ action: ToolAction; label: string; activeColor: string }> = [
    {
      action: 'allow',
      label: '✓',
      activeColor: 'text-success bg-success/20 border-2 border-success/60 shadow-sm',
    },
    {
      action: 'ask',
      label: '🤚',
      activeColor: 'text-warning bg-warning/20 border-2 border-warning/60 shadow-sm',
    },
    {
      action: 'deny',
      label: '⊘',
      activeColor: 'text-error bg-error/20 border-2 border-error/60 shadow-sm',
    },
  ];

  return (
    <div className="flex items-center gap-1">
      {actions.map(({ action, label, activeColor }) => (
        <button
          key={action}
          onClick={() => onChange(action)}
          className={`w-7 h-7 flex items-center justify-center rounded-md text-xs transition-all ${
            value === action
              ? activeColor
              : 'text-text-muted bg-surface border border-border hover:bg-surface-muted hover:border-border-active'
          }`}
          title={action}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
