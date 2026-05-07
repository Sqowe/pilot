import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Play, SkipForward } from 'lucide-react';
import type { MissedTaskInfo, CatchUpDecision } from '../types';

interface ScheduleCatchUpPanelProps {
  tasks: MissedTaskInfo[];
  onResolve: (decisions: CatchUpDecision[]) => void;
  onDismiss: () => void;
}

/**
 * Batch catch-up panel shown when the app opens with missed scheduled tasks.
 * Allows the user to run or skip each missed task individually, or use bulk actions.
 */
export function ScheduleCatchUpPanel({ tasks, onResolve, onDismiss }: ScheduleCatchUpPanelProps) {
  const { t } = useTranslation();
  const [decisions, setDecisions] = useState<Map<string, 'run' | 'skip'>>(new Map());

  function setDecision(taskId: string, action: 'run' | 'skip') {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(taskId, action);
      return next;
    });
  }

  function handleRunAll() {
    const allDecisions: CatchUpDecision[] = tasks.map((task) => ({
      taskId: task.taskId,
      action: 'run',
    }));
    onResolve(allDecisions);
  }

  function handleSkipAll() {
    const allDecisions: CatchUpDecision[] = tasks.map((task) => ({
      taskId: task.taskId,
      action: 'skip',
    }));
    onResolve(allDecisions);
  }

  function handleSubmit() {
    const resolved: CatchUpDecision[] = tasks.map((task) => ({
      taskId: task.taskId,
      action: decisions.get(task.taskId) ?? 'skip',
    }));
    onResolve(resolved);
  }

  const allDecided = tasks.every((task) => decisions.has(task.taskId));

  function formatTimeWindow(window: string | null): string {
    if (!window) return '';
    const key = `schedule.timeWindow${window.charAt(0).toUpperCase() + window.slice(1)}`;
    return t(key);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md mx-4 rounded-xl border border-border bg-surface shadow-xl">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-warning" />
            <h2 className="text-base font-medium text-text-primary">
              {t('schedule.catchUpTitle')}
            </h2>
          </div>
          <p className="text-xs text-text-muted mt-1">{t('schedule.catchUpDescription')}</p>
        </div>

        <div className="p-4 space-y-2 max-h-[50vh] overflow-y-auto">
          {tasks.map((task) => {
            const decision = decisions.get(task.taskId);
            return (
              <div
                key={task.taskId}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-background"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary truncate">{task.title}</div>
                  <div className="text-xs text-text-muted">
                    {task.timeWindow && formatTimeWindow(task.timeWindow)}
                    {task.timeWindow && ' · '}
                    {new Date(task.scheduledFor).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setDecision(task.taskId, 'run')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                      decision === 'run'
                        ? 'bg-success/20 text-success border border-success/30'
                        : 'bg-surface-hover text-text-secondary hover:bg-success/10'
                    }`}
                  >
                    <Play className="w-3 h-3" />
                    {t('schedule.catchUpRun')}
                  </button>
                  <button
                    onClick={() => setDecision(task.taskId, 'skip')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                      decision === 'skip'
                        ? 'bg-surface-hover text-text-muted border border-border'
                        : 'bg-surface-hover text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <SkipForward className="w-3 h-3" />
                    {t('schedule.catchUpSkip')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-4 border-t border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunAll}
              className="px-3 py-1.5 rounded-lg bg-success/10 text-success text-xs font-medium hover:bg-success/20"
            >
              {t('schedule.catchUpRunAll')}
            </button>
            <button
              onClick={handleSkipAll}
              className="px-3 py-1.5 rounded-lg bg-surface-hover text-text-muted text-xs font-medium hover:bg-surface-hover"
            >
              {t('schedule.catchUpSkipAll')}
            </button>
          </div>
          <button
            onClick={allDecided ? handleSubmit : onDismiss}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium disabled:opacity-50"
          >
            {allDecided ? t('schedule.catchUpConfirm') : t('schedule.catchUpDismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
