import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import {
  SYSTEM_PROMPT_FILE_CHOICES,
  type SystemPromptFileChoice,
} from '../../../shared/system-prompt-file-choices';
import {
  RotateCcw,
  FolderOpen,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';

interface PromptSection {
  id: string;
  filename: string;
  content: string;
  enabled: boolean;
  isDefault: boolean;
}

/**
 * Settings panel for system prompt configuration.
 *
 * Controls how the AI assistant's system prompt is assembled:
 * - Workspace instructions file selection
 * - Editable prompt sections with enable/disable toggles
 */
export function SettingsPrompt() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [sections, setSections] = useState<PromptSection[]>([]);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [showResetAllConfirm, setShowResetAllConfirm] = useState(false);
  const [pendingResetSection, setPendingResetSection] = useState<string | null>(null);
  const sectionsRef = useRef<PromptSection[]>([]);
  const draftsRef = useRef<Record<string, string>>({});

  // Keep refs in sync with state
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);
  useEffect(() => {
    draftsRef.current = editDrafts;
  }, [editDrafts]);

  // Load sections on mount
  useEffect(() => {
    loadSections();
  }, []);

  const loadSections = useCallback(async (onlyFilename?: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.invoke({
      type: 'prompt.getSections',
      payload: {},
    });
    if (Array.isArray(result)) {
      setSections(result);
      // Only update drafts for sections that are not dirty.
      // Use refs to get the latest state without stale closure issues.
      setEditDrafts((prev) => {
        const next = { ...prev };
        const currentSections = sectionsRef.current;
        for (const s of result as PromptSection[]) {
          if (onlyFilename && s.filename !== onlyFilename) continue;
          const currentSection = currentSections.find((sec) => sec.filename === s.filename);
          const currentDraft = prev[s.filename];
          // Draft is dirty if it differs from the last-known persisted content
          const isDirty =
            currentDraft !== undefined && currentSection && currentDraft !== currentSection.content;
          if (!isDirty) {
            next[s.filename] = s.content;
          }
        }
        return next;
      });
    }
  }, []);

  const handleToggle = useCallback(
    async (filename: string, enabled: boolean) => {
      if (!window.electronAPI) return;
      setError(null);
      const result = await window.electronAPI.invoke<{ success: boolean; error?: string }>({
        type: 'prompt.toggleSection',
        payload: { filename, enabled },
      });
      if (result?.success) {
        setSections((prev) => prev.map((s) => (s.filename === filename ? { ...s, enabled } : s)));
      } else {
        setError(result?.error || 'Failed to toggle section');
        await loadSections(filename);
      }
    },
    [loadSections]
  );

  const handleSave = useCallback(
    async (filename: string) => {
      if (!window.electronAPI) return;
      const content = editDrafts[filename];
      if (content === undefined) return;
      setError(null);
      const result = await window.electronAPI.invoke<{ success: boolean; error?: string }>({
        type: 'prompt.updateSection',
        payload: { filename, content },
      });
      if (result?.success) {
        setSections((prev) =>
          prev.map((s) => (s.filename === filename ? { ...s, content, isDefault: false } : s))
        );
      } else {
        setError(result?.error || 'Failed to save section');
        await loadSections(filename);
      }
    },
    [editDrafts, loadSections]
  );

  const handleReset = useCallback(
    async (filename: string) => {
      if (!window.electronAPI) return;
      setError(null);
      const result = await window.electronAPI.invoke<{ success: boolean; error?: string }>({
        type: 'prompt.resetSection',
        payload: { filename },
      });
      if (result?.success) {
        await loadSections(filename);
      } else {
        setError(result?.error || 'Failed to reset section');
      }
    },
    [loadSections]
  );

  const handleOpenFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.invoke({
      type: 'prompt.getDir',
      payload: {},
    });
  }, []);

  const handleResetAll = useCallback(async () => {
    if (!window.electronAPI) return;
    setError(null);
    try {
      const result = await window.electronAPI.invoke<{ success: boolean; error?: string }>({
        type: 'prompt.resetAll',
        payload: {},
      });
      setShowResetAllConfirm(false);
      if (result?.success) {
        // Force full reload of all sections and drafts
        const freshSections = await window.electronAPI.invoke({
          type: 'prompt.getSections',
          payload: {},
        });
        if (Array.isArray(freshSections)) {
          setSections(freshSections);
          const drafts: Record<string, string> = {};
          for (const s of freshSections as PromptSection[]) {
            drafts[s.filename] = s.content;
          }
          setEditDrafts(drafts);
        }
      } else {
        setError(result?.error || 'Failed to reset all sections');
      }
    } catch (err) {
      setShowResetAllConfirm(false);
      setError(err instanceof Error ? err.message : 'Reset failed due to an unexpected error');
    }
  }, []);

  const systemPromptFile: SystemPromptFileChoice = settings.systemPromptFile ?? '';
  const onSystemPromptFileChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as SystemPromptFileChoice;
    if ((SYSTEM_PROMPT_FILE_CHOICES as readonly string[]).includes(next)) {
      updateSettings({ systemPromptFile: next });
    }
  };

  const sectionLabels: Record<string, string> = {
    'identity.md': t('prompt.sectionIdentity', 'Identity'),
    'behavioral-rules.md': t('prompt.sectionBehavior', 'Behavioral Rules'),
    'citations.md': t('prompt.sectionCitations', 'Citations'),
    'tool-routing.md': t('prompt.sectionToolRouting', 'Tool Routing'),
  };

  return (
    <div className="space-y-6">
      {/* Prompt Sections */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-text-primary">
            {t('prompt.sectionsTitle', 'System prompt sections')}
          </h4>
          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors"
            title={t('prompt.openFolder', 'Open prompts folder')}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {t('prompt.openFolder', 'Open folder')}
          </button>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'prompt.sectionsDesc',
            'Each section is a separate file you can edit, disable, or reset. Changes apply to the next message.'
          )}
        </p>

        {error && (
          <div className="p-2 rounded-lg bg-warning/10 border border-warning/20">
            <p className="text-xs text-warning">{error}</p>
          </div>
        )}

        <div className="space-y-1 mt-3">
          {sections.map((section) => {
            const isExpanded = expandedSection === section.filename;
            const draft = editDrafts[section.filename] ?? section.content;
            const hasChanges = draft !== section.content;

            return (
              <div
                key={section.filename}
                className="border border-border rounded-lg overflow-hidden"
              >
                {/* Section header */}
                <div className="flex items-center gap-2 px-3 py-2 bg-surface-muted">
                  <button
                    onClick={() => setExpandedSection(isExpanded ? null : section.filename)}
                    className="flex items-center gap-1 flex-1 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-text-secondary" />
                    )}
                    <span className="text-sm font-medium text-text-primary">
                      {sectionLabels[section.filename] || section.id}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    {!section.isDefault && pendingResetSection !== section.filename && (
                      <button
                        onClick={() => setPendingResetSection(section.filename)}
                        className="p-1 rounded hover:bg-surface text-text-muted hover:text-warning transition-colors"
                        title={t('prompt.resetToDefault', 'Reset to default')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {pendingResetSection === section.filename && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            handleReset(section.filename);
                            setPendingResetSection(null);
                          }}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-warning/20 border border-warning/30 text-warning font-medium hover:bg-warning/30 transition-colors"
                          title={t('prompt.confirmReset', 'Confirm reset')}
                        >
                          {t('prompt.reset', 'Reset')}
                        </button>
                        <button
                          onClick={() => setPendingResetSection(null)}
                          className="px-1.5 py-0.5 text-[10px] rounded border border-border text-text-muted hover:bg-surface transition-colors"
                        >
                          {t('prompt.cancel', 'Cancel')}
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => handleToggle(section.filename, !section.enabled)}
                      className={`p-1 rounded transition-colors ${
                        section.enabled
                          ? 'text-accent hover:bg-accent/10'
                          : 'text-text-muted hover:bg-surface'
                      }`}
                      title={
                        section.enabled
                          ? t('prompt.disable', 'Disable section')
                          : t('prompt.enable', 'Enable section')
                      }
                    >
                      {section.enabled ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Section editor */}
                {isExpanded && (
                  <div className="p-3 border-t border-border">
                    <textarea
                      value={draft}
                      onChange={(e) =>
                        setEditDrafts((prev) => ({
                          ...prev,
                          [section.filename]: e.target.value,
                        }))
                      }
                      onBlur={() => {
                        if (hasChanges) handleSave(section.filename);
                      }}
                      spellCheck={false}
                      rows={Math.min(12, Math.max(4, draft.split('\n').length + 1))}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-xs font-mono text-text-primary focus:outline-none focus:ring-2 focus:ring-accent resize-y"
                      aria-label={sectionLabels[section.filename] || section.id}
                    />
                    {hasChanges && (
                      <p className="mt-1 text-xs text-text-muted italic">
                        {t('prompt.unsavedHint', 'Changes save on blur')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Reset All to Defaults */}
        <div className="mt-4">
          {!showResetAllConfirm ? (
            <button
              onClick={() => setShowResetAllConfirm(true)}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-warning transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('prompt.resetAll', 'Reset all to defaults')}
            </button>
          ) : (
            <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-warning font-medium">
                    {t('prompt.resetAllTitle', 'Reset all sections?')}
                  </p>
                  <p className="text-xs text-text-secondary mt-1">
                    {t(
                      'prompt.resetAllWarning',
                      'This will replace all prompt sections with factory defaults and re-enable all sections. Your custom edits will be lost.'
                    )}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => setShowResetAllConfirm(false)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-text-secondary hover:bg-surface-muted transition-colors"
                    >
                      {t('prompt.cancel', 'Cancel')}
                    </button>
                    <button
                      onClick={handleResetAll}
                      className="px-3 py-1.5 text-xs rounded-lg bg-warning/20 border border-warning/30 text-warning font-medium hover:bg-warning/30 transition-colors"
                    >
                      {t('prompt.resetAllConfirm', 'Reset All')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Workspace instructions file */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-text-primary">
          {t('prompt.workspaceInstructionsTitle', 'Workspace instructions file')}
        </h4>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'prompt.workspaceInstructionsDesc',
            'When this file exists at the session working directory, its contents are appended to the system prompt as project-level instructions. Missing file falls back to the default.'
          )}
        </p>
        <select
          value={systemPromptFile}
          onChange={onSystemPromptFileChange}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          aria-label={t('prompt.workspaceInstructionsTitle', 'Workspace instructions file')}
        >
          {SYSTEM_PROMPT_FILE_CHOICES.map((opt) => (
            <option key={opt || 'none'} value={opt}>
              {opt === '' ? t('prompt.workspaceInstructionsNone', 'None (use default)') : opt}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
