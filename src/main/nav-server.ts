import * as http from 'http';
import { URL } from 'url';
import { BrowserWindow } from 'electron';

const PORT = 19888;
const HOST = '127.0.0.1';
const VALID_TABS = new Set([
  'api', 'sandbox', 'credentials', 'connectors',
  'skills', 'schedule', 'remote', 'logs', 'language',
]);

let server: http.Server | null = null;

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Lightweight HTTP server for CLI-driven UI navigation.
 * Allows CC/Codex to navigate the app to different pages via curl.
 *
 * Routes:
 *   GET /navigate?page=welcome
 *   GET /navigate?page=settings&tab=api
 *   GET /navigate?page=session&id=xxx
 *   GET /status
 */
export function startNavServer(getMainWindow: () => BrowserWindow | null): void {
  if (server) return;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/navigate') {
      const page = url.searchParams.get('page');
      const tab = url.searchParams.get('tab') || undefined;
      const sessionId = url.searchParams.get('id') || undefined;

      if (!page || !['welcome', 'settings', 'session'].includes(page)) {
        return json(res, 400, { ok: false, error: 'Invalid page. Use: welcome, settings, session' });
      }

      if (page === 'settings' && tab && !VALID_TABS.has(tab)) {
        return json(res, 400, {
          ok: false,
          error: `Invalid tab "${tab}". Use: ${[...VALID_TABS].join(', ')}`,
        });
      }

      if (page === 'session' && !sessionId) {
        return json(res, 400, { ok: false, error: 'session page requires id param' });
      }

      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        return json(res, 503, { ok: false, error: 'No active window' });
      }

      win.webContents.send('server-event', {
        type: 'navigate.to',
        payload: { page, tab, sessionId },
      });

      return json(res, 200, { ok: true, navigated: { page, tab, sessionId } });
    }

    if (pathname === '/status') {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        return json(res, 503, { ok: false, error: 'No active window' });
      }

      try {
        const state = await win.webContents.executeJavaScript(
          `JSON.stringify(window.__getNavStatus ? window.__getNavStatus() : {})`
        );
        const parsed = JSON.parse(state);
        let currentPage = 'welcome';
        if (parsed.showSettings) currentPage = 'settings';
        else if (parsed.activeSessionId) currentPage = 'session';

        return json(res, 200, {
          ok: true,
          page: currentPage,
          activeSessionId: parsed.activeSessionId,
          sessionCount: parsed.sessionCount,
        });
      } catch (err) {
        console.error('[NavServer] /status error:', err);
        return json(res, 500, { ok: false, error: 'Failed to read renderer state' });
      }
    }

    json(res, 404, { ok: false, error: 'Not found. Use /navigate or /status' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[NavServer] Listening on http://${HOST}:${PORT}`);
  });

  // Don't let the server prevent app exit
  server.unref();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[NavServer] Port ${PORT} already in use, skipping`);
    } else {
      console.error('[NavServer] Failed to start:', err);
    }
    server = null;
  });
}

export function stopNavServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
