/**
 * Chat Export — PDF
 *
 * Renders the shared HTML output to a PDF buffer via Electron's built-in
 * webContents.printToPDF(). Uses a locked-down offscreen BrowserWindow so
 * that injected <script>/onerror payloads in chat content (scraped pages,
 * tool results, etc.) cannot execute.
 *
 * Security model — see design doc §7:
 *   - javascript: false   — strongest mitigation; script never runs
 *   - sandbox: true       — Electron renderer sandbox (Chromium-level)
 *   - nodeIntegration: false / contextIsolation: true — no Node APIs reachable
 *   - loadFile on a temp .html — local only, no network navigation
 *   - destroy() + temp-file unlink in finally — nothing leaked
 *
 * The HTML is written to a temp file and loaded via loadFile() rather than a
 * data: URI: large chats (especially with inline images) would otherwise exceed
 * Chromium's navigation URL length limit and fail to render.
 *
 * NOTE: "sandbox" here refers ONLY to Electron's webPreferences.sandbox flag.
 * It is completely unrelated to Open Cowork's WSL2/Lima execution sandbox
 * (src/main/sandbox/), which is a separate, currently-disabled feature.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { type Message, type Session, type ExportOptions } from './export-common';
import { serializeMessagesToHtml } from './export-html';

/** Guard against a hung renderer never resolving load/print. */
const RENDER_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`PDF export timed out during ${label} (${ms}ms)`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Serialize messages to a PDF buffer.
 * Returns a Node.js Buffer ready to write to disk.
 */
export async function serializeMessagesToPdf(
  messages: Message[],
  session: Session,
  options: ExportOptions
): Promise<Buffer> {
  const html = await serializeMessagesToHtml(messages, session, options);

  const tmpFile = path.join(os.tmpdir(), `oc-export-${randomUUID()}.html`);
  await fs.promises.writeFile(tmpFile, html, 'utf-8');

  const win = new BrowserWindow({
    show: false, // offscreen — never displayed (UX, not security)
    webPreferences: {
      javascript: false, // strongest mitigation: injected <script>/onerror never runs
      sandbox: true, // Electron renderer sandbox (NOT the app's exec sandbox — see §7)
      nodeIntegration: false, // no require()/Node APIs reachable from the page
      contextIsolation: true, // page JS can't reach privileged contexts
    },
  });

  try {
    await withTimeout(win.loadFile(tmpFile), RENDER_TIMEOUT_MS, 'load');
    const pdfBuffer = await withTimeout(
      win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'default' },
      }),
      RENDER_TIMEOUT_MS,
      'printToPDF'
    );
    return Buffer.from(pdfBuffer);
  } finally {
    // Always tear down the hidden window/process and remove the temp file
    win.destroy();
    fs.promises.unlink(tmpFile).catch(() => {
      /* best-effort cleanup */
    });
  }
}
