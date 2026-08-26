/**
 * Chat Export — Format Router
 *
 * Single entry point for all chat export formats. Shows one native save dialog
 * with all supported format filters, then dispatches on the chosen file extension.
 *
 * Format is a parameter of the export, not a separate action — adding a new
 * format only requires a new filter entry + a new dispatch case here.
 *
 * Dispatch map:
 *   .md   → serializeMessagesToMarkdown → write UTF-8 string
 *   .docx → serializeMessagesToDocx     → write Buffer
 *   .pdf  → serializeMessagesToPdf      → write Buffer
 */

import * as path from 'path';
import * as fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { log, logError } from '../utils/logger';
import {
  type ExportRequest,
  type ExportResult,
  type ExportFormat,
  type Message,
  type Session,
  type ExportOptions,
  DEFAULT_OPTIONS,
  sanitizeFilename,
  filterExportableMessages,
} from './export-common';

export type { ExportRequest, ExportResult };

/**
 * Export a chat session to a file chosen by the user via the native save dialog.
 * The dialog lists all supported formats; the chosen extension drives dispatch.
 */
export async function exportChat(
  request: ExportRequest,
  getSession: (sessionId: string) => Session | undefined,
  getMessages: (sessionId: string) => Message[]
): Promise<ExportResult> {
  try {
    // --- 1. Fetch session ---
    const session = getSession(request.sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    // --- 2. Fetch + filter messages ---
    let messages = getMessages(request.sessionId);
    if (!messages || messages.length === 0) {
      return { success: false, error: 'No messages to export' };
    }

    // Filter by message IDs if specified
    if (request.messageIds && request.messageIds.length > 0) {
      const idSet = new Set(request.messageIds);
      const beforeCount = messages.length;
      messages = messages.filter((m) => idSet.has(m.id));
      log(
        '[ChatExport] Filtered by messageIds:',
        'requested:',
        request.messageIds.length,
        'matched:',
        messages.length,
        'total in DB:',
        beforeCount
      );
      if (messages.length < request.messageIds.length) {
        const dbIds = new Set(messages.map((m) => m.id));
        const missing = request.messageIds.filter((id) => !dbIds.has(id));
        log('[ChatExport] Missing IDs (not in DB):', missing);
      }
    }

    // --- 3. Merge options ---
    const options: ExportOptions = { ...DEFAULT_OPTIONS, ...request.options };

    // Strip partial/streaming, system messages, and messages with no visible
    // content under the chosen options. This keeps message counts in sync with
    // what serializers actually emit.
    messages = filterExportableMessages(messages, options);

    if (messages.length === 0) {
      return { success: false, error: 'No messages to export' };
    }

    // --- 4. Show ONE save dialog with all format filters ---
    const titleSlug = sanitizeFilename(session.title || 'chat');
    const dateStr = new Date().toISOString().split('T')[0];

    // Use the requested format (from UI) to pre-select the correct filter and
    // build a sensible default filename. Defaults to 'md' when not specified.
    const preferredFormat: ExportFormat = request.format ?? 'md';
    const formatExtMap: Record<ExportFormat, string> = {
      md: 'md',
      docx: 'docx',
      pdf: 'pdf',
    };
    const preferredExt = formatExtMap[preferredFormat];

    // Order filters so the preferred format appears first (pre-selected)
    const allFilters = [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Word Document', extensions: ['docx'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ];
    const preferredFilter = allFilters.find((f) => f.extensions[0] === preferredExt);
    const otherFilters = allFilters.filter((f) => f.extensions[0] !== preferredExt);
    const orderedFilters = preferredFilter ? [preferredFilter, ...otherFilters] : allFilters;

    const dialogOptions = {
      title: 'Export Chat',
      defaultPath: `${titleSlug}-${dateStr}.${preferredExt}`,
      filters: orderedFilters,
    };

    const mainWindow = BrowserWindow.getFocusedWindow();
    const dialogResult = mainWindow
      ? await dialog.showSaveDialog(mainWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (dialogResult.canceled || !dialogResult.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    // Normalise the file path: if the user typed no extension, append the
    // preferred format extension so we never silently write the wrong format.
    // Electron does not reliably auto-append extensions on all platforms.
    let filePath = dialogResult.filePath;
    if (!path.extname(filePath)) {
      filePath = `${filePath}.${preferredExt}`;
    }

    // --- 5. Dispatch on extension ---
    const resolvedExt = path.extname(filePath).toLowerCase();
    switch (resolvedExt) {
      case '.md': {
        const { serializeMessagesToMarkdown } = await import('./export-markdown');
        const markdown = serializeMessagesToMarkdown(messages, session, options);
        await fs.promises.writeFile(filePath, markdown, 'utf-8');
        break;
      }

      case '.docx': {
        const { serializeMessagesToDocx } = await import('./export-docx');
        const docxBuffer = await serializeMessagesToDocx(messages, session, options);
        await fs.promises.writeFile(filePath, docxBuffer);
        break;
      }

      case '.pdf': {
        const { serializeMessagesToPdf } = await import('./export-pdf');
        const pdfBuffer = await serializeMessagesToPdf(messages, session, options);
        await fs.promises.writeFile(filePath, pdfBuffer);
        break;
      }

      default: {
        // Unknown extension typed manually — fall back to markdown
        log('[ChatExport] Unknown extension', resolvedExt, '— falling back to markdown');
        const { serializeMessagesToMarkdown } = await import('./export-markdown');
        const markdown = serializeMessagesToMarkdown(messages, session, options);
        await fs.promises.writeFile(filePath, markdown, 'utf-8');
        break;
      }
    }

    log('[ChatExport] Exported chat to:', filePath);
    return { success: true, path: filePath };
  } catch (error) {
    logError('[ChatExport] Export failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
