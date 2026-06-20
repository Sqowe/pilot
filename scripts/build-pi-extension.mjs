/**
 * Bundle the pi bash-restrictions extension into a single self-contained ESM file.
 *
 * Output: dist-pi-extensions/bash-restrictions.mjs
 *
 * The bundle is suitable for installation into pi's extension directory:
 *   cp dist-pi-extensions/bash-restrictions.mjs ~/.pi/agent/extensions/
 *   # then /reload inside pi, or restart
 *
 * @earendil-works/* is external — provided by pi at load time.
 * node:* built-ins are external — available in the Node.js runtime pi uses.
 * typebox is external — pi ships it; bundling it would cause version mismatches.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['pi-extensions/bash-restrictions/extension.ts'],
  outfile: 'dist-pi-extensions/bash-restrictions.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@earendil-works/*', 'typebox', 'node:*'],
  // Treat all node: built-ins with and without the protocol prefix as external.
  // Needed because some deps import 'fs' (without protocol) rather than 'node:fs'.
  packages: 'external',
  // Surface source locations in error messages during the build step.
  sourcemap: 'external',
  sourcesContent: false,
  logLevel: 'info',
});
