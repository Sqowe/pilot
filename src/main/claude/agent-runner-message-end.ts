import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@earendil-works/pi-ai';
import { splitThinkTagBlocks } from './think-tag-parser';

type MessageEndContentBlock = TextContent | ThinkingContent | ToolCall;

type AssistantMessageEnd = Pick<
  AssistantMessage,
  'role' | 'content' | 'stopReason' | 'errorMessage'
>;

// pi reports every transcript entry through message_end, not only model responses: user
// prompts, tool results, pi-coding-agent's custom roles, and (since pi 0.86) the system
// message that declares tool changes, whose content is an empty string — see
// declareToolChanges in pi-agent-core/dist/agent-loop.js. Only their role is read here.
interface NonAssistantMessageEnd {
  role: string;
}

type MessageEndMessage = AssistantMessageEnd | NonAssistantMessageEnd;

function isAssistantMessageEnd(message: MessageEndMessage): message is AssistantMessageEnd {
  return message.role === 'assistant';
}

interface ResolveMessageEndPayloadOptions {
  message?: MessageEndMessage;
  streamedText: string;
}

interface ResolvedMessageEndPayload {
  effectiveContent: MessageEndContentBlock[];
  errorText?: string;
  nextStreamedText: string;
  shouldEmitMessage: boolean;
}

export function toUserFacingErrorText(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes('first_response_timeout')) {
    return 'Model response timeout: no response received from upstream for an extended period. Please retry or check the current model/gateway load.';
  }
  if (lower.includes('empty_success_result')) {
    return 'Model returned an empty success result. There may be a compatibility issue with the current model or gateway. Please retry or try switching the protocol.';
  }
  if (
    /\b400\b/.test(errorText) ||
    lower.includes('bad request') ||
    lower.includes('invalid request')
  ) {
    return `Request rejected by upstream (400), possibly due to incompatible model/protocol configuration. Please check the model name, protocol settings, and API endpoint.\nOriginal error: ${errorText}`;
  }
  if (
    /\b(401|403)\b/.test(errorText) ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return `Authentication failed. Please check whether the API Key is correct, expired, or lacks access to the current model.\nOriginal error: ${errorText}`;
  }
  if (
    /\b429\b/.test(errorText) ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return `Request rate-limited (429). The current model or API endpoint has reached its call frequency limit. Please retry later.\nOriginal error: ${errorText}`;
  }
  if (
    /\b(5\d{2})\b/.test(errorText) ||
    lower.includes('server error') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return `Upstream service error, possibly due to model service overload or a temporary failure. The SDK will retry automatically.\nOriginal error: ${errorText}`;
  }
  if (
    lower.includes('terminated') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('connection refused') ||
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('other side closed') ||
    lower.includes('reset before headers') ||
    lower.includes('upstream connect') ||
    lower.includes('retry delay')
  ) {
    return `Network connection interrupted (${errorText}), possibly due to an unstable proxy/gateway. The SDK will retry automatically.`;
  }
  return errorText;
}

export function resolveMessageEndPayload(
  options: ResolveMessageEndPayloadOptions
): ResolvedMessageEndPayload {
  const { message, streamedText } = options;
  const nextStreamedText = '';

  // Only the model can produce an "empty success result". A non-assistant entry without
  // content blocks is normal and must not be reported as a failed response.
  if (message && !isAssistantMessageEnd(message)) {
    return {
      effectiveContent: [],
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  if (message?.stopReason === 'error' && message.errorMessage) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText(message.errorMessage),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  const rawContent =
    Array.isArray(message?.content) && message.content.length > 0
      ? message.content
      : streamedText
        ? [{ type: 'text' as const, text: streamedText }]
        : [];

  if (rawContent.length === 0) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText('empty_success_result'),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  // Post-process: split any <think>...</think> tags in text blocks into
  // separate thinking + text content blocks for proper UI rendering.
  const effectiveContent: MessageEndContentBlock[] = [];
  for (const block of rawContent) {
    if (block.type === 'text') {
      const splitBlocks = splitThinkTagBlocks(block.text);
      for (const splitBlock of splitBlocks) {
        if (splitBlock.type === 'thinking') {
          effectiveContent.push({
            type: 'thinking',
            thinking: splitBlock.thinking,
          } as ThinkingContent);
        } else {
          effectiveContent.push({ type: 'text', text: splitBlock.text } as TextContent);
        }
      }
    } else {
      effectiveContent.push(block);
    }
  }

  return {
    effectiveContent,
    nextStreamedText,
    shouldEmitMessage: effectiveContent.length > 0,
  };
}
