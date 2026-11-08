// Security: model output never reaches the DOM as raw HTML (no rehype-raw); Shiki's output is generator-escaped.
import { createContext, memo, use, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { fromMarkdown, type Options as MarkdownParseOptions } from "mdast-util-from-markdown";
import { Check, Copy, Download, Eye, LoaderCircle, RotateCcw, WrapText, X } from "lucide-react";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { remarkMentions, sameMentionPerson, type MentionPeer, type MentionPerson } from "@/lib/mentions";
import { createMarkdownRenderCache } from "@/lib/markdown-render-cache";

import { parseFenceInfo } from "../lib/code-block";
import { markdownImageName, markdownImageOpenUrl } from "../lib/markdown-image";
import { repairMarkdownTables } from "../lib/markdown-tables";
import { TRANSCRIPT_WINDOW_SIZE } from "../lib/transcript-window";
import { windowsPathDestinations } from "../../shared/markdown-windows-paths";
import { linkPlainPaths } from "../../shared/markdown-plain-paths";
import { GITHUB_REF_CLASS, isUseMyComputerUrl, LINK_CLASS, UseMyComputerLink, usePageOpener, withPageOpen } from "./ChatLinks";
import { githubRefFromProps, remarkGithubRefs } from "@/lib/github-refs";
import { GITHUB_REF_ICONS, LinkHoverCard } from "@/components/LinkHoverCard";
import { useThreadLinkMenu } from "@/components/ThreadLinkMenu";
import { looksLikeThreadRefUrl, parseThreadRefUrl, resolveThreadRefAddress, remarkThreadRefs } from "../lib/thread-refs";
import { MarkdownImagePreview, MessageFolderFiles, OutsideWorkspaceFile, saveFailureText, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { ThreadLink, ThreadRefsContext, threadLinkFromProps, type ThreadRefsValue } from "./ThreadRefs";
import { MarkdownTable } from "./MarkdownTable";
import { CodeBlock, CodePlate, codeHash } from "./CodeBlock";
export { CodeBlock, HIGHLIGHT_CACHE_MAX, HIGHLIGHT_CACHE_MAX_CHARS, HIGHLIGHT_MAX_CHARS, type CodeBlockProps } from "./CodeBlock";
import { FilePreviewButton } from "./FilePreviewButton";
import { SaveIconButton, useHtmlPreview } from "./HtmlFilePreview";
import { openLinkedFolder, useRevealOriginalMenu } from "./RevealOriginalMenu";

const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_MAX = 50;
// mermaid.render() needs an id no earlier call used, failed calls included (they can leave an orphan element).
let mermaidRenderId = 0;
const mermaidKey = (scheme: "dark" | "light", code: string) => `${scheme}:${codeHash(code)}`;

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

export const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password || url.port || url.search || url.hash) return null;
      const path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
      // WHATWG file URLs spell a Windows drive as /C:/ on every host; a raw /C:/… Markdown target is a POSIX path.
      return /^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : absolutePath(path);
    } catch {
      return null;
    }
  }
  if (href.startsWith("\\\\")) return href;
  // //host/path is a protocol-relative web URL in Markdown; UNC paths come as backslashes or file://server/share.
  if (href.startsWith("//")) return null;
  const absolute = absolutePath(href);
  if (absolute) return absolute;
  if (href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  return href;
};

