import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');

function readChatView() {
  return fs.readFileSync(chatViewPath, 'utf8');
}

describe('ChatView Claude-style layout', () => {
  it('uses a narrower conversation column shared by messages and composer', () => {
    const source = readChatView();
    expect(source).toContain('max-w-[920px]');
  });

  it('uses a quieter header treatment with Sqowe Pilot eyebrow and compact connector badge', () => {
    const source = readChatView();
    // Branding text moved to i18n; verify the layout structure remains
    expect(source).toContain('bg-background/88');
    expect(source).toContain('border-border-muted');
  });

  it('uses a softer rounded composer shell instead of the previous heavy input bar', () => {
    const source = readChatView();
    expect(source).toContain('rounded-[1.75rem]');
    expect(source).toContain('shadow-soft');
  });

  it('gives the composer text the full width, with the controls on a row below it', () => {
    const source = readChatView();
    const shell = source.indexOf('flex flex-col gap-2 p-3.5 rounded-[1.75rem]');
    const textarea = source.indexOf('<textarea', shell);
    const attach = source.indexOf('onClick={handleFileSelect}', shell);
    const configSet = source.indexOf("title={t('welcome.configSet')}", shell);
    const send = source.indexOf('<Send className', shell);
    expect(shell).toBeGreaterThan(-1);
    expect(textarea).toBeGreaterThan(shell);
    expect(attach).toBeGreaterThan(textarea);
    expect(configSet).toBeGreaterThan(attach);
    expect(send).toBeGreaterThan(configSet);
  });

  it('fades the message list out above the composer instead of drawing a line', () => {
    const source = readChatView();
    // The input area moves up over the end of the list; its top strip fades to the background
    // and lets the mouse through, and the list's bottom padding grows by the same 20px.
    expect(source).toContain('relative z-10 -mt-5 pt-5 pointer-events-none');
    expect(source).toContain(
      'absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-transparent to-background'
    );
    expect(source).toContain('pb-5 pointer-events-auto');
    expect(source).toContain('pt-8 pb-[3.25rem]');
    expect(source).not.toContain('border-t border-border-muted bg-background/92');
  });
});
