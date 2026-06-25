/**
 * @module main/migration/migrate-legacy-data
 *
 * Legacy data migration: Open Cowork -> Sqowe Pilot.
 *
 * When the app was renamed, `app.getPath('userData')` moved from
 * `<appData>/open-cowork` to `<appData>/sqowe-pilot`, which would orphan an
 * existing user's data. This module copies a fork user's data from the legacy
 * directory into the new one on first launch, losslessly. The encrypted config
 * decrypts transparently because the encryption seeds are intentionally
 * unchanged (see store-encryption.ts) and the file is copied byte-for-byte.
 *
 * This module is intentionally PURE (no electron import) so it can be unit
 * tested with a temp-dir harness. The runtime wiring — reading app paths and
 * calling `app.setName` — lives in `./bootstrap.ts`, which must run before any
 * electron-store-backed module is imported (those resolve `userData` in their
 * constructors at import time).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface MigrationInput {
  /** New userData dir, e.g. `<appData>/sqowe-pilot`. */
  newDir: string;
  /** Legacy userData dir, e.g. `<appData>/open-cowork`. */
  legacyDir: string;
  /** Current app version, recorded in the `.brand` marker. */
  version: string;
}

export type MigrationOutcome =
  | 'already-branded'
  | 'fresh-install-stamped'
  | 'clean-machine-stamped'
  | 'skipped-not-fork'
  | 'migrated';

export interface MigrationResult {
  outcome: MigrationOutcome;
  filesCopied: number;
}

const BRAND_FILE = '.brand';
const IDENTITY_FINGERPRINT = 'Sqowe Pilot';

/** Entries that are never copied (regenerated, or noise that wastes space). */
function shouldSkipEntry(name: string, topLevel: boolean): boolean {
  if (topLevel && name === 'logs') return true;
  if (/cache/i.test(name)) return true;
  return false;
}

/**
 * Is the legacy directory a Sqowe Pilot fork install (vs a pristine upstream
 * Open Cowork install)? Old `3.3.0-sqowe.N` builds did not persist their
 * version on disk, so the version string cannot be read retroactively. Instead
 * we fingerprint the Sqowe identity prompt the fork shipped to
 * `{userData}/prompts/identity.md`, plus the forward-compatible `.brand` marker
 * any sqowe build writes.
 */
export function isForkInstall(legacyDir: string): boolean {
  if (fs.existsSync(path.join(legacyDir, BRAND_FILE))) return true;
  const identityPath = path.join(legacyDir, 'prompts', 'identity.md');
  try {
    if (fs.existsSync(identityPath)) {
      return fs.readFileSync(identityPath, 'utf-8').includes(IDENTITY_FINGERPRINT);
    }
  } catch {
    // Unreadable identity file -> treat as not-fork. Safer to skip than to
    // adopt data we cannot positively identify as ours.
  }
  return false;
}

/**
 * Recursively copy `src` into `dest`, never overwriting an existing file and
 * skipping logs/cache. Returns the number of files copied. Symlinks and other
 * special entries are deliberately ignored.
 */
function copyTree(src: string, dest: string, topLevel: boolean): number {
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkipEntry(entry.name, topLevel)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copied += copyTree(srcPath, destPath, false);
    } else if (entry.isFile()) {
      if (fs.existsSync(destPath)) continue; // never overwrite
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }
  return copied;
}

function writeBrand(newDir: string, version: string, migratedFrom: string | null): void {
  fs.mkdirSync(newDir, { recursive: true });
  const brand = {
    product: 'sqowe-pilot',
    version,
    migratedFrom,
    migratedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(newDir, BRAND_FILE), JSON.stringify(brand, null, 2), 'utf-8');
}

/**
 * Perform the one-time migration. Idempotent: the `.brand` marker makes every
 * subsequent run a no-op. Copy (not move) — the legacy dir is left intact so a
 * rollback to an old build still works and the user is never at risk of loss.
 */
export function migrateLegacyData(input: MigrationInput): MigrationResult {
  const { newDir, legacyDir, version } = input;

  // 1. Already migrated, or a native sqowe install that has launched before.
  if (fs.existsSync(path.join(newDir, BRAND_FILE))) {
    return { outcome: 'already-branded', filesCopied: 0 };
  }

  // 2. A sqowe install that predates this migration code (config already lives
  //    in the new dir). Stamp and stop; there is nothing to adopt.
  if (fs.existsSync(path.join(newDir, 'config.json'))) {
    writeBrand(newDir, version, null);
    return { outcome: 'fresh-install-stamped', filesCopied: 0 };
  }

  // 3. No legacy directory at all -> clean machine.
  if (!fs.existsSync(legacyDir)) {
    writeBrand(newDir, version, null);
    return { outcome: 'clean-machine-stamped', filesCopied: 0 };
  }

  // 4. Legacy exists but is a pristine upstream Open Cowork install. Leave it
  //    untouched AND do not stamp `.brand` — we must not adopt foreign data,
  //    and a later real use of this profile will self-heal via case 2.
  if (!isForkInstall(legacyDir)) {
    return { outcome: 'skipped-not-fork', filesCopied: 0 };
  }

  // 5. Copy legacy fork data into the new dir (never overwriting).
  fs.mkdirSync(newDir, { recursive: true });
  const filesCopied = copyTree(legacyDir, newDir, true);

  // 6. Stamp the durable brand/identity marker.
  writeBrand(newDir, version, 'open-cowork');

  return { outcome: 'migrated', filesCopied };
}
