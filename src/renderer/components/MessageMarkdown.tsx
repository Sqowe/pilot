import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';

// Hoisted to module scope to avoid re-creating arrays on every render
// remarkCjkFriendly fixes CommonMark emphasis parsing for CJK/Cyrillic scripts
// where **bold** adjacent to non-Latin characters fails to parse correctly.
// Text must first go through normalizeLatexDelimiters (utils/latex-delimiters.ts).
const REMARK_PLUGINS = [
  remarkMath,
  [remarkGfm, { singleTilde: false }],
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
] as const;

// Keeps the classes remark-math puts on <code> (`language-*` is allowed by default).
const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};
// rehypeSanitize runs BEFORE rehypeKatex, as rehype-katex's docs prescribe for
// untrusted input: the model's text is sanitized, then KaTeX (default
// `trust: false`) renders the math. Sanitizing after KaTeX strips its classes
// and MathML, and every formula shows three times, without spaces.
export const REHYPE_PLUGINS = [
  [rehypeSanitize, SANITIZE_SCHEMA],
  [rehypeKatex, { throwOnError: false, strict: false }],
] as const;

export interface MessageMarkdownProps {
  normalizedText: string;
  isStreaming?: boolean;
  components?: Record<string, unknown>;
}

export const MessageMarkdown = memo(function MessageMarkdown({
  normalizedText,
  isStreaming,
  components,
}: MessageMarkdownProps) {
  return (
    <div className="prose-chat max-w-none text-text-primary">
      <ReactMarkdown
        remarkPlugins={
          REMARK_PLUGINS as unknown as Parameters<typeof ReactMarkdown>[0]['remarkPlugins']
        }
        rehypePlugins={
          REHYPE_PLUGINS as unknown as Parameters<typeof ReactMarkdown>[0]['rehypePlugins']
        }
        components={components}
      >
        {normalizedText}
      </ReactMarkdown>
      {isStreaming && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />}
    </div>
  );
});
