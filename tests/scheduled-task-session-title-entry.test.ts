import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('scheduled task session title wiring', () => {
  it('normalizes runtime session title from prompt before executing task', () => {
    const managerPath = path.resolve(process.cwd(), 'src/main/schedule/scheduled-task-manager.ts');
    const content = readFileSync(managerPath, 'utf8');
    expect(content).toContain('const runtimeTitle = buildScheduledTaskTitle(task.prompt);');
    expect(content).toContain('const taskForExecution = task.title === runtimeTitle');
    expect(content).toContain('this.store.update(task.id, { title: runtimeTitle });');
  });
});