export function chatUrlTransform(value: string, key = "href"): string {
  if (looksLikeThreadRefUrl(value) || isUseMyComputerUrl(value)) return value;
  // Markdown-to-HTML percent-encodes a destination's backslashes (C:%5CUsers…); restore them and leave other escapes
  // for the server's single decode.
  const url = /^(?:[a-zA-Z]:%5C|%5C%5C)/i.test(value) ? value.replace(/%5C/gi, "\\") : value;
  if (/^file:\/\//i.test(url) || WINDOWS_PATH.test(url) || url.startsWith("\\\\")) {
    return localFilePath(url) ? url : "";
  }
  if (key === "href" && /^obsidian:\/\//i.test(value)) return value;
  return defaultUrlTransform(value);
}

/** Must parse link destinations exactly as the server's message-file parser does. */
function remarkWindowsPathDestinations(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push(windowsPathDestinations);
}

function remarkPlainPaths() {
  return (tree: object, file: { value?: unknown }) => {
    if (typeof file.value === "string") linkPlainPaths(tree, file.value);
  };
}

const gfmParseData: {
  micromarkExtensions?: MarkdownParseOptions["extensions"];
  fromMarkdownExtensions?: MarkdownParseOptions["mdastExtensions"];
} = {};
// A spoiler is "~~text~~" only: a lone "~" in a range such as "77~82" must not hide what follows it.
const GFM_OPTIONS = { singleTilde: false };
remarkGfm.call({ data: () => gfmParseData }, GFM_OPTIONS);
const normalizationParseOptions: MarkdownParseOptions = {
  extensions: gfmParseData.micromarkExtensions,
  mdastExtensions: [...(gfmParseData.fromMarkdownExtensions ?? []), windowsPathDestinations],
};

/** A single line break in a reply is a line break, as chat apps show it, not a space. */
function remarkSoftBreaks() {
  return (tree: { children?: any[] }) => {
    const visit = (node: { children?: any[] }) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child?.type !== "text" || !child.value.includes("\n")) {
          visit(child);
          return [child];
        }
        return (child.value as string).split("\n").flatMap((value, index) => [
          ...(index ? [{ type: "break" }] : []),
          ...(value ? [{ type: "text", value }] : []),
        ]);
      });
    };
    visit(tree);
  };
}

function unwrapLinkedImages() {
  return (tree: { children?: any[] }) => {
    const visit = (node: { children?: any[] }) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child?.type === "link" && child.children?.length === 1 && child.children[0]?.type === "image") {
          const image = child.children[0];
          return { ...image, data: { ...image.data, hProperties: { ...image.data?.hProperties, "data-open-url": child.url } } };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

// Not dir="auto": that algorithm skips descendants carrying their own dir, so a blockquote or table of per-block
// directions falls back to LTR. JS regexes cannot match Bidi_Class, so these are the blocks Unicode reserves for
// right-to-left letters.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const strong = /\p{Letter}/u.exec(value);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function blockText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return "";
  return (node.children ?? []).map(blockText).join("");
}

export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}

