import { useRef, useState } from 'react';
import { AlertTriangle, Info, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface CommonProviderSetupView {
  id: string;
  name: string;
  protocolLabel: string;
  baseUrl: string;
  exampleModel: string;
  notes: string;
  isDetected?: boolean;
}

interface GuidanceInlineHintProps {
  text?: string;
  tone?: 'info' | 'warning';
}

export function GuidanceInlineHint({ text, tone = 'info' }: GuidanceInlineHintProps) {
  if (!text) {
    return null;
  }

  const Icon = tone === 'warning' ? AlertTriangle : Info;
  const toneClass =
    tone === 'warning'
      ? 'border-warning/30 bg-warning/10 text-warning'
      : 'border-border-subtle bg-background/60 text-text-secondary';

  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${toneClass}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span className="leading-5">{text}</span>
    </div>
  );
}

interface CommonProviderSetupsCardProps {
  setups: CommonProviderSetupView[];
  onApplySetup: (setupId: string) => void;
  disabled?: boolean;
}

const APPLY_BUTTON_CLASS =
  'rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed';

function DetectedBadge() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-accent">
      {t('api.guidance.detectedBadge')}
    </span>
  );
}

const SUMMARY_CLASS =
  'flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-text-primary';

/** What the heading of the setups card says. */
function SetupsSummaryText() {
  const { t } = useTranslation();
  return (
    <>
      <span className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        {t('api.guidance.commonSetupsTitle')}
      </span>
      <span className="text-xs font-normal text-text-muted">
        {t('api.guidance.commonSetupsHint')}
      </span>
    </>
  );
}

/**
 * The setups as a list, each on a few short lines: a dialog is too narrow for
 * a column per field.
 *
 * It folds itself away once a setup is applied: what that filled in is in the
 * fields below, and with the list still open those would be several rows out
 * of sight. Focus goes to the list's heading, because the button that was just
 * pressed is folded away with the rest.
 */
function CommonProviderSetupsList({
  setups,
  onApplySetup,
  disabled = false,
}: CommonProviderSetupsCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);

  const apply = (setupId: string) => {
    onApplySetup(setupId);
    setOpen(false);
    summaryRef.current?.focus();
  };

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-border-subtle bg-background/40 px-3 py-3"
    >
      <summary ref={summaryRef} className={SUMMARY_CLASS}>
        <SetupsSummaryText />
      </summary>
      <ul className="mt-3 divide-y divide-border-subtle">
        {setups.map((setup) => (
          <li key={setup.id} className="flex items-start gap-3 py-2.5">
            <div className="flex-1 min-w-0 space-y-0.5 text-xs text-text-secondary">
              <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
                <span>{setup.name}</span>
                <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                  {setup.protocolLabel}
                </span>
                {setup.isDetected && <DetectedBadge />}
              </p>
              <p className="break-all font-mono text-[11px]">{setup.baseUrl}</p>
              <p>
                {t('api.guidance.columns.model')}:{' '}
                <span className="font-mono text-[11px]">{setup.exampleModel}</span>
              </p>
              <p className="leading-5 text-text-muted">{setup.notes}</p>
            </div>
            <button
              type="button"
              onClick={() => apply(setup.id)}
              disabled={disabled}
              className={`flex-shrink-0 ${APPLY_BUTTON_CLASS}`}
            >
              {t('api.guidance.apply')}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The setups card of the custom-endpoint fields. With nothing to offer, nothing is drawn. */
export function CommonProviderSetupsCard(props: CommonProviderSetupsCardProps) {
  if (props.setups.length === 0) {
    return null;
  }
  return <CommonProviderSetupsList {...props} />;
}
