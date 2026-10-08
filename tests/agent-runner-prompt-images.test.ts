import { describe, expect, it } from 'vitest';

import {
  findDroppedPromptImages,
  formatDroppedPromptImagesWarning,
} from '../src/main/claude/agent-runner-prompt-images';

// The exact line pi appends, from pi-coding-agent/dist/utils/image-process.js
const RESIZE_HINT = '[Image omitted: could not be resized below the inline image size limit.]';
const CONVERT_HINT = '[Image omitted: could not be converted to a supported inline image format.]';

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

describe('findDroppedPromptImages', () => {
  it('returns undefined when pi kept every image', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'look' }, image] };

    expect(findDroppedPromptImages(message, 1)).toBeUndefined();
  });

  it('returns undefined when no image was passed', () => {
    const message = { role: 'user', content: [{ type: 'text', text: `look\n\n${RESIZE_HINT}` }] };

    expect(findDroppedPromptImages(message, 0)).toBeUndefined();
  });

  it('reports the image pi dropped together with the reason pi appended to the text', () => {
    const message = { role: 'user', content: [{ type: 'text', text: `look\n\n${RESIZE_HINT}` }] };

    expect(findDroppedPromptImages(message, 1)).toEqual({
      dropped: 1,
      passed: 1,
      reasons: [RESIZE_HINT],
    });
  });

  it('counts only the missing images when some were kept', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: `look\n\n${CONVERT_HINT}` }, image, image],
    };

    expect(findDroppedPromptImages(message, 3)).toEqual({
      dropped: 1,
      passed: 3,
      reasons: [CONVERT_HINT],
    });
  });

  it('lists each distinct reason once', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: `look\n\n${RESIZE_HINT}\n${RESIZE_HINT}\n${CONVERT_HINT}` }],
    };

    expect(findDroppedPromptImages(message, 3)?.reasons).toEqual([RESIZE_HINT, CONVERT_HINT]);
  });

  it('reports a drop even when pi gave no reason', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'look' }] };

    expect(findDroppedPromptImages(message, 2)).toEqual({ dropped: 2, passed: 2, reasons: [] });
  });

  it('treats string content and a missing message as carrying no images', () => {
    expect(findDroppedPromptImages({ role: 'user', content: RESIZE_HINT }, 1)).toEqual({
      dropped: 1,
      passed: 1,
      reasons: [RESIZE_HINT],
    });
    expect(findDroppedPromptImages(undefined, 1)).toEqual({ dropped: 1, passed: 1, reasons: [] });
  });
});

describe('formatDroppedPromptImagesWarning', () => {
  it('describes a single lost image and quotes the reason', () => {
    expect(
      formatDroppedPromptImagesWarning({ dropped: 1, passed: 1, reasons: [RESIZE_HINT] })
    ).toBe(
      '**Warning**: The attached image was not sent to the model. ' +
        'The reply is based on the text of your message only.' +
        `\n\n_Reported reason: ${RESIZE_HINT}_`
    );
  });

  it('gives the count when only some of several images were lost', () => {
    expect(formatDroppedPromptImagesWarning({ dropped: 1, passed: 3, reasons: [] })).toBe(
      '**Warning**: 1 of 3 attached images were not sent to the model. ' +
        'The reply is based on the remaining images and the text of your message.'
    );
  });

  it('says the reply is text-only when every one of several images was lost', () => {
    expect(formatDroppedPromptImagesWarning({ dropped: 2, passed: 2, reasons: [] })).toBe(
      '**Warning**: 2 of 2 attached images were not sent to the model. ' +
        'The reply is based on the text of your message only.'
    );
  });
});
