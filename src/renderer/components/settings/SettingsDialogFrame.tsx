import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface SettingsDialogFrameProps {
  title: string;
  /** Called for the close button and for Escape. */
  onClose: () => void;
  /**
   * Called when the dialog is submitted: its `type="submit"` button, or Enter
   * in one of its fields. Given this, the body and footer are one form.
   */
  onSubmit?: () => void;
  /** Blocks closing and submitting while a save is on its way. */
  busy?: boolean;
  children: ReactNode;
  footer: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea';

type DialogSaveResult = { ok: true } | { ok: false; error: string };

/**
 * Whether focus can be handed back to an element: it is still drawn.
 *
 * A dialog can be closed by the panel moving to another tab. The button that
 * opened it is then inside a hidden tab, and focus must not be sent there. An
 * element in a hidden tab has no box on the page — and neither has one that has
 * left the page altogether, so the one question covers both.
 */
export function canReturnFocusTo(element: Pick<HTMLElement, 'getClientRects'> | null): boolean {
  return Boolean(element && element.getClientRects().length > 0);
}

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
 *
 * With `onSubmit` the body and footer are a real `<form>`, so Enter in a field
 * saves by the browser's own rule: not while the submit button is disabled,
 * and not for the Enter that finishes a character being composed.
 */
export function SettingsDialogFrame({
  title,
  onClose,
  onSubmit,
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Never let the browser send the form anywhere. And although the dialog is
    // drawn into the page body, its events still travel up the React tree — a
    // submit here must not reach a form that happens to sit above the tab.
    event.preventDefault();
    event.stopPropagation();
    if (!busyRef.current) {
      onSubmit?.();
    }
  };

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
      // Only to a button that can still be seen. Closed by a change of tab, the
      // opener sits in a hidden tab; focus is then left where the page puts it.
      if (opener && canReturnFocusTo(opener)) {
        opener.focus();
      }
    };
  }, []);

  const content = (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-2 space-y-4">{children}</div>
      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-muted">
        {footer}
      </div>
    </>
  );

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
        {onSubmit ? (
          <form noValidate onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>,
    document.body
  );
}
