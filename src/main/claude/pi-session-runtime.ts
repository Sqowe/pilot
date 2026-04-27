import { createHash } from 'node:crypto';

export interface PiSessionRuntimeSignatureInput {
  configProvider?: string;
  customProtocol?: string;
  modelProvider?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  effectiveCwd?: string;
  apiKey?: string;
  /**
   * Stable fingerprint of the workspace instructions file content (if any).
   * Changes here force session recreation so an edited CLAUDE.md / AGENTS.md
   * / etc. takes effect on the next query without leaving a stale prompt
   * tail baked into a cached pi session.
   */
  workspaceInstructionsFingerprint?: string;
}

function normalizeText(value: string | undefined): string {
  return value?.trim() || '';
}

function fingerprintSecret(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  return createHash('sha256').update(normalized).digest('hex');
}

export function buildPiSessionRuntimeSignature(input: PiSessionRuntimeSignatureInput): string {
  return JSON.stringify({
    configProvider: normalizeText(input.configProvider),
    customProtocol: normalizeText(input.customProtocol),
    modelProvider: normalizeText(input.modelProvider),
    modelApi: normalizeText(input.modelApi),
    modelBaseUrl: normalizeText(input.modelBaseUrl).replace(/\/+$/, ''),
    effectiveCwd: normalizeText(input.effectiveCwd),
    apiKeyFingerprint: fingerprintSecret(input.apiKey),
    workspaceInstructionsFingerprint: normalizeText(input.workspaceInstructionsFingerprint),
  });
}
