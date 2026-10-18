/**
 * @module main/utils/dialog-last-dir
 *
 * Remembers where each file dialog last picked something.
 *
 * Since Electron 43 an open/save dialog without `defaultPath` always starts in
 * Downloads, and the OS no longer restores the folder the user last chose.
 * Each dialog passes its purpose; the folder holding the last selection is
 * offered as `defaultPath` next time, for as long as the app runs.
 */
import path from 'node:path';

const lastDirs = new Map<string, string>();

/** Folder to open the dialog for `purpose` in, or undefined before its first pick. */
export function lastDialogDir(purpose: string): string | undefined {
  return lastDirs.get(purpose);
}

/** Record a dialog's selection; a picked folder also opens at its parent next time. */
export function rememberDialogSelection(purpose: string, selected: readonly string[]): void {
  const first = selected[0];
  if (first) {
    lastDirs.set(purpose, path.dirname(first));
  }
}
