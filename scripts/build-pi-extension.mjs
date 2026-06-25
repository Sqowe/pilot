/**
 * Bundle the pi bash-restrictions extension into a self-contained ESM directory.
 *
 * Output: dist-pi-extensions/bash-restrictions/
 *   ├── index.js       # bundled extension (ESM)
 *   └── package.json    # manifest: { type: "module", pi: { extensions: ["./index.js"] } }
 *
 * Why a directory (and NOT a single .mjs):
 *   - pi's extension loader only auto-discovers `*.ts` and `*.js` files, or a
 *     subdirectory containing `index.ts`/`index.js`, or a directory whose
 *     package.json declares a `pi.extensions` manifest. A loose `.mjs` file is
 *     NOT discovered (dist/core/extensions/loader.js: name.endsWith(".ts")||".js").
 *   - The local package.json with `"type": "module"` also makes Node treat
 *     index.js as ESM regardless of the surrounding project's module type.
 *
 * Install:
 *   cp -r dist-pi-extensions/bash-restrictions ~/.pi/agent/extensions/
 *   # then /reload inside pi, or restart
 *
 * @earendil-works/* is external — provided by pi at load time (CONFIG_DIR_NAME,
 * isToolCallEventType, types). node:* built-ins are external. typebox is external
 * — pi ships it; bundling it would cause version mismatches.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_DIR = 'dist-pi-extensions/bash-restrictions';

await build({
  entryPoints: ['pi-extensions/bash-restrictions/extension.ts'],
  outfile: `${OUT_DIR}/index.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@earendil-works/*', 'typebox', 'node:*'],
  // Treat all node_modules packages (incl. node: built-ins) as external. The
  // relative `src/shared/bash-restrictions` engine is still bundled inline.
  packages: 'external',
  // Surface source locations in error messages during the build step.
  sourcemap: 'external',
  sourcesContent: false,
  logLevel: 'info',
});

// Emit the manifest so pi auto-discovers the directory and Node loads index.js as ESM.
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  `${OUT_DIR}/package.json`,
  JSON.stringify(
    {
      name: 'bash-restrictions',
      private: true,
      type: 'module',
      pi: { extensions: ['./index.js'] },
    },
    null,
    2
  ) + '\n'
);