function mermaidScheme(element: HTMLElement | null): "dark" | "light" {
  if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return "dark";
  try {
    return window.getComputedStyle(element).getPropertyValue("--code-color-scheme").trim() === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export interface MermaidDiagramProps {
  code: string;
}

const MERMAID_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF UI Text", "Segoe UI", system-ui, sans-serif';

/** Security: the only HTML injected is the SVG mermaid.render() returns under securityLevel "strict". */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [skinEpoch, setSkinEpoch] = useState(0);
  const [svg, setSvg] = useState<string | null>(() =>
    mermaidCache.get(mermaidKey(mermaidScheme(typeof document === "undefined" ? null : document.documentElement), code)) ?? null);
  const markup = useMemo(() => (svg ? { __html: svg } : null), [svg]);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const { state: copied, copy } = useCopyFeedback(code);
  const simple = !useAdvancedMode();

  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(() => setSkinEpoch((epoch) => epoch + 1));
    observer.observe(document.documentElement, { subtree: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scheme = mermaidScheme(frame.current);
    const key = mermaidKey(scheme, code);
    const cached = mermaidCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }
    let alive = true;
    import("mermaid")
      .then((module) => {
        mermaidRenderId += 1;
        module.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: scheme === "light" ? "default" : "dark",
          fontFamily: MERMAID_FONT,
        });
        return module.default.render(`omb-mermaid-${mermaidRenderId}`, code);
      })
      .then((out) => {
        if (!alive) return;
        if (mermaidCache.size >= MERMAID_CACHE_MAX) {
          const first = mermaidCache.keys().next().value;
          if (first) mermaidCache.delete(first);
        }
        mermaidCache.set(key, out.svg);
        setSvg(out.svg);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message.length > 300 ? `${message.slice(0, 300)}…` : message);
      });
    return () => {
      alive = false;
    };
  }, [code, skinEpoch]);

  const diagram = <>
    {error && (
      <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
        {t("chat.mermaid.failed", { error })}
      </p>
    )}
    {markup && <div className="overflow-x-auto p-3 [&_svg]:!max-w-full" dangerouslySetInnerHTML={markup} />}
    {(showSource || !svg || error) && (
      <pre className={cn("overflow-x-auto text-[13px]", simple ? "px-3 py-2 leading-5 text-ink-secondary" : "p-3 leading-relaxed text-ink")}>{code}</pre>
    )}
  </>;
  if (simple) {
    return (
      <div ref={frame} dir="ltr" className="group/code relative my-2.5 overflow-hidden rounded-xl bg-ink/[0.04]">
        <CodePlate copied={copied} onCopy={copy} copyLabel={t("code.copySource")} items={[
          { key: "source", label: t(showSource ? "code.hideSource" : "code.showSource"), icon: <WrapText size={14} aria-hidden="true" />, active: showSource, onSelect: () => setShowSource((shown) => !shown) },
          { key: "about", label: t("code.mermaid"), disabled: true, separatorBefore: true, onSelect: () => {} },
        ]} />
        {diagram}
      </div>
    );
  }
  return (
    <div ref={frame} dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
        <span title={t("chat.mermaid.title")} className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-ink select-none">
          {t("chat.mermaid.title")}
        </span>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setShowSource((visible) => !visible)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              showSource
                ? "bg-accent/15 text-accent font-medium"
                : "text-ink-secondary hover:bg-raised hover:text-ink"
            }`}
            title={t(showSource ? "chat.mermaid.hideSourceTitle" : "chat.mermaid.showSourceTitle")}
            aria-label={t(showSource ? "chat.mermaid.hideSourceTitle" : "chat.mermaid.showSourceTitle")}
            aria-pressed={showSource}
          >
            <WrapText size={12} aria-hidden="true" />
            <span className="hidden sm:inline">{t(showSource ? "chat.mermaid.hideSource" : "chat.mermaid.showSource")}</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? t("chat.code.copied") : copied === "failed" ? t("common.copyFailed") : t("chat.mermaid.copy")}
            aria-label={copied === "copied" ? t("chat.mermaid.copiedLabel") : copied === "failed" ? t("common.copyFailed") : t("chat.mermaid.copyLabel")}
          >
            {copied === "failed" ? (
              <>
                <X size={12} className="text-danger" aria-hidden="true" />
                <span className="text-danger font-medium hidden sm:inline">{t("common.copyFailed")}</span>
              </>
            ) : copied === "copied" ? (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                <span className="text-success font-medium hidden sm:inline">{t("chat.code.copiedShort")}</span>
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                <span className="hidden sm:inline">{t("common.copy")}</span>
              </>
            )}
          </button>
        </div>
      </div>
      {diagram}
    </div>
  );
}

// Security: no href at all, since an <a href="file://…"> reaches setWindowOpenHandler on a middle or modifier click,
// which calls shell.openExternal without main's containment check.
// source: the original a delivered copy came from, offered on right-click (Show in Finder) like in the gallery.
function LocalFileLink({ filePath, name, source, children, message }: { filePath: string; name?: string; source?: string; children?: ReactNode; message?: MessageAttachmentContext }) {
  const save = useLocalFileSave(filePath, name, message);
  const preview = useHtmlPreview(filePath, name ?? fileName(filePath), message);
  const revealMenu = useRevealOriginalMenu();
  const [opening, setOpening] = useState(false);
  if (!message) {
    return <span title={t("chat.file.legacy")} className="break-words text-ink-secondary">{children}</span>;
  }
  const label = save.state === "saving"
    ? t("common.saving")
    : save.state === "saved"
      ? t("common.saved")
      : save.state === "failed"
        ? t("chat.retry")
        : null;

  return (
    <span dir="ltr" className="inline-flex flex-wrap items-center gap-x-1.5 [unicode-bidi:isolate]" {...revealMenu.targetProps(source)}>
      {revealMenu.menu}
      {preview.html
        ? <SaveIconButton name={name ?? fileName(filePath)} save={save} retryable={save.retryable} />
        : <FilePreviewButton path={filePath} name={name ?? fileName(filePath)} message={message} />}
      <button
        type="button"
        onClick={preview.html ? preview.show : () => {
          setOpening(true);
          void openLinkedFolder(filePath).then((opened) => opened ? undefined : save.save()).finally(() => setOpening(false));
        }}
        disabled={!preview.html && (opening || save.state === "saving")}
        title={preview.html ? t("html.preview", { name: name ?? fileName(filePath) }) : t("chat.file.saveCopy")}
        className="inline-flex items-center gap-1 break-words text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {children}
        {preview.html ? (
          <Eye size={12} className="shrink-0" aria-hidden="true" />
        ) : save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : save.state === "failed" ? (
          save.retryable && <RotateCcw size={12} className="shrink-0" aria-hidden="true" />
        ) : (
          <Download size={12} className="shrink-0" aria-hidden="true" />
        )}
      </button>
      {label && (
        <span
          role={save.state === "failed" ? "alert" : "status"}
          title={save.state === "saved" ? save.savedTo : undefined}
          className={`text-[12px] ${save.state === "saved" ? "text-success" : save.state === "failed" ? "text-danger" : "text-ink-secondary"}`}
        >
          {save.state === "failed" ? saveFailureText(save) : label}
        </span>
      )}
      {save.state === "failed" && save.outsideWorkspace && (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px]">
          <OutsideWorkspaceFile filePath={filePath} />
        </span>
      )}
      {save.folder && <MessageFolderFiles folderPath={filePath} listing={save.folder} message={message} />}
      {preview.dialog}
    </span>
  );
}

function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label={t("chat.spoiler.reveal")}
          title={t("chat.spoiler.reveal")}
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label={t("chat.spoiler.hide")}
        title={t("chat.spoiler.hide")}
        onClick={() => setRevealed(false)}
        className="ms-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        {t("chat.spoiler.hideShort")}
      </button>
    </span>
  );
}

const NO_MENTION_PEERS: readonly MentionPeer[] = [];

const MARKDOWN_IMAGE = "![";

const CURRENCY_DOLLAR = /(?<![$\p{L}\p{N}])(?:R|US|AU|A|CA|C|NZ|HK|SG|S|MX|NT|BZ|Z)\$(?=[ \t\u00a0]?\d)/gu;

/**
 * Pandoc's rule: an opening `$` is followed by non-space, a closing `$` is preceded by non-space and not followed by a
 * digit, and the pair stays inside one paragraph.
 */
function escapeLiteralDollars(text: string): string {
  const display: string[] = [];
  const hidden = text
    .replace(/\$\$[\s\S]*?\$\$/g, (math) => `\u0000OMB_MATH_${display.push(math) - 1}\u0000`)
    .replace(CURRENCY_DOLLAR, (sign) => `${sign.slice(0, -1)}\\$`);
  const literal = new Set<number>();
  const singles: number[] = [];
  for (let i = 0; i < hidden.length; i++) {
    if (hidden[i] === "\\") i++;
    else if (hidden[i] === "$") singles.push(i);
  }
  let open: number | null = null;
  for (const at of singles) {
    if (open !== null) {
      const closes = !/\s/.test(hidden[at - 1]) && !/\d/.test(hidden[at + 1] ?? "")
        && !/\n[ \t]*\n/.test(hidden.slice(open, at));
      if (closes) { open = null; continue; }
      literal.add(open);
    }
    open = /\S/.test(hidden[at + 1] ?? "") ? at : null;
    if (open === null) literal.add(at);
  }
  if (open !== null) literal.add(open);
  let escaped = "";
  for (let i = 0; i < hidden.length; i++) escaped += literal.has(i) ? "\\$" : hidden[i];
  display.forEach((math, index) => {
    escaped = escaped.split(`\u0000OMB_MATH_${index}\u0000`).join(math);
  });
  return escaped;
}

export function normalizeMathDelimiters(text: string, imageOffsets?: Map<number, number>): string {
  const protectedCode: Array<{ value: string; sourceOffset: number }> = [];
  const protect = (value: string, sourceOffset: number): string => {
    const token = `\u0000OMB_CODE_${protectedCode.length}\u0000`;
    protectedCode.push({ value, sourceOffset });
    return token;
  };
  const spans: Array<{ start: number; end: number }> = [];
  const imageStarts: number[] = [];
  const visit = (node: { type: string; children?: any[]; position?: { start: { offset?: number }; end: { offset?: number } } }, protectedParent = false) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const image = node.type === "image" || node.type === "imageReference";
    if (image && start !== undefined) imageStarts.push(start);
    const labelEnd = node.type === "link" && start !== undefined && text[start] === "["
      ? node.children?.at(-1)?.position?.end.offset : undefined;
    const protectedNode = node.type === "code" || node.type === "inlineCode" || node.type === "definition" || node.type === "linkReference" || node.type === "link" || (imageOffsets !== undefined && image);
    if (!protectedParent && protectedNode && start !== undefined && end !== undefined) {
      spans.push({ start: labelEnd ?? start, end });
    }
    node.children?.forEach((child) => visit(child, protectedParent || (protectedNode && labelEnd === undefined)));
  };
  visit(fromMarkdown(text, normalizationParseOptions));
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + protect(text.slice(start, end), start) + text.slice(end);
  }
  let normalized = text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `$$\n${math}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => `$${math.trim()}$`)
    // remark-math treats flow math as a block only when the fences occupy their own lines.
    .replace(/\$\$[ \t]*([^\n][\s\S]*?)[ \t]*\$\$/g, (_match, math: string) => `$$\n${math}\n$$`);
  normalized = escapeLiteralDollars(normalized);
  let shift = 0;
  // oxlint-disable-next-line no-control-regex -- restore opaque code and image sentinels
  normalized = normalized.replace(/\u0000OMB_CODE_(\d+)\u0000/g, (token, index: string, at: number) => {
    const part = protectedCode[Number(index)];
    if (!part) return token;
    const { value, sourceOffset } = part;
    for (const imageOffset of imageStarts) {
      if (imageOffset >= sourceOffset && imageOffset < sourceOffset + value.length) {
        imageOffsets?.set(at + shift + imageOffset - sourceOffset, imageOffset);
      }
    }
    shift += value.length - token.length;
    return value;
  });
  return normalized;
}

