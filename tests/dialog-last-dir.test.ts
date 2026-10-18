import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastDialogDir, rememberDialogSelection } from '../src/main/utils/dialog-last-dir';

// Since Electron 43 a dialog without defaultPath always opens in Downloads, so
// each dialog offers the folder of its own last pick.
describe('dialog-last-dir', () => {
  it('has no folder before the first pick', () => {
    expect(lastDialogDir('never-used')).toBeUndefined();
  });

  it('offers the folder of the first picked file', () => {
    const a = path.join(path.sep, 'work', 'notes', 'a.md');
    const b = path.join(path.sep, 'other', 'b.md');
    rememberDialogSelection('files', [a, b]);
    expect(lastDialogDir('files')).toBe(path.dirname(a));
  });

  it('opens a folder picker at the parent of the picked folder', () => {
    const picked = path.join(path.sep, 'work', 'project');
    rememberDialogSelection('folder', [picked]);
    expect(lastDialogDir('folder')).toBe(path.join(path.sep, 'work'));
  });

  it('keeps the previous folder when nothing was picked', () => {
    const first = path.join(path.sep, 'keep', 'x.zip');
    rememberDialogSelection('archive', [first]);
    rememberDialogSelection('archive', []);
    expect(lastDialogDir('archive')).toBe(path.dirname(first));
  });

  it('keeps each purpose separate', () => {
    rememberDialogSelection('one', [path.join(path.sep, 'p1', 'f')]);
    rememberDialogSelection('two', [path.join(path.sep, 'p2', 'f')]);
    expect(lastDialogDir('one')).toBe(path.join(path.sep, 'p1'));
    expect(lastDialogDir('two')).toBe(path.join(path.sep, 'p2'));
  });
});
