/**
 * The save of a settings dialog (`useDialogSave`): one at a time, closing the
 * dialog when it succeeds and keeping it open with the reason when it does not.
 *
 * Rendered once on the server to get hold of the function; what is checked is
 * what it does with the calls it is given, not what the dialog looks like.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  canReturnFocusTo,
  useDialogSave,
  useSingleFlight,
} from '../src/renderer/components/settings/SettingsDialogFrame';

type Result = { ok: true } | { ok: false; error: string };

function setup() {
  const onClose = vi.fn();
  let save: ReturnType<typeof useDialogSave>['save'] | null = null;
  function Probe() {
    save = useDialogSave(onClose, 'fallback').save;
    return null;
  }
  renderToString(createElement(Probe));
  if (!save) throw new Error('hook did not render');
  return { onClose, save: save as ReturnType<typeof useDialogSave>['save'] };
}

/** A call that stays open until the test settles it. */
function pendingCall() {
  let settle: (result: Result) => void = () => {};
  const call = vi.fn(
    () =>
      new Promise<Result>((resolve) => {
        settle = resolve;
      })
  );
  return { call, settle: (result: Result) => settle(result) };
}

describe('an action that must not run twice at once', () => {
  function runner() {
    let runOnce: ReturnType<typeof useSingleFlight> | null = null;
    function Probe() {
      runOnce = useSingleFlight();
      return null;
    }
    renderToString(createElement(Probe));
    return runOnce as unknown as ReturnType<typeof useSingleFlight>;
  }

  it('ignores a request made while one is on its way, as confirming a delete twice would be', async () => {
    const runOnce = runner();
    let finish: () => void = () => {};
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const second = vi.fn(async () => {});

    const running = runOnce(first);
    await runOnce(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    finish();
    await running;
    await runOnce(second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('accepts the next request after one that failed', async () => {
    const runOnce = runner();

    await expect(
      runOnce(async () => {
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');

    const next = vi.fn(async () => {});
    await runOnce(next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('where focus goes when a settings dialog closes', () => {
  it('is remembered before the dialog takes focus for its own first field', () => {
    // Focus handling needs a browser, so this is read from the source. The
    // dialog's first field has `autoFocus`, which React applies before any
    // effect runs: an effect that asked "what has focus?" would get that field
    // and hand focus back to something that is being removed.
    const frame = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/settings/SettingsDialogFrame.tsx'),
      'utf8'
    );
    const effectStart = frame.indexOf('useEffect(() => {');

    const capture = frame.indexOf('const openerRef = useRef<HTMLElement | null>(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(effectStart);
    expect(frame.slice(capture, effectStart)).toContain('document.activeElement');
    expect(frame).toContain('opener.focus();');
  });

  /** An element as the rule sees it: by how many boxes it is drawn as. */
  function element(boxes: number) {
    return { getClientRects: () => ({ length: boxes }) as DOMRectList };
  }

  it('goes back to the button that opened the dialog while that button can be seen', () => {
    expect(canReturnFocusTo(element(1))).toBe(true);
    // Text that wraps is drawn as more than one box.
    expect(canReturnFocusTo(element(2))).toBe(true);
  });

  it('does not go to a button in a hidden tab', () => {
    // The panel moved to another tab and closed the dialog. The tab that held
    // the opener is still on the page, but nothing in it is drawn. A button
    // that has left the page altogether is not drawn either.
    expect(canReturnFocusTo(element(0))).toBe(false);
  });

  it('does not go to nothing', () => {
    expect(canReturnFocusTo(null)).toBe(false);
  });

  it('asks that question before it hands focus back', () => {
    const frame = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/settings/SettingsDialogFrame.tsx'),
      'utf8'
    );
    expect(frame).toMatch(/if \(opener && canReturnFocusTo\(opener\)\) \{\s+opener\.focus\(\);/);
    // And nowhere without asking.
    expect(frame.match(/opener\??\.focus\(\)/g)).toHaveLength(1);
  });
});

describe('Enter in a settings dialog', () => {
  // Nothing here can press a key, so what makes Enter save is read from the
  // source: a real form, whose submit button is the dialog's Save.
  const read = (file: string) =>
    fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');

  it('is a form submit, which the browser sends for Enter in any of its fields', () => {
    const frame = read('settings/SettingsDialogFrame.tsx');
    expect(frame).toContain('<form noValidate onSubmit={handleSubmit}');
    // The form goes nowhere, and its submit stays inside the dialog.
    const handler = frame.slice(
      frame.indexOf('const handleSubmit'),
      frame.indexOf('const openerRef')
    );
    expect(handler).toContain('event.preventDefault();');
    expect(handler).toContain('event.stopPropagation();');
    expect(handler).toContain('if (!busyRef.current)');
  });

  it('saves through the one submit button, in both dialogs', () => {
    const parts = read('settings/CredentialDialogParts.tsx');
    expect(parts.match(/type="submit"/g)).toHaveLength(1);

    for (const dialog of ['CustomEndpointDialog.tsx', 'ProviderConfigDialog.tsx']) {
      const source = read(dialog);
      expect(source, dialog).toContain('onSubmit={form.submit}');
      expect(source, dialog).toContain('<DialogFooterButtons');
    }
  });

  it('leaves every other button in a dialog as a plain button', () => {
    // A button with no type inside a form submits it. One of these would save
    // the dialog on a click meant to pick a protocol or run a check.
    for (const file of [
      'CustomEndpointFields.tsx',
      'ProviderCredentialFields.tsx',
      'ProviderGuidance.tsx',
      'ApiDiagnosticsPanel.tsx',
      'settings/CredentialDialogParts.tsx',
      'settings/SettingsDialogFrame.tsx',
    ]) {
      // Comments talk about buttons too; only the markup counts.
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const buttons = source.match(/<button\b/g) ?? [];
      const typed = source.match(/\btype="(?:button|submit)"/g) ?? [];
      expect(buttons.length, file).toBeGreaterThan(0);
      expect(typed, file).toHaveLength(buttons.length);
    }
  });
});

describe('saving from a settings dialog', () => {
  it('ignores a second request while the first is on its way', async () => {
    const { save, onClose } = setup();
    const first = pendingCall();
    const second = pendingCall();

    const running = save(first.call);
    await save(second.call);

    expect(first.call).toHaveBeenCalledTimes(1);
    expect(second.call).not.toHaveBeenCalled();

    first.settle({ ok: true });
    await running;
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open when the save is refused, and accepts another try', async () => {
    const { save, onClose } = setup();

    await save(async () => ({ ok: false, error: 'An endpoint with this address already exists' }));
    expect(onClose).not.toHaveBeenCalled();

    const retry = vi.fn(async (): Promise<Result> => ({ ok: true }));
    await save(retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('survives a call that throws, and accepts another try', async () => {
    const { save, onClose } = setup();

    await expect(
      save(async () => {
        throw new Error('bridge is gone');
      })
    ).resolves.toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();

    await save(async () => ({ ok: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