const normalizedCache = new Map<string, Pick<MessageScope, "imageOffsets"> & { source: string }>();
const NORMALIZED_CACHE_MAX = TRANSCRIPT_WINDOW_SIZE * 2;

function normalizeMessageMarkdown(text: string) {
  const cached = normalizedCache.get(text);
  if (cached) return cached;
  const imageOffsets = text.includes(MARKDOWN_IMAGE) ? new Map<number, number>() : undefined;
  const source = normalizeMathDelimiters(imageOffsets ? text : repairMarkdownTables(text), imageOffsets);
  if (normalizedCache.size >= NORMALIZED_CACHE_MAX) {
    const first = normalizedCache.keys().next().value;
    if (first !== undefined) normalizedCache.delete(first);
  }
  const normalized = { source, imageOffsets };
  normalizedCache.set(text, normalized);
  return normalized;
}

type KatexPlugin = (typeof import("rehype-katex"))["default"];

let katexPlugin: KatexPlugin | null = null;
let katexLoad: Promise<void> | null = null;

export function ensureChatKatex(): Promise<void> {
  if (katexPlugin) return Promise.resolve();
  katexLoad ??= import("rehype-katex").then(async (mod) => {
    if (typeof document !== "undefined") await import("katex/dist/katex.min.css");
    katexPlugin = mod.default;
  }).catch(error => {
    katexLoad = null;
    throw error;
  });
  return katexLoad;
}

