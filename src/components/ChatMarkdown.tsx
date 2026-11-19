// Real markdown for bot bubbles, styled like the Obsidian document view:
// react-markdown + GFM + Obsidian callouts/highlights/tags. Links and images
// open in the Quick preview (web pages and registered-project files). Code
// blocks keep their chrome — language label, copy
// button, lazy Shiki highlighting for a curated set of languages (src/lib/highlighter.ts). Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, code blocks render
// as plain <pre> and nothing is cached — partial fences would poison it.
import { memo, useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { documentImageSource, markdownUrlTransform, type MarkdownLocation } from "@/lib/markdownImages";
import { remarkObsidian } from "@/lib/obsidianMarkdown";
import { chatFileUrl, classifyChatHref, looksLikeFilePath, openChatHref, resolveChatFile, scrollToFragment } from "@/lib/chatLinks";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed, capped, never written while streaming
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

export function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (streaming) return;
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    import("@/lib/highlighter")
      .then(({ highlightCode }) => highlightCode(code, lang))
      .then((out) => {
        if (!alive || out === null) return;
        if (highlightCache.size >= CACHE_MAX) {
          const first = highlightCache.keys().next().value;
          if (first) highlightCache.delete(first);
        }
        highlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Copy code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}

function flatText(n: any): string {
  return typeof n === "string" ? n : Array.isArray(n) ? n.map(flatText).join("") : n?.props?.children ? flatText(n.props.children) : "";
}

/** Opens in the Quick preview; ⌘/Ctrl-click (or anything the preview can't show) uses the browser. */
function ChatLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href?.startsWith("#")) {
    return (
      <a href={href} className="internal-link" onClick={(e) => { e.preventDefault(); scrollToFragment(e.currentTarget, href); }}>
        {children}
      </a>
    );
  }
  const target = classifyChatHref(href);
  const previewable = target?.kind === "web" || target?.kind === "file";
  return (
    <a
      href={target?.kind === "file" ? undefined : href}
      target="_blank"
      rel="noreferrer"
      role={target?.kind === "file" ? "link" : undefined}
      tabIndex={target?.kind === "file" ? 0 : undefined}
      title={previewable ? `${href} — opens in Preview (⌘-click for browser)` : href}
      className={target?.kind === "file" ? "internal-link file-link" : "external-link"}
      onClick={(e) => {
        if (!href || !previewable || (target?.kind === "web" && (e.metaKey || e.ctrlKey))) return;
        e.preventDefault();
        void openChatHref(href);
      }}
      onKeyDown={(e) => {
        if (target?.kind === "file" && e.key === "Enter") void openChatHref(href!);
      }}
    >
      {children}
    </a>
  );
}

export function MarkdownImage({ src, alt, location }: { src?: string; alt?: string; location?: MarkdownLocation }) {
  return <ResolvedMarkdownImage key={src} src={src} alt={alt} location={location} />;
}

function ResolvedMarkdownImage({ src, alt, location }: { src?: string; alt?: string; location?: MarkdownLocation }) {
  const target = src?.startsWith("//") ? null : classifyChatHref(src);
  const direct = location && src ? documentImageSource(src, location) : target?.kind === "web" ? src : null;
  const local = target?.kind === "file" && (!location || /^(?:file:\/\/|~?\/)/i.test(src ?? ""));
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [directFailed, setDirectFailed] = useState(false);
  const projectId = location?.projectId;
  const lookup = local && (!direct || directFailed) && target?.kind === "file" ? target.path : null;
  useEffect(() => {
    if (!lookup) return;
    let alive = true;
    void resolveChatFile(lookup, projectId).then((file) => {
      if (!alive) return;
      if (file?.kind === "image") setResolved(chatFileUrl(file));
      else setFailed(true);
    });
    return () => { alive = false; };
  }, [lookup, projectId]);

  const imageUrl = directFailed ? resolved : direct || resolved;
  if (failed || (!imageUrl && !lookup)) return <span className="md-image-missing" title={src}>{alt || "Image"} (unavailable)</span>;
  if (!imageUrl) return <span className="md-image-loading" aria-label={`Loading ${alt || "image"}`} />;
  const image = <img src={imageUrl} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => {
    if (direct && local && !directFailed) setDirectFailed(true);
    else setFailed(true);
  }} />;
  if (location) return image;
  return (
    <button type="button" className="md-image" title={`${alt || src} — open in Preview`} onClick={() => src && void openChatHref(src)}>
      {image}
    </button>
  );
}

function ChatMarkdownComponent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown-reading is-chat min-w-0">
      <Markdown
        remarkPlugins={[remarkGfm, remarkObsidian]}
        urlTransform={markdownUrlTransform}
        components={{
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const lang = /language-([\w-]+)/.exec(child?.props?.className ?? "")?.[1] ?? "";
            return <CodeBlock code={flatText(child?.props?.children).replace(/\n$/, "")} lang={lang} streaming={streaming} />;
          },
          code({ children }: { children?: ReactNode }) {
            const value = flatText(children);
            if (!streaming && looksLikeFilePath(value)) {
              return (
                <ChatLink href={value.trim()}>
                  <code>{children}</code>
                </ChatLink>
              );
            }
            return <code>{children}</code>;
          },
          a: ChatLink,
          img: MarkdownImage,
          table({ children }: { children?: ReactNode }) {
            return <div className="md-table-wrap"><table>{children}</table></div>;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
