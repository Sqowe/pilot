/**
 * @module main/migration/bootstrap
 *
 * Runtime bootstrap that MUST run before any electron-store-backed module is
 * imported. Stores (ConfigStore, mcp-config-store, remote-config-store, …)
 * resolve `app.getPath('userData')` in their constructors at import time, so we
 * (1) fix the app name — which determines the userData directory — and (2) run
 * the legacy-data migration here, then `index.ts` imports the rest.
 *
 * `index.ts` imports this module FIRST so ES-module/CJS evaluation order
 * guarantees this side effect precedes the first `userData` access.
 */
import { app } from 'electron';
import * as path from 'path';
import { migrateLegacyData } from './migrate-legacy-data';

// Force a deterministic, lowercase userData directory (`<appData>/sqowe-pilot`)
// across dev and packaged builds. This must precede the first
// `app.getPath('userData')`, and it also matches the data-dir paths hardcoded
// by the MCP child processes (mcp-logger.ts, gui-operate-server.ts), which run
// outside Electron and cannot call `app.getPath`.
app.setName('sqowe-pilot');

try {
  const result = migrateLegacyData({
    newDir: app.getPath('userData'),
    legacyDir: path.join(app.getPath('appData'), 'open-cowork'),
    version: app.getVersion(),
  });
  if (result.outcome === 'migrated') {
    // eslint-disable-next-line no-console
    console.log(
      `[Migration] Adopted legacy Open Cowork data (${result.filesCopied} files) into ${app.getPath(
        'userData'
      )}`
    );
  }
} catch (err) {
  // A migration failure must never block startup; the app continues with a
  // clean (empty) profile, and the legacy data remains intact for retry.
  // eslint-disable-next-line no-console
  console.error('[Migration] Legacy data migration failed; continuing with a clean profile:', err);
}