function normalizedSourceHasMath(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 92) {
      i += 1;
      continue;
    }
    if (source[i] !== "$") continue;
    const next = source[i + 1];
    if (next === undefined) return false;
    if (next === "$") {
      if (source.indexOf("$$", i + 2) !== -1) return true;
      i += 1;
      continue;
    }
    return source.indexOf("$", i + 1) !== -1;
  }
  return false;
}

export function messageNeedsKatex(text: string): boolean {
  return normalizedSourceHasMath(normalizeMessageMarkdown(text).source);
}

/**
 * The renderers are defined once: react-markdown makes each one an element type, so a fresh function per render would
 * remount the whole message. Per-message values reach them through this context.
 */
interface MessageScope {
  message?: MessageAttachmentContext;
  imageOffsets?: Map<number, number>;
  threads: ThreadRefsValue["threads"];
  currentBotId?: string;
  delivered?: DeliveredFiles;
  originals?: DeliveredFiles;
}

export type DeliveredFiles = Readonly<Record<string, string>>;

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const MessageScopeContext = createContext<MessageScope>({ threads: [] });

function MarkdownCode({ node, children }: BlockProps) {
  const child: any = Array.isArray(children) ? children[0] : children;
  const className: string = child?.props?.className ?? "";
  const { lang, wrap } = parseFenceInfo(/language-([^\s]+)/.exec(className)?.[1] ?? "", (node as { children?: { data?: { meta?: unknown } }[] })?.children?.[0]?.data?.meta);
  const flat = (n: any): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
  const code = flat(child?.props?.children).replace(/\n$/, "");
  if (lang.trim().toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code} />;
  }
  return <CodeBlock code={code} lang={lang} initialWrap={wrap} />;
}

