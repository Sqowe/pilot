/**
 * Lightweight build-verification test for the pi bash-restrictions extension bundle.
 *
 * Runs the bundler (npm run build:pi-extension), then imports the output file and
 * asserts that:
 *   - the output .mjs file was produced
 *   - the file is importable (all externals resolve from node_modules)
 *   - the default export is a function (the pi factory)
 *   - resolveBashToolCall is a named export and a function
 *   - dialog choice constants are exported with their expected string values
 *
 * The dist-pi-extensions/ directory is removed in afterAll so the working tree
 * stays clean between runs.
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT, 'dist-pi-extensions');
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'bash-restrictions.mjs');

// Holds the dynamically-imported module shape.
let mod: Record<string, unknown> = {};

beforeAll(async () => {
  // Run the bundler synchronously so test assertions can rely on its output.
  execSync('npm run build:pi-extension', {
    cwd: ROOT,
    stdio: 'pipe', // suppress build output in test reporter
  });

  // Import via a file:// URL — required for local ESM dynamic imports in Node.js.
  const fileUrl = pathToFileURL(OUTPUT_FILE).href;
  mod = (await import(fileUrl)) as Record<string, unknown>;
}, 30_000); // generous timeout: bundler + import can take a few seconds

afterAll(() => {
  // Remove the build output so it doesn't accumulate across runs.
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

describe('build output', () => {
  it('produces dist-pi-extensions/bash-restrictions.mjs', () => {
    expect(existsSync(OUTPUT_FILE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('default export is a function (the pi extension factory)', () => {
    // The factory is: (pi: ExtensionAPI) => void
    expect(typeof mod['default']).toBe('function');
  });

  it('resolveBashToolCall is exported as a function', () => {
    // The pure mapping function used in tests must survive bundling.
    expect(typeof mod['resolveBashToolCall']).toBe('function');
  });

  it('CHOICE_ALLOW is exported with the expected string value', () => {
    expect(mod['CHOICE_ALLOW']).toBe('Allow once');
  });

  it('CHOICE_DENY is exported with the expected string value', () => {
    expect(mod['CHOICE_DENY']).toBe('Deny');
  });

  it('CHOICE_SUGGEST is exported with the expected string value', () => {
    expect(mod['CHOICE_SUGGEST']).toBe('Deny & suggest alternative');
  });
});
