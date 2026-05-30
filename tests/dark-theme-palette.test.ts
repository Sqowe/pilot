import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const stylesPath = path.resolve(process.cwd(), 'src/renderer/styles/globals.css');

describe('dark theme palette', () => {
  it('uses a warmer charcoal palette for the default theme', () => {
    const source = fs.readFileSync(stylesPath, 'utf8');
    expect(source).toContain('--color-background: #1c1c1e;');
    expect(source).toContain('--color-surface: #27272a;');
    expect(source).toContain('--color-text-primary: #f0eff2;');
  });

  it('keeps the accent within the warm orange family', () => {
    const source = fs.readFileSync(stylesPath, 'utf8');
    expect(source).toContain('--color-accent: #8e88a3;');
    expect(source).toContain('--color-accent-hover: #7a7590;');
  });
});