function MarkdownImage(props: ComponentProps<"img"> & ExtraProps) {
  const { message, imageOffsets } = useContext(MessageScopeContext);
  const { src, alt } = props;
  if (!src) {
    return <span className="text-[12px] text-danger" role="alert">{t("attach.imageUnavailable")}</span>;
  }
  const filePath = localFilePath(src) ?? undefined;
  const sourceOffset = props.node?.position?.start.offset;
  return (
    <MarkdownImagePreview
      src={src}
      name={markdownImageName(src, alt)}
      openUrl={markdownImageOpenUrl(typeof (props as Record<string, unknown>)["data-open-url"] === "string" ? String((props as Record<string, unknown>)["data-open-url"]) : src)}
      filePath={filePath}
      message={filePath ? message : undefined}
      sourceOffset={sourceOffset === undefined ? undefined : imageOffsets?.get(sourceOffset) ?? sourceOffset}
    />
  );
}

function MarkdownLink({ href, children, ...rest }: { href?: string; children?: ReactNode }) {
  // SAFETY: react-markdown hands hast data-* attributes through as string props
  const props = rest as Record<string, unknown>;
  const { threads, currentBotId, message, delivered, originals } = useContext(MessageScopeContext);
  const linkMenu = useThreadLinkMenu(href), openPage = usePageOpener();
  if (!href) return <span className="break-words">{children}</span>;
  if (isUseMyComputerUrl(href)) return <UseMyComputerLink>{children}</UseMyComputerLink>;
  const address = parseThreadRefUrl(href);
  const ref = address ? resolveThreadRefAddress(threads, address, currentBotId) : null;
  if (ref) return <ThreadLink target={ref} ambiguous={ref.ambiguous}>{children}</ThreadLink>;
  if (address || looksLikeThreadRefUrl(href)) return <span className="break-words">{children}</span>;
  const localPath = localFilePath(href);
  if (localPath) {
    const copy = delivered && Object.hasOwn(delivered, fileName(localPath)) ? delivered[fileName(localPath)] : undefined;
    const source = copy && originals && Object.hasOwn(originals, copy) ? originals[copy] : undefined;
    return <LocalFileLink filePath={copy ?? localPath} name={copy ? fileName(localPath) : undefined} source={source} message={message}>{children}</LocalFileLink>;
  }
  if (!/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" dir="auto" className={LINK_CLASS}>
        {children}
      </a>
    );
  }
  const github = githubRefFromProps(props, href);
  const Icon = github ? GITHUB_REF_ICONS[github.kind] : null;
  return (
    <LinkHoverCard href={href} github={github}>
      {(hoverAnchor) => { const anchor = withPageOpen(href, openPage, linkMenu.onContextMenu ? { ...hoverAnchor, onContextMenu: linkMenu.onContextMenu } : hoverAnchor); return <>{linkMenu.menu}{Icon ? (
        <a {...anchor} href={href} target="_blank" rel="noreferrer" dir="ltr" title={href} data-github-ref={github!.kind} className={GITHUB_REF_CLASS}>
          <Icon size={13} aria-hidden="true" className="shrink-0 self-center text-ink-tertiary" />
          <span>{children}</span>
        </a>
      ) : (
        <a {...anchor} href={href} target="_blank" rel="noreferrer" dir="auto" className={LINK_CLASS}>
          {children}
        </a>
      )}</>; }}
    </LinkHoverCard>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownCode,
  img: MarkdownImage,
  code({ children }: { children?: ReactNode }) {
    return (
      <code dir="ltr" className="ui-code-chip break-words [unicode-bidi:isolate]">{children}</code>
    );
  },
  span(props) {
    // SAFETY: react-markdown hands hast data-* attributes through as string props
    const link = threadLinkFromProps(props as Record<string, unknown>);
    if (link) return <ThreadLink target={link.target} ambiguous={link.ambiguous}>{props.children}</ThreadLink>;
    const { node: _node, children, ...rest } = props;
    return <span {...rest}>{children}</span>;
  },
  a: MarkdownLink,
  table({ node, children }: BlockProps) {
    return <MarkdownTable direction={blockDirection(node)}>{children}</MarkdownTable>;
  },
  th({ children }: { children?: ReactNode }) {
    return (
      <th className="border-b border-hairline/40 px-2 py-1.5 text-start font-semibold">{children}</th>
    );
  },
  td({ children }: { children?: ReactNode }) {
    return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
  },
  p({ node, children }: BlockProps) {
    return <p dir={blockDirection(node)}>{children}</p>;
  },
  ul({ node, children }: BlockProps) {
    return <ul dir={blockDirection(node)} className="list-disc space-y-1 ps-5">{children}</ul>;
  },
  ol({ node, children }: BlockProps) {
    return <ol dir={blockDirection(node)} className="list-decimal space-y-1 ps-5">{children}</ol>;
  },
  h1({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="md-heading mt-3 text-[20px] font-semibold leading-[26px] tracking-[-0.01em]">{children}</div>;
  },
  h2({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="md-heading mt-2 text-[17px] font-semibold leading-6 tracking-[-0.005em]">{children}</div>;
  },
  h3({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h4({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h5({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[14px] font-semibold">{children}</div>;
  },
  h6({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[14px] font-semibold text-ink-secondary">{children}</div>;
  },
  blockquote({ node, children }: BlockProps) {
    return (
      <blockquote dir={blockDirection(node)} className="border-s-2 border-hairline ps-3 text-ink-secondary">{children}</blockquote>
    );
  },
  del({ children }: { children?: ReactNode }) {
    return <Spoiler>{children}</Spoiler>;
  },
  hr() {
    return <hr className="border-hairline/40" />;
  },
};

// A thread link is "#" directly before a title, or an app link. A heading's "## " never reaches the plugin as text.
const MAY_LINK_THREAD = /#[^\s#]|openmausbot/i;
const NO_THREAD_REFS: ThreadRefsValue = { threads: [] };

// One plugin list for everything every message shares; a message adds mentions only when it has an "@" and thread
// links only when it may name one, so most messages render the same way whatever the bot list holds.
const BASE_REMARK_PLUGINS: NonNullable<MarkdownOptions["remarkPlugins"]> = [[remarkGfm, GFM_OPTIONS], remarkMath, remarkWindowsPathDestinations, remarkPlainPaths, unwrapLinkedImages, remarkSoftBreaks, remarkGithubRefs];
const NO_REHYPE_PLUGINS: NonNullable<MarkdownOptions["rehypePlugins"]> = [];
let katexPlugins: { plugin: KatexPlugin; list: NonNullable<MarkdownOptions["rehypePlugins"]> } | null = null;
const rehypePluginsFor = (math: KatexPlugin | null) => {
  if (!math) return NO_REHYPE_PLUGINS;
  if (katexPlugins?.plugin !== math) katexPlugins = { plugin: math, list: [math] };
  return katexPlugins.list;
};

const markdownCache = createMarkdownRenderCache();
const peerSignatures = new WeakMap<readonly MentionPeer[], string>();
const peerSignature = (peers: readonly MentionPeer[]) => {
  let signature = peerSignatures.get(peers);
  if (signature === undefined) {
    signature = peers.map((peer) => `${peer.name}\u0001${peer.hidden ? 1 : 0}${peer.person ? 1 : 0}${peer.color ?? ""}`).join("\u0002");
    peerSignatures.set(peers, signature);
  }
  return signature;
};
// The thread list keeps its identity while its contents hold (ThreadRefsProvider), so a number per list stands for it.
const threadListIds = new WeakMap<object, number>();
let threadListCount = 0;
const threadListId = (threads: object) => {
  let id = threadListIds.get(threads);
  if (id === undefined) threadListIds.set(threads, (id = ++threadListCount));
  return id;
};

/** Test seam: drops every cached message. */
export function clearChatMarkdownCache(): void {
  markdownCache.clear();
}

function ChatMarkdownComponent({ text, message, mentionPeers = NO_MENTION_PEERS, everyone = false, mentionPerson, delivered, originals }: {
  text: string; message?: MessageAttachmentContext;
  mentionPeers?: readonly MentionPeer[]; everyone?: boolean; mentionPerson?: MentionPerson;
  /** Delivered copies by file name, and the originals those copies came from (copy path -> original). */
  delivered?: DeliveredFiles; originals?: DeliveredFiles;
}) {
  // use() may be called conditionally: only a message that can hold a thread link subscribes to the thread list.
  const { threads, currentBotId } = MAY_LINK_THREAD.test(text) ? use(ThreadRefsContext) : NO_THREAD_REFS;
  const { source, imageOffsets } = normalizeMessageMarkdown(text);
  const needsMath = normalizedSourceHasMath(source);
  const [katexReady, setKatexReady] = useState(() => katexPlugin !== null);
  useEffect(() => {
    if (!needsMath) return;
    if (katexPlugin) {
      setKatexReady(true);
      return;
    }
    let alive = true;
    void ensureChatKatex().then(() => {
      if (alive) setKatexReady(true);
    }, () => {
    });
    return () => {
      alive = false;
    };
  }, [needsMath]);
  const mathPlugin = needsMath && katexReady ? katexPlugin : null;
  const mentions = source.includes("@"), linksThreads = threads.length > 0;
  const variant = `${mathPlugin ? "math" : ""}\u0003${mentions ? `${peerSignature(mentionPeers)}\u0001${everyone ? 1 : 0}\u0001${mentionPerson?.profileName ?? ""}` : ""}\u0003${linksThreads ? `${threadListId(threads)}\u0001${currentBotId ?? ""}` : ""}`;
  // Markdown is a plain function of its options (no hooks), so its elements can be kept and drawn again.
  const markdown = markdownCache.render(text, variant, () => {
    const remarkPlugins = [...BASE_REMARK_PLUGINS];
    if (mentions) remarkPlugins.push([remarkMentions, { peers: mentionPeers, everyone, person: mentionPerson }]);
    if (linksThreads) remarkPlugins.push(remarkThreadRefs(threads, currentBotId));
    return Markdown({ children: source, remarkPlugins, rehypePlugins: rehypePluginsFor(mathPlugin), urlTransform: chatUrlTransform, components: MARKDOWN_COMPONENTS });
  });
  return (
    <MessageScopeContext.Provider value={{ message, imageOffsets, threads, currentBotId, delivered, originals }}>
      <div className="chat-md min-w-0 [&>*+*]:mt-2">{markdown}</div>
    </MessageScopeContext.Provider>
  );
}

export function samePeers(previous: readonly MentionPeer[], next: readonly MentionPeer[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((peer, index) => {
    const other = next[index]!;
    return peer.name === other.name && peer.hidden === other.hidden && peer.color === other.color && peer.person === other.person;
  });
}

export const ChatMarkdown = memo(ChatMarkdownComponent, (previous, next) => (
  previous.text === next.text
  && samePeers(previous.mentionPeers ?? NO_MENTION_PEERS, next.mentionPeers ?? NO_MENTION_PEERS)
  && previous.everyone === next.everyone && sameMentionPerson(previous.mentionPerson, next.mentionPerson)
  && previous.message?.threadId === next.message?.threadId
  && previous.message?.messageId === next.message?.messageId
  && sameDelivered(previous.delivered, next.delivered) && sameDelivered(previous.originals, next.originals)
));

function sameDelivered(previous: DeliveredFiles | undefined, next: DeliveredFiles | undefined): boolean {
  if (previous === next) return true;
  const a = Object.entries(previous ?? {});
  const b = next ?? {};
  return a.length === Object.keys(b).length && a.every(([name, path]) => b[name] === path);
}
