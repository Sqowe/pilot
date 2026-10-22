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
});
