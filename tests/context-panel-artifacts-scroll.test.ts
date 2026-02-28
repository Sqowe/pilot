import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const contextPanelPath = path.resolve(process.cwd(), 'src/renderer/components/ContextPanel.tsx');

describe('ContextPanel artifacts scroll', () => {
  it('uses an overflow container for the artifacts list so mouse wheel can scroll', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('className="px-4 pb-4 max-h-80 overflow-y-auto"');
  });
});
