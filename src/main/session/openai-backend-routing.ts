export type OpenAIBackendRoute = 'codex-cli' | 'responses-fallback';

export interface OpenAIBackendRouteInput {
  hasLocalCodexLogin: boolean;
  apiKey?: string;
  forceResponsesFallback?: boolean;
}

export function selectOpenAIBackendRoute(input: OpenAIBackendRouteInput): OpenAIBackendRoute {
  const hasApiKey = Boolean(input.apiKey?.trim());
  if (input.forceResponsesFallback && hasApiKey) {
    return 'responses-fallback';
  }
  if (input.hasLocalCodexLogin) {
    return 'codex-cli';
  }
  if (hasApiKey) {
    return 'responses-fallback';
  }
  return 'codex-cli';
}
