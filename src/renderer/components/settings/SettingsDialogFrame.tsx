import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface SettingsDialogFrameProps {
  title: string;
  /** Called for the close button and for Escape. */
  onClose: () => void;
  /** Blocks closing while a save is on its way. */
  busy?: boolean;
  children: ReactNode;
  footer: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea';

type DialogSaveResult = { ok: true } | { ok: false; error: string };

/**
 * Runs one action at a time: a request made while one is on its way is ignored.
 *
 * A ref, not state, so the second request is refused even if it arrives before
 * the button that sent it has been rendered as disabled.
 */
export function useSingleFlight() {
  const inFlightRef = useRef(false);
  return useCallback(async (action: () => Promise<void>) => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    try {
      await action();
    } finally {
      inFlightRef.current = false;
    }
  }, []);
}

/**
 * The save of a dialog: one at a time, closing the dialog when it succeeds and
 * showing the reason next to the fields when it does not.
 */
export function useDialogSave(onClose: () => void, fallbackError: string) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const runOnce = useSingleFlight();

  const save = useCallback(
    (call: () => Promise<DialogSaveResult>) =>
      runOnce(async () => {
        setIsSaving(true);
        setError('');
        try {
          const result = await call();
          if (result.ok) {
            onClose();
          } else {
            setError(result.error);
          }
        } catch {
          setError(fallbackError);
        } finally {
          setIsSaving(false);
        }
      }),
    [fallbackError, onClose, runOnce]
  );

  return { isSaving, error, setError, save };
}

/**
 * The frame of a dialog opened from a Settings tab: backdrop, title, a
 * scrolling body and a footer for its buttons.
 *
 * Rendered into `document.body` so the Settings panel's own scrolling and
 * clipping cannot cut it off. Escape closes it, Tab stays inside it, and focus
 * returns to where it was when it closes. It does not close on a click outside:
 * a dialog here usually holds a key somebody has just typed.
 */
export function SettingsDialogFrame({
  title,
  onClose,
  busy = false,
  children,
  footer,
}: SettingsDialogFrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Read through refs so the effect below runs once per dialog. Re-running it
  // on every render would hand focus back and forth while the user types.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // What had focus when the dialog was opened — the button that opened it.
  // Read during the first render: by the time an effect runs, the field with
  // `autoFocus` inside the dialog already has it, and focus would be "returned"
  // to a field that is about to disappear.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );

  useEffect(() => {
    const opener = openerRef.current;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!busyRef.current) {
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) {
        return;
      }
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        // Everything is disabled while a save is on its way. Tab still must not
        // walk out of the dialog into the page behind it.
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      opener?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex flex-col w-full max-w-lg max-h-[85vh] mx-4 rounded-2xl border border-border-muted bg-background shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
          <h3 id={titleId} className="text-[15px] font-semibold text-text-primary">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-2 space-y-4">{children}</div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-muted">
          {footer}
        </div>
      </div>
    </div>,
    document.body
  );
}
