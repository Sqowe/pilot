import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

import { buildScreenInterpretVisionQuestion, isScreenInterpretationPrompt } from '../src/main/openai/screen-interpret-intent';
import { sanitizeScreenInterpretationAnswer } from '../src/main/openai/screen-interpret-output';

describe('CodexCliRunner screen interpretation intent helpers', () => {
  it('matches Chinese screenshot + interpretation prompt', () => {
    expect(isScreenInterpretationPrompt('截图 并为我解读屏幕信息')).toBe(true);
  });

  it('matches English screenshot + interpretation prompt', () => {
    expect(isScreenInterpretationPrompt('Please take a screenshot and describe what is on screen')).toBe(true);
  });

  it('does not match screenshot-only prompt', () => {
    expect(isScreenInterpretationPrompt('帮我截图一下')).toBe(false);
  });

  it('builds a structured vision question with original prompt', () => {
    const question = buildScreenInterpretVisionQuestion('截图 并为我解读屏幕信息');
    expect(question).toContain('用户原始请求');
    expect(question).toContain('截图 并为我解读屏幕信息');
    expect(question).toContain('1. 当前可见的应用或窗口');
  });

  it('deduplicates repeated screen report blocks', () => {
    const repeated = `下面是基于截图的详细解读：\n\n### 1) 当前可见\n内容A\n\n### 2) 关键文本\n内容B\n\n下面是基于截图的详细解读：\n\n### 1) 当前可见\n内容A\n\n### 2) 关键文本\n内容B`;
    const sanitized = sanitizeScreenInterpretationAnswer(repeated);
    expect(sanitized).toContain('下面是基于截图的详细解读');
    expect(sanitized.split('下面是基于截图的详细解读').length - 1).toBe(1);
  });

  it('strips operation success judgment block from answer', () => {
    const raw = `下面是解读结果。\n\n**Operation Success Judgment:**\n- Status: SUCCESS\n- Reason: looks good`;
    const sanitized = sanitizeScreenInterpretationAnswer(raw);
    expect(sanitized).toBe('下面是解读结果。');
  });
});
