import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viteConfigPath = path.resolve(process.cwd(), 'vite.config.ts');
const viteConfigContent = readFileSync(viteConfigPath, 'utf8');

describe('vite watch ignores build artifacts', () => {
  it('ignores packaged and build output directories to avoid reload spam', () => {
    expect(viteConfigContent).toContain('const ignoredWatchPaths = [');
    expect(viteConfigContent).toContain("'**/release/**'");
    expect(viteConfigContent).toContain("'**/dist/**'");
    expect(viteConfigContent).toContain("'**/dist-electron/**'");
    expect(viteConfigContent).toContain('ignored: ignoredWatchPaths');
  });
});

describe('vite main build output', () => {
  it('empties dist-electron/main so chunks of earlier builds are not packaged', () => {
    // vite-plugin-electron defaults emptyOutDir to false; every chunk name carries a
    // hash, so without this each rebuild adds a full set and nothing removes the old one.
    expect(viteConfigContent).toMatch(
      /outDir: 'dist-electron\/main',\n(\s*\/\/.*\n)*\s*emptyOutDir: true,/
    );
  });
});
