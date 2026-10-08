// pi normalizes every prompt image before sending it (resize, format conversion). An
// image it cannot normalize is dropped, and the only trace is a line appended to the
// prompt text — see _normalizePromptImages in pi-coding-agent/dist/core/agent-session.js
// and the messages in dist/utils/image-process.js. The model then answers without the
// image and nothing tells the user, so compare what was passed with what pi kept.
const IMAGE_OMITTED_HINT = /\[Image omitted:[^\]]*\]/g;

export interface DroppedPromptImages {
  dropped: number;
  passed: number;
  /** pi's own "[Image omitted: …]" lines, deduplicated; empty when pi gave none. */
  reasons: string[];
}

interface PromptContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * @param message The user message pi reports through `message_start` for this prompt
 * @param passedImages How many images were handed to `session.prompt()`
 * @returns undefined when pi kept every image
 */
export function findDroppedPromptImages(
  message: unknown,
  passedImages: number
): DroppedPromptImages | undefined {
  if (passedImages <= 0) {
    return undefined;
  }

  const content = (message as { content?: unknown } | null | undefined)?.content;
  const blocks: PromptContentBlock[] = Array.isArray(content)
    ? content.filter((block): block is PromptContentBlock => !!block && typeof block === 'object')
    : [];
  const keptImages = blocks.filter((block) => block.type === 'image').length;
  const dropped = passedImages - keptImages;
  if (dropped <= 0) {
    return undefined;
  }

  const text =
    typeof content === 'string'
      ? content
      : blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('\n');

  return {
    dropped,
    passed: passedImages,
    reasons: Array.from(new Set(text.match(IMAGE_OMITTED_HINT) ?? [])),
  };
}

export function formatDroppedPromptImagesWarning(result: DroppedPromptImages): string {
  const what =
    result.passed === 1
      ? 'The attached image was'
      : `${result.dropped} of ${result.passed} attached images were`;
  const consequence =
    result.dropped === result.passed
      ? 'The reply is based on the text of your message only.'
      : 'The reply is based on the remaining images and the text of your message.';
  const reason =
    result.reasons.length > 0 ? `\n\n_Reported reason: ${result.reasons.join(' ')}_` : '';

  return `**Warning**: ${what} not sent to the model. ${consequence}${reason}`;
}
