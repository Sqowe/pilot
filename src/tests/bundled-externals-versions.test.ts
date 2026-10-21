import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The main build bundles pi but keeps some of pi's own dependencies external
// (vite.config.ts), so the built app loads *our* top-level copy of them, not the
// copy pi pinned. Tests resolve modules the Node way and reach pi's nested copy,
// so a mismatch never shows up in `npm test` — only in the packaged app. This
// pins every such dependency to the exact version pi declares.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PI_SCOPE_DIR = path.join(ROOT, 'node_modules', '@earendil-works');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

/** The string entries of the main-process `external` list in vite.config.ts. */
function mainProcessExternals(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
  const mainEntry = source.indexOf("entry: 'src/main/index.ts'");
  const listStart = source.indexOf('external: [', mainEntry);
  const listEnd = source.indexOf('],', listStart);
  if (mainEntry < 0 || listStart < 0 || listEnd < 0) {
    throw new Error('Could not find the main-process external list in vite.config.ts');
  }
  const list = source.slice(listStart, listEnd).replace(/\/\/.*$/gm, '');
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

interface PinnedExternal {
  piPackage: string;
  dependency: string;
  pinned: string;
}

/** Each dependency of an installed pi package that the main build leaves external. */
function piDependenciesLeftExternal(): PinnedExternal[] {
  const externals = new Set(mainProcessExternals());
  const found: PinnedExternal[] = [];
  for (const name of fs.readdirSync(PI_SCOPE_DIR)) {
    const manifest = path.join(PI_SCOPE_DIR, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const dependencies = (readJson(manifest).dependencies ?? {}) as Record<string, string>;
    for (const [dependency, pinned] of Object.entries(dependencies)) {
      if (externals.has(dependency)) {
        found.push({ piPackage: `@earendil-works/${name}`, dependency, pinned });
      }
    }
  }
  return found;
}

describe('dependencies pi shares with the app through the external list', () => {
  it('reads the external list and finds the SDKs pi-ai calls', () => {
    // Guard for the test itself: a parse that finds nothing would make the
    // next test pass for no reason.
    const checked = piDependenciesLeftExternal().map((entry) => entry.dependency);
    expect(checked).toEqual(expect.arrayContaining(['openai', '@anthropic-ai/sdk']));
  });

  it('installs at the top level exactly the version pi pinned', () => {
    for (const { piPackage, dependency, pinned } of piDependenciesLeftExternal()) {
      const installed = readJson(path.join(ROOT, 'node_modules', dependency, 'package.json'))
        .version as string;
      expect(
        installed,
        `${piPackage} pins ${dependency}@${pinned}, but the bundle loads the top-level ` +
          `${dependency}@${installed}. Set the same exact version in package.json.`
      ).toBe(pinned);
    }
  });
});
