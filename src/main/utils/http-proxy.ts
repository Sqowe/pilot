/**
 * HTTP proxy env-var helpers for the main process.
 *
 * Semantics:
 * - Setting a proxy URL configures all four conventional env vars
 *   (HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy).
 * - Clearing the proxy (blank/undefined with force=true) restores each var to
 *   its initial value at module load time (i.e. what the shell provided), so
 *   "leave blank" truly means "inherit system proxy" immediately, not just on
 *   the next restart.
 * - On startup (force=false) we use ??= to avoid clobbering shell-set vars.
 *
 * Both uppercase and lowercase variants are set because different Node.js
 * libraries/runtimes read different forms.
 */

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
type ProxyVar = (typeof PROXY_VARS)[number];

/**
 * Snapshot of the proxy env vars at module load time (i.e. shell/OS values).
 * Used to restore the environment when the user clears the configured proxy.
 * Mutable so tests can override it via _overrideInitialProxyEnvForTest.
 */
const initialProxyEnv: Record<ProxyVar, string | undefined> = Object.fromEntries(
  PROXY_VARS.map((k) => [k, process.env[k]])
) as Record<ProxyVar, string | undefined>;

/**
 * Apply a configured HTTP proxy URL to process.env.
 *
 * @param httpProxy - The proxy URL from config (trimmed), or undefined/empty.
 * @param force     - When true (user-initiated change): unconditionally set or
 *                    restore proxy vars. When false (startup): use ??= to avoid
 *                    overwriting shell-provided values.
 */
export function applyConfigHttpProxy(httpProxy: string | undefined, force = false): void {
  const proxy = httpProxy?.trim();

  if (!proxy) {
    if (!force) return; // startup no-op: blank config = don't touch env
    // User explicitly cleared the proxy: restore to shell/OS initial values
    for (const k of PROXY_VARS) {
      const initial = initialProxyEnv[k];
      if (initial !== undefined) {
        process.env[k] = initial;
      } else {
        delete process.env[k];
      }
    }
    return;
  }

  if (force) {
    for (const k of PROXY_VARS) {
      process.env[k] = proxy;
    }
  } else {
    // Startup mode: apply config proxy only when the var is absent or empty.
    // Some environments set proxy vars to '' to mean "unset" — treat that as absent.
    for (const k of PROXY_VARS) {
      if (!process.env[k]) process.env[k] = proxy;
    }
  }
}

/**
 * Exposed for testing: replace the initial env snapshot.
 * @internal
 */
export function _overrideInitialProxyEnvForTest(
  overrides: Partial<Record<ProxyVar, string | undefined>>
): void {
  for (const k of PROXY_VARS) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      initialProxyEnv[k] = overrides[k];
    }
  }
}
