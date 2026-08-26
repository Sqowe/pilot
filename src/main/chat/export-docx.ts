/**
 * Chat Export — DOCX
 *
 * Converts the shared HTML output to a Word (.docx) buffer via
 * @turbodocx/html-to-docx. Pure JS, no native modules.
 */

import { type Message, type Session, type ExportOptions } from './export-common';
import { serializeMessagesToHtml } from './export-html';

/**
 * Serialize messages to a DOCX buffer.
 * Returns a Node.js Buffer ready to write to disk.
 */
export async function serializeMessagesToDocx(
  messages: Message[],
  session: Session,
  options: ExportOptions
): Promise<Buffer> {
  const html = await serializeMessagesToHtml(messages, session, options);

  // Dynamic import keeps the heavy dependency out of the main-process startup
  // path. We support both default and named export shapes to guard against
  // version/build differences in @turbodocx/html-to-docx.
  const mod = await import('@turbodocx/html-to-docx');
  type HtmlToDocxFn = (...args: unknown[]) => Promise<unknown>;
  const HtmlToDocx = ((mod as { default?: unknown }).default ??
    (mod as { HtmlToDocx?: unknown }).HtmlToDocx ??
    (mod as { convert?: unknown }).convert) as HtmlToDocxFn | undefined;

  if (typeof HtmlToDocx !== 'function') {
    throw new Error(
      '@turbodocx/html-to-docx did not export a callable function (checked default, HtmlToDocx, convert)'
    );
  }

  const result = await HtmlToDocx(html, undefined, {
    title: session.title || 'Untitled Chat',
    creator: 'Open Cowork',
    // Standard A4 margins (twips: 1440 twips = 1 inch)
    margins: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
  });

  // In Node.js the library returns ArrayBuffer or an ArrayBufferView
  // (e.g. Uint8Array/Buffer). Handle both correctly, respecting byteOffset
  // and byteLength for views to avoid corrupt DOCX output.
  if (result instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(result));
  }
  if (ArrayBuffer.isView(result)) {
    const view = result as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(
    `@turbodocx/html-to-docx returned unexpected type: ${Object.prototype.toString.call(result)}`
  );
}
