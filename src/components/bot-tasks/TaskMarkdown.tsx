// Security: GitHub comments are untrusted. Raw HTML is parsed (rehype-raw) and then cut down to GitHub's own allowlist
// (rehype-sanitize's default schema): no script, style, iframe, event handler or javascript: URL reaches the DOM.
import { memo, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps, type Options as MarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";
import { LINK_CLASS } from "../ChatLinks";
import { MARKDOWN_BLOCK_COMPONENTS } from "../ChatMarkdown";

const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SAFE_IMAGE = /^https?:/i;

const REMARK_PLUGINS: NonNullable<MarkdownOptions["remarkPlugins"]> = [remarkGfm];
const REHYPE_PLUGINS: NonNullable<MarkdownOptions["rehypePlugins"]> = [rehypeRaw, [rehypeSanitize, defaultSchema]];

type Props<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> & ExtraProps;
const has = (className: unknown, name: string) => typeof className === "string" && className.split(/\s+/).includes(name);

const COMPONENTS: Components = {
  ...MARKDOWN_BLOCK_COMPONENTS,
  a({ href, children }: Props<"a">) {
    if (href && SAFE_LINK.test(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer" dir="auto" className={LINK_CLASS}>{children}</a>;
    }
    // A footnote jump stays on the page; anything else (a GitHub-relative path) has nowhere to go here.
    if (href?.startsWith("#")) return <a href={href} className={LINK_CLASS}>{children}</a>;
    return <span className="break-words">{children}</span>;
  },
  img({ src, alt, width, height }: Props<"img">) {
    if (typeof src !== "string" || !SAFE_IMAGE.test(src)) return alt ? <span className="text-ink-secondary">{alt}</span> : null;
    return <img src={src} alt={alt ?? ""} width={width} height={height} loading="lazy" referrerPolicy="no-referrer"
      className="inline-block h-auto max-w-full rounded-md align-middle" />;
  },
  del({ children }: { children?: ReactNode }) {
    return <del className="text-ink-secondary">{children}</del>;
  },
  details({ open, children }: Props<"details">) {
    return (
      <details open={open} className="group rounded-lg border border-hairline/40 px-3 py-2 [&>*+*]:mt-2">{children}</details>
    );
  },
  summary({ children }: { children?: ReactNode }) {
    return (
      <summary className="-mx-1 cursor-pointer select-none rounded px-1 font-medium text-ink marker:text-ink-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&>*]:inline">
        {children}
      </summary>
    );
  },
  kbd({ children }: { children?: ReactNode }) {
    return <kbd className="rounded border border-hairline/60 bg-ink/[0.04] px-1 py-px font-mono text-[12px]">{children}</kbd>;
  },
  ul({ node, className, children }: Props<"ul">) {
    if (has(className, "contains-task-list")) return <ul className="space-y-1 ps-1">{children}</ul>;
    return MARKDOWN_BLOCK_COMPONENTS.ul({ node, children });
  },
  ol({ node, className, children }: Props<"ol">) {
    if (has(className, "contains-task-list")) return <ol className="space-y-1 ps-1">{children}</ol>;
    return MARKDOWN_BLOCK_COMPONENTS.ol({ node, children });
  },
  li({ className, children }: Props<"li">) {
    return <li className={cn(has(className, "task-list-item") && "list-none")}>{children}</li>;
  },
  input({ type, checked }: Props<"input">) {
    if (type !== "checkbox") return null;
    return <input type="checkbox" checked={checked === true} disabled readOnly className="me-1.5 align-[-1px] accent-accent" />;
  },
};

/** A bot's or GitHub's text as GitHub shows it: GitHub-flavoured Markdown plus the HTML GitHub allows, such as
 * collapsible `<details>`. Wide tables and code scroll inside their own box. */
export const TaskMarkdown = memo(function TaskMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div data-task-markdown="" dir="auto" className={cn("chat-md min-w-0 break-words text-[13px] leading-[18px] text-ink [&>*+*]:mt-2", className)}>
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>{text}</Markdown>
    </div>
  );
});
