import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const indexPath = path.resolve(process.cwd(), 'src/main/index.ts');

describe('Main process startup order', () => {
  it('initializes session manager before creating the main window', () => {
    const source = fs.readFileSync(indexPath, 'utf8');
    const startupBlock = source.match(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\);/)?.[0] || '';

    const createWindowIndex = startupBlock.indexOf('createWindow();');
    const sessionManagerIndex = startupBlock.indexOf('sessionManager = new SessionManager');

    expect(sessionManagerIndex).toBeGreaterThan(-1);
    expect(createWindowIndex).toBeGreaterThan(-1);
    expect(sessionManagerIndex).toBeLessThan(createWindowIndex);
  });
});
