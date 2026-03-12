import { useTranslation } from 'react-i18next';
import {
  Loader2,
  CheckCircle,
  XCircle,
  MinusCircle,
  Circle,
  Stethoscope,
} from 'lucide-react';
import type {
  DiagnosticResult,
  DiagnosticStep,
  DiagnosticStepStatus,
} from '../types';

interface ApiDiagnosticsPanelProps {
  result: DiagnosticResult | null;
  isRunning: boolean;
  onRunDiagnostics: () => void;
  disabled?: boolean;
}

const STEP_NAME_FALLBACKS: Record<string, string> = {
  dns: 'DNS 解析',
  tcp: 'TCP 连接',
  tls: 'TLS 握手',
  auth: 'API 认证',
  model: '模型验证',
};

function StatusIcon({ status }: { status: DiagnosticStepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-accent animate-spin" />;
    case 'ok':
      return <CheckCircle className="w-4 h-4 text-success" />;
    case 'fail':
      return <XCircle className="w-4 h-4 text-error" />;
    case 'skip':
      return <MinusCircle className="w-4 h-4 text-text-muted" />;
    case 'pending':
    default:
      return <Circle className="w-4 h-4 text-text-muted" />;
  }
}

function StepRow({ step }: { step: DiagnosticStep }) {
  const { t } = useTranslation();
  const label =
    t(`api.diagnostic.step.${step.name}`, '') || STEP_NAME_FALLBACKS[step.name] || step.name;

  // Resolve fix key from backend (format: "key" or "key:param")
  const fixText = (() => {
    if (!step.fix) return '';
    const [key, ...paramParts] = step.fix.split(':');
    const param = paramParts.join(':'); // rejoin in case param itself has colons
    const i18nKey = `api.diagnostic.fix.${key}`;
    const resolved = t(i18nKey, { host: param, model: param, defaultValue: '' });
    return resolved || step.fix;
  })();

  return (
    <div className="relative pl-6 pb-4 last:pb-0">
      {/* progress line connector */}
      <div className="absolute left-[7px] top-0 bottom-0 w-px bg-border last:hidden" />
      {/* icon dot */}
      <div className="absolute left-0 top-0.5">
        <StatusIcon status={step.status} />
      </div>
      {/* content */}
      <div className="ml-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{label}</span>
          {step.latencyMs !== undefined && step.status !== 'pending' && (
            <span className="text-xs text-text-muted">{step.latencyMs} ms</span>
          )}
        </div>
        {step.status === 'fail' && (step.error || step.fix) && (
          <div className="mt-1.5 rounded-lg bg-error/10 border border-error/20 px-3 py-2 text-xs">
            {step.error && <p className="text-error">{step.error}</p>}
            {fixText && <p className="mt-1 text-text-secondary">{fixText}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ApiDiagnosticsPanel({
  result,
  isRunning,
  onRunDiagnostics,
  disabled = false,
}: ApiDiagnosticsPanelProps) {
  const { t } = useTranslation();
  const showSteps = result !== null;

  // When running but no result yet, show placeholder pending steps
  const PENDING_STEP_NAMES = ['dns', 'tcp', 'tls', 'auth', 'model'] as const;
  const placeholderSteps: DiagnosticStep[] = PENDING_STEP_NAMES.map((name) => ({
    name,
    status: 'pending' as const,
  }));
  const displaySteps = result?.steps ?? (isRunning ? placeholderSteps : []);

  return (
    <div className="space-y-3">
      {/* Diagnose button */}
      <button
        type="button"
        onClick={onRunDiagnostics}
        disabled={disabled || isRunning}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl
          bg-accent text-white text-sm font-medium
          hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors"
      >
        {isRunning ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Stethoscope className="w-4 h-4" />
        )}
        {t('api.diagnostic.runDiagnostics', 'Diagnose Connection')}
      </button>

      {/* Step list */}
      {(showSteps || isRunning) && (
        <div className="rounded-xl bg-background border border-border p-4">
          <div className="relative">
            {displaySteps.map((step) => (
              <StepRow key={step.name} step={step} />
            ))}
          </div>

          {/* Overall summary */}
          {result && !isRunning && (
            <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-sm">
              <span
                className={result.overallOk ? 'text-success font-medium' : 'text-error font-medium'}
              >
                {result.overallOk
                  ? t('api.diagnostic.overallSuccess', { ms: result.totalLatencyMs })
                  : t('api.diagnostic.overallFail', {
                      step:
                        t(`api.diagnostic.step.${result.failedAt}`, '') ||
                        STEP_NAME_FALLBACKS[result.failedAt ?? ''] ||
                        result.failedAt,
                    })}
              </span>
              <span className="text-text-muted text-xs">{result.totalLatencyMs} ms</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
