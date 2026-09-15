// The card's brief, as markdown.
//
// A brief is written for a bot to read first, so it earns formatting: a list of
// steps, a bolded constraint, a small table of figures. It is stored as the
// markdown a person typed for that reason — the text the bot receives is the
// text on screen, with no rich-text document to convert back.
//
// This is deliberately NOT `ChatMarkdown`. That one carries the chat's own
// machinery — @mention linking, thread references, a highlighted code block
// with copy and wrap controls — none of which belongs on a card, and all of
// which costs. A brief needs GFM and nothing else.
//
// Model output never reaches the DOM as raw HTML: no `rehype-raw`, so a `<`
// in a brief renders as a character.
import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";

export interface BriefMarkdownProps {
  text: string;
  className?: string;
}

function BriefMarkdownComponent({ text, className }: BriefMarkdownProps) {
  return (
    <div
      className={cn(
        // Tight line spacing and small type: a card is a glance, not a page.
        // The element styles are scoped here rather than in a stylesheet so a
        // brief's markdown cannot pick up the chat bubble's typography.
        "min-w-0 text-[11.5px] leading-relaxed text-ink-secondary",
        "[&_p]:m-0 [&_p+p]:mt-1",
        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4",
        "[&_li]:my-0.5",
        "[&_strong]:font-semibold [&_strong]:text-ink",
        "[&_em]:italic",
        "[&_a]:text-accent [&_a]:underline",
        "[&_code]:rounded [&_code]:bg-card [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[10.5px]",
        "[&_h1]:text-[12.5px] [&_h1]:font-semibold [&_h1]:text-ink",
        "[&_h2]:text-[12px] [&_h2]:font-semibold [&_h2]:text-ink",
        "[&_h3]:text-[11.5px] [&_h3]:font-semibold [&_h3]:text-ink",
        "[&_table]:my-1 [&_table]:w-full [&_th]:text-left [&_th]:font-semibold [&_td]:pr-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-hairline [&_blockquote]:pl-2 [&_blockquote]:text-ink-secondary/80",
        "[&_hr]:my-2 [&_hr]:border-hairline/40",
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

export const BriefMarkdown = memo(
  BriefMarkdownComponent,
  (previous, next) => previous.text === next.text && previous.className === next.className,
);

/** Whether a brief contains anything markdown would format.
 *
 * Used to decide between rendering markdown and showing the plain text
 * verbatim: a brief with no syntax is cheaper and identical drawn plainly, and
 * running every card's brief through a parser to render ordinary prose is work
 * for no visible difference. */
export function hasMarkdownSyntax(text: string): boolean {
  return /(\*\*|__|\*|_|`|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>\s|\|.*\||\[[^\]]+\]\()/m.test(text);
}