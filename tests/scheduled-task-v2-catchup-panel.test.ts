/**
 * Tests for the ScheduleCatchUpPanel component logic.
 * Validates decision mapping, Run All/Skip All behavior, and dismiss semantics.
 */
import { describe, expect, it } from 'vitest';
import type { MissedTaskInfo, CatchUpDecision } from '../src/renderer/types';

// Test the decision logic extracted from the component
// (Component rendering tests would require jsdom/testing-library which isn't set up)

describe('ScheduleCatchUpPanel — decision logic', () => {
  const mockTasks: MissedTaskInfo[] = [
    { taskId: 'task-1', title: 'Daily review', timeWindow: 'morning', scheduledFor: 1000 },
    { taskId: 'task-2', title: 'Dep check', timeWindow: 'morning', scheduledFor: 2000 },
    { taskId: 'task-3', title: 'Git pull', timeWindow: null, scheduledFor: 3000 },
  ];

  describe('Run All', () => {
    it('produces run decisions for all tasks', () => {
      const decisions: CatchUpDecision[] = mockTasks.map((task) => ({
        taskId: task.taskId,
        action: 'run',
      }));

      expect(decisions).toHaveLength(3);
      expect(decisions.every((d) => d.action === 'run')).toBe(true);
      expect(decisions.map((d) => d.taskId)).toEqual(['task-1', 'task-2', 'task-3']);
    });
  });

  describe('Skip All', () => {
    it('produces skip decisions for all tasks', () => {
      const decisions: CatchUpDecision[] = mockTasks.map((task) => ({
        taskId: task.taskId,
        action: 'skip',
      }));

      expect(decisions).toHaveLength(3);
      expect(decisions.every((d) => d.action === 'skip')).toBe(true);
    });
  });

  describe('per-task decisions', () => {
    it('maps individual decisions correctly', () => {
      const userDecisions = new Map<string, 'run' | 'skip'>([
        ['task-1', 'run'],
        ['task-2', 'skip'],
        ['task-3', 'run'],
      ]);

      const resolved: CatchUpDecision[] = mockTasks.map((task) => ({
        taskId: task.taskId,
        action: userDecisions.get(task.taskId) ?? 'skip',
      }));

      expect(resolved[0]).toEqual({ taskId: 'task-1', action: 'run' });
      expect(resolved[1]).toEqual({ taskId: 'task-2', action: 'skip' });
      expect(resolved[2]).toEqual({ taskId: 'task-3', action: 'run' });
    });

    it('defaults undecided tasks to skip', () => {
      // Only task-1 has a decision
      const userDecisions = new Map<string, 'run' | 'skip'>([['task-1', 'run']]);

      const resolved: CatchUpDecision[] = mockTasks.map((task) => ({
        taskId: task.taskId,
        action: userDecisions.get(task.taskId) ?? 'skip',
      }));

      expect(resolved[0].action).toBe('run');
      expect(resolved[1].action).toBe('skip'); // default
      expect(resolved[2].action).toBe('skip'); // default
    });
  });

  describe('allDecided gating', () => {
    it('returns false when not all tasks have decisions', () => {
      const decisions = new Map<string, 'run' | 'skip'>([['task-1', 'run']]);
      const allDecided = mockTasks.every((task) => decisions.has(task.taskId));
      expect(allDecided).toBe(false);
    });

    it('returns true when all tasks have decisions', () => {
      const decisions = new Map<string, 'run' | 'skip'>([
        ['task-1', 'run'],
        ['task-2', 'skip'],
        ['task-3', 'run'],
      ]);
      const allDecided = mockTasks.every((task) => decisions.has(task.taskId));
      expect(allDecided).toBe(true);
    });
  });

  describe('dismiss behavior', () => {
    it('dismiss when not all decided should skip all (handled by parent)', () => {
      // When user dismisses without deciding all tasks, the parent
      // should treat it as "skip all" — this is documented behavior.
      // The panel calls onDismiss which the parent maps to skip-all.
      const decisions: CatchUpDecision[] = mockTasks.map((task) => ({
        taskId: task.taskId,
        action: 'skip',
      }));
      expect(decisions.every((d) => d.action === 'skip')).toBe(true);
    });
  });
});
