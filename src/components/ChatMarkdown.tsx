// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. A message renders once it is finished, so a code block
// highlights straight away and caches the result for the next mount.
//
// Bidi: message text is written in the user's or the model's language, which
// is independent of the UI language, so every block resolves its own
// direction from its own first strong character — one Arabic paragraph reads
// right-to-left while the English one under it does not. Code is the
// exception: fenced blocks and inline spans pin dir="ltr" and isolate
// themselves, so a snippet never reorders and never scrambles the RTL
// sentence holding it.
import { createContext, memo, use, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { fromMarkdown, type Options as MarkdownParseOptions } from "mdast-util-from-markdown";
import { Check, Copy, Download, LoaderCircle, RotateCcw, WrapText, X } from "lucide-react";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { remarkMentions, type MentionPeer } from "@/lib/mentions";

import {
  countLines,
  downloadSnippetFile,
  formatLineCount,
  getLanguageDisplayName,
  getSnippetFileName,
} from "../lib/code-block";
import { repairMarkdownTables } from "../lib/markdown-tables";
import { TRANSCRIPT_WINDOW_SIZE } from "../lib/transcript-window";
import { windowsPathDestinations } from "../../shared/markdown-windows-paths";
import { githubRefFromProps, remarkGithubRefs } from "@/lib/github-refs";
import { GITHUB_REF_ICONS, LinkHoverCard } from "@/components/LinkHoverCard";
import { looksLikeThreadRefUrl, parseThreadRefUrl, resolveThreadRefAddress, remarkThreadRefs } from "../lib/thread-refs";
import { MarkdownImagePreview, MessageFolderFiles, OutsideWorkspaceFile, saveFailureText, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { ThreadLink, ThreadRefsContext, threadLinkFromProps, type ThreadRefsValue } from "./ThreadRefs";
import { MarkdownTable } from "./MarkdownTable";
import { TableFileButton } from "./TableFilePreview";

// highlighted code, so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content hashes. The two-theme HTML is about 20 to 28 times
// the size of the code, so the cache is bounded by size as well as by count
// (200 large blocks alone held 23 MB). Past either bound the oldest go first.
const highlightCache = new Map<string, string>();
export const HIGHLIGHT_CACHE_MAX = 200;
// about 4 MB of HTML, counted in characters; 200 typical snippets take ~1 MB
export const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
function rememberHighlight(key: string, html: string) {
  // one block bigger than the whole bound would only push everything else out
  if (html.length > HIGHLIGHT_CACHE_MAX_CHARS) return;
  highlightCache.set(key, html);
  let chars = 0;
  for (const cached of highlightCache.values()) chars += cached.length;
  for (const [oldest, oldestHtml] of highlightCache) {
    if (highlightCache.size <= HIGHLIGHT_CACHE_MAX && chars <= HIGHLIGHT_CACHE_MAX_CHARS) break;
    highlightCache.delete(oldest);
    chars -= oldestHtml.length;
  }
}
// rendered mermaid SVGs, keyed by skin scheme + content hash so revisiting a
// thread re-mounts straight from cache — same idea as highlightCache, smaller
// cap because SVGs are bigger than highlighted code
const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_MAX = 50;
// every mermaid.render() call needs an id no earlier call used, including the
// calls that failed and may have left an orphan element behind
let mermaidRenderId = 0;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// Shiki's package entry registers every grammar and theme (hundreds of
// chunks). Chat only ever asks for the two GitHub themes and the languages
// the code-block badge already names, so each of those is its own import and
// the rest never enter the bundle. A fence loads its grammar the first time
// it appears; a later fence for the same language waits on that load.
const LIGHT_THEME = "github-light-default";
const DARK_THEME = "github-dark-default";
const grammarLoaders = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  wasm: () => import("shiki/langs/wasm.mjs"),
};
type GrammarFile = keyof typeof grammarLoaders;
/** Fence ids that are not themselves the grammar file name. */
const grammarAlias: Record<string, GrammarFile> = {
  js: "javascript", node: "javascript",
  ts: "typescript",
  sh: "bash", zsh: "bash", shell: "bash",
  ps1: "powershell",
  py: "python",
  htm: "html",
  yml: "yaml",
  md: "markdown",
  svg: "xml",
  "c++": "cpp", cc: "cpp", cxx: "cpp",
  cs: "csharp", "c#": "csharp",
  rs: "rust",
  golang: "go",
  rb: "ruby",
  kt: "kotlin",
  gql: "graphql",
  protobuf: "proto",
  docker: "dockerfile",
  make: "makefile",
};
const PLAIN_LANGS = new Set(["", "text", "txt", "plaintext", "plain"]);
let highlighterPromise: Promise<HighlighterCore> | undefined;
const grammarLoading = new Map<string, Promise<void>>();

function grammarFile(lang: string): GrammarFile | undefined {
  const alias = grammarAlias[lang];
  if (alias) return alias;
  return Object.prototype.hasOwnProperty.call(grammarLoaders, lang) ? lang as GrammarFile : undefined;
}

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  const created = (async () => {
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    return createHighlighterCore({
      themes: [
        import("shiki/themes/github-light-default.mjs").then((mod) => mod.default),
        import("shiki/themes/github-dark-default.mjs").then((mod) => mod.default),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })().catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  highlighterPromise = created;
  return created;
}

function loadGrammar(highlighter: HighlighterCore, file: GrammarFile): Promise<void> {
  const pending = grammarLoading.get(file);
  if (pending) return pending;
  const next = grammarLoaders[file]().then((mod) => highlighter.loadLanguage(mod.default)).catch((error: unknown) => {
    grammarLoading.delete(file);
    throw error;
  });
  grammarLoading.set(file, next);
  return next;
}

/** Highlight with the two chat themes. A language outside the curated set
 * rejects, and the code block keeps its plain text. */
async function highlightFence(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const requested = lang.trim().toLowerCase();
  const plain = PLAIN_LANGS.has(requested);
  const file = plain ? undefined : grammarFile(requested);
  if (!plain && !file) throw new Error(`No bundled grammar for ${requested}`);
  if (file) await loadGrammar(highlighter, file);
  return highlighter.codeToHtml(code, {
    lang: file ?? "text",
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: "light-dark()",
  });
}
const highlightKey = (lang: string, code: string) => `${lang}:${hash(code)}`;
// Past this size a block stays plain text. Shiki tokenizes on the renderer's
// main thread: 100 KB of TypeScript took 1.1 s, 200 KB 2.3 s and 1 MB 12 s,
// and HTML that big is never cached (HIGHLIGHT_CACHE_MAX_CHARS), so every
// remount froze the window again. Chat snippets sit far below the bound.
export const HIGHLIGHT_MAX_CHARS = 100_000;
const mermaidKey = (scheme: "dark" | "light", code: string) => `${scheme}:${hash(code)}`;

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

export const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password || url.port || url.search || url.hash) return null;
      const path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
      // WHATWG file URLs spell a Windows drive as /C:/ on every host. Only
      // strip that sentinel for an actual file URL: a raw /C:/... Markdown
      // target is a distinct POSIX path and must retain its identity.
      return /^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : absolutePath(path);
    } catch {
      return null;
    }
  }
  if (href.startsWith("\\\\")) return href;
  // Forward-slash //host/path is a protocol-relative web URL in Markdown.
  // UNC remains available through backslashes or file://server/share.
  if (href.startsWith("//")) return null;
  const absolute = absolutePath(href);
  if (absolute) return absolute;
  if (href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  return href;
};

/** Keep only the local URL spellings our message-scoped file renderer knows
 * about; all ordinary links still use react-markdown's protocol allow-list. */
export function chatUrlTransform(value: string): string {
  // thread links render as chips below, never as external anchors; the
  // scheme must survive the allow-list so the anchor component sees it
  if (looksLikeThreadRefUrl(value)) return value;
  // Markdown-to-HTML percent-encodes a destination's backslashes, so
  // C:\Users\Maus\report.md arrives as C:%5CUsers%5CMaus%5Creport.md and no
  // longer looked like a drive path: the link rendered dead and the image as
  // unavailable. Restore the separators; other escapes stay for the server's
  // single decode.
  const url = /^[a-zA-Z]:%5C/i.test(value) ? value.replace(/%5C/gi, "\\") : value;
  if (/^file:\/\//i.test(url) || WINDOWS_PATH.test(url) || url.startsWith("\\\\")) {
    return localFilePath(url) ? url : "";
  }
  return defaultUrlTransform(value);
}

/** Parse link destinations exactly as server/message-file.ts does. */
function remarkWindowsPathDestinations(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push(windowsPathDestinations);
}

// Reuse the renderer's installed GFM plugin, including literal autolinks.
const gfmParseData: {
  micromarkExtensions?: MarkdownParseOptions["extensions"];
  fromMarkdownExtensions?: MarkdownParseOptions["mdastExtensions"];
} = {};
remarkGfm.call({ data: () => gfmParseData });
const normalizationParseOptions: MarkdownParseOptions = {
  extensions: gfmParseData.micromarkExtensions,
  mdastExtensions: [...(gfmParseData.fromMarkdownExtensions ?? []), windowsPathDestinations],
};

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

// Direction is resolved here rather than delegated to HTML's dir="auto",
// because that algorithm skips any descendant carrying its own dir: a
// <blockquote dir="auto"> whose paragraphs each resolve their own direction
// finds no text left to judge and silently falls back to the app's LTR,
// putting its rule on the left of right-to-left prose. Same trap for a table
// whose cells resolve individually — the columns never reverse.
//
// Code is skipped when judging: an answer that opens with `fs.readFileSync`
// and continues in Arabic is an Arabic paragraph, not an English one.
// JS regexes cannot match on Bidi_Class, and naming scripts one at a time has
// no end to it: Hanifi Rohingya, Yezidi, Garay and Old Uyghur are all
// right-to-left, and Unicode keeps adding more. These are instead the blocks
// Unicode reserves for right-to-left letters, so the set stays correct
// without being maintained — and a plane-1 range is one comparison rather
// than a property lookup.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/** Direction of `value`, from its first strong character (letters only —
 * digits and punctuation are directionally weak). Defaults to "ltr". */
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

/** Direction a rendered block adopts, read from its own text. */
export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

/** Props react-markdown hands a block component we only re-tag. */
interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}

/** Props for the {@link CodeBlock} component. */
export interface CodeBlockProps {
  /** Source code snippet to display. */
  code: string;
  /** Language identifier from markdown fence, e.g. "ts", "python". */
  lang: string;
}

/**
 * Chromed code block component for rendered markdown messages.
 * Features syntax highlighting with Shiki, language normalization badge,
 * line count indicator, word wrap toggle, and accessible clipboard copy with status feedback.
 *
 * @param props - Component props containing code string and language identifier.
 * @returns Rendered code block element.
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  // a block highlighted before (revisiting a thread) paints highlighted in
  // its first frame instead of plain first and highlighted after the effect
  const highlightable = code.length <= HIGHLIGHT_MAX_CHARS;
  const [html, setHtml] = useState<string | null>(() => highlightable ? highlightCache.get(highlightKey(lang, code)) ?? null : null);
  // React compares dangerouslySetInnerHTML by identity: a fresh object each
  // render would rebuild the highlighted DOM on every re-render
  const markup = useMemo(() => (html ? { __html: html } : null), [html]);
  const { state: copied, copy } = useCopyFeedback(code);
  const [wrapLines, setWrapLines] = useState(false);

  useEffect(() => {
    // a block too big to highlight keeps the plain <pre>
    if (!highlightable) return setHtml(null);
    const key = highlightKey(lang, code);
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    highlightFence(code, lang || "text")
      .then((out) => {
        if (!alive) return;
        rememberHighlight(key, out);
        setHtml(out);
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, highlightable]);

  const download = () => {
    const filename = getSnippetFileName(lang);
    downloadSnippetFile(filename, code);
  };

  const displayLanguage = getLanguageDisplayName(lang);
  const lineCount = countLines(code);

  // Code reads left-to-right whatever language surrounds it, so the block pins
  // its own direction rather than inheriting the message's.
  return (
    <div dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span title={displayLanguage} className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-ink select-none">
            {displayLanguage}
          </span>
          {lineCount > 0 && (
            <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-secondary select-none">
              {formatLineCount(lineCount)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              wrapLines
                ? "bg-accent/15 text-accent font-medium"
                : "text-ink-secondary hover:bg-raised hover:text-ink"
            }`}
            title={wrapLines ? "Disable line wrapping" : "Wrap long lines"}
            aria-label={wrapLines ? "Disable line wrapping" : "Wrap long lines"}
            aria-pressed={wrapLines}
          >
            <WrapText size={12} aria-hidden="true" />
            <span className="hidden sm:inline">{wrapLines ? "Unwrap" : "Wrap"}</span>
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title="Download snippet as file"
            aria-label="Download snippet as file"
          >
            <Download size={12} aria-hidden="true" />
            <span className="hidden sm:inline">Save</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? "Copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy code"}
            aria-label={copied === "copied" ? "Code copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy code to clipboard"}
          >
            {copied === "failed" ? (
              <>
                <X size={12} className="text-danger" aria-hidden="true" />
                <span className="text-danger font-medium hidden sm:inline">{t("common.copyFailed")}</span>
              </>
            ) : copied === "copied" ? (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                <span className="text-success font-medium hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      {markup ? (
        <div
          className={`text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3 ${
            wrapLines
              ? "whitespace-pre-wrap break-words overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_code]:!whitespace-pre-wrap [&_code]:!break-words"
              : "overflow-x-auto"
          }`}
          dangerouslySetInnerHTML={markup}
        />
      ) : (
        <pre
          className={`p-3 text-[13px] leading-relaxed text-ink ${
            wrapLines
              ? "whitespace-pre-wrap break-words overflow-x-hidden"
              : "overflow-x-auto"
          }`}
        >
          {code}
        </pre>
      )}
    </div>
  );
}

/** Scheme of the nearest skin, read the same way the Shiki blocks read it:
 * from the --code-color-scheme token, which resolves through any data-skin
 * subtree. Anything unreadable falls back to dark, the default skin's value. */
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

/** Props for the {@link MermaidDiagram} component. */
export interface MermaidDiagramProps {
  /** Mermaid diagram source from a fenced code block. */
  code: string;
}

const MERMAID_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF UI Text", "Segoe UI", system-ui, sans-serif';

/**
 * Mermaid fence renderer: draws the diagram instead of highlighting its
 * source. Mermaid is a heavy import, so it loads only when a diagram fence
 * actually appears — the same lazy pattern Shiki uses. The SVG
 * mermaid.render() returns under securityLevel "strict" is the only thing
 * injected; a diagram that fails to parse falls back to its source with the
 * error above it.
 *
 * @param props - Component props containing the mermaid source.
 * @returns Rendered diagram, or the source with the parse error.
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [skinEpoch, setSkinEpoch] = useState(0);
  // a diagram drawn before paints in its first frame, in the page's scheme;
  // the effect below re-checks the scheme against the frame itself
  const [svg, setSvg] = useState<string | null>(() =>
    mermaidCache.get(mermaidKey(mermaidScheme(typeof document === "undefined" ? null : document.documentElement), code)) ?? null);
  // stable for the same SVG, so a re-render keeps the drawn diagram's DOM
  const markup = useMemo(() => (svg ? { __html: svg } : null), [svg]);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const { state: copied, copy } = useCopyFeedback(code);

  // Skins are stamped on <html>, a subtree could someday carry its own, so
  // watch the whole document for data-skin changes and re-render the diagram
  // in the new scheme. Both schemes stay cached, like Shiki's dual palette.
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

  // Diagrams read left-to-right whatever language surrounds them, so the
  // frame pins its own direction rather than inheriting the message's.
  return (
    <div ref={frame} dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
        <span title="Mermaid diagram" className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-ink select-none">
          Mermaid diagram
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
            title={showSource ? "Hide diagram source" : "Show diagram source"}
            aria-label={showSource ? "Hide diagram source" : "Show diagram source"}
            aria-pressed={showSource}
          >
            <WrapText size={12} aria-hidden="true" />
            <span className="hidden sm:inline">{showSource ? "Hide source" : "Show source"}</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? "Copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy diagram source"}
            aria-label={copied === "copied" ? "Diagram source copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy diagram source to clipboard"}
          >
            {copied === "failed" ? (
              <>
                <X size={12} className="text-danger" aria-hidden="true" />
                <span className="text-danger font-medium hidden sm:inline">{t("common.copyFailed")}</span>
              </>
            ) : copied === "copied" ? (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                <span className="text-success font-medium hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
          Diagram could not be rendered: {error}
        </p>
      )}
      {markup && (
        <div
          className="overflow-x-auto p-3 [&_svg]:!max-w-full"
          dangerouslySetInnerHTML={markup}
        />
      )}
      {(showSource || !svg || error) && (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}

// A bot handing over a file it created renders as a button, not an anchor.
// Two reasons the href is dropped rather than merely preventDefault()ed:
// an absolute path in an href resolves against the page origin, so the link
// pointed at http://127.0.0.1:8799<path> and opened the chat UI in a browser;
// and an <a href="file://…"> would still reach setWindowOpenHandler on a
// middle or modifier click, which calls shell.openExternal without the main
// process' containment check.
function LocalFileLink({ filePath, name, children, message }: { filePath: string; name?: string; children?: ReactNode; message?: MessageAttachmentContext }) {
  const save = useLocalFileSave(filePath, name, message);
  if (!message) {
    return <span title="Unavailable legacy file reference" className="break-words text-ink-secondary">{children}</span>;
  }
  const label = save.state === "saving"
    ? "Saving…"
    : save.state === "saved"
      ? "Saved"
      : save.state === "failed"
        ? "Retry"
        : null;

  return (
    <span dir="ltr" className="inline-flex flex-wrap items-center gap-x-1.5 [unicode-bidi:isolate]">
      <TableFileButton path={filePath} name={name ?? fileName(filePath)} message={message} />
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        title="Save a copy"
        className="inline-flex items-center gap-1 break-words text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {children}
        {save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : save.state === "failed" ? (
          !save.outsideWorkspace && <RotateCcw size={12} className="shrink-0" aria-hidden="true" />
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
    </span>
  );
}

export function markdownImageName(src: string, alt?: string): string {
  const supplied = alt?.trim();
  if (supplied) return supplied;
  try {
    const path = decodeURIComponent(new URL(src, "https://openmausbot.invalid").pathname);
    const name = path.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
    if (name) return name;
  } catch {
    // A malformed source still gets a useful accessible fallback.
  }
  return "Image";
}

export function markdownImageOpenUrl(src: string): string | undefined {
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Spoiler spans: GFM parses ~~text~~ to <del>; in bot messages that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
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
          aria-label="Reveal spoiler"
          title="Reveal spoiler"
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
        aria-label="Hide spoiler"
        title="Hide spoiler"
        onClick={() => setRevealed(false)}
        className="ms-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

const NO_MENTION_PEERS: readonly MentionPeer[] = [];

// A markdown image resolves its attachment by its original source offset.
const MARKDOWN_IMAGE = "![";

// A currency sign glued to its code and followed by an amount ("R$ 120",
// "US$5") is money, never a math delimiter.
const CURRENCY_DOLLAR = /(?<![$\p{L}\p{N}])(?:R|US|AU|A|CA|C|NZ|HK|SG|S|MX|NT|BZ|Z)\$(?=[ \t\u00a0]?\d)/gu;

/** Escape every single `$` that cannot delimit inline math, so prices such as
 * "$5 and $10" or "R$ 120 ... R$ 120" stay prose instead of turning the text
 * between them into a formula. Follows Pandoc's rule: an opening `$` is
 * followed by non-space, a closing `$` is preceded by non-space and not
 * followed by a digit, and the pair stays inside one paragraph. A `$` that
 * fails as a closer abandons the open span rather than skipping past it. */
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

/** Convert the TeX delimiters models commonly emit into remark-math syntax.
 * Fenced and inline code are protected so examples such as `\\(x\\)` remain
 * literal. Unmatched delimiters are left untouched, and dollar signs that
 * read as money are escaped. */
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
    // Explicit links leave their labels available for math normalization;
    // protect only the trailing destination syntax. Autolinks stay intact.
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
    // remark-math treats flow math as a block only when the fences occupy
    // their own lines; accept the compact form models commonly produce.
    .replace(/\$\$[ \t]*([^\n][\s\S]*?)[ \t]*\$\$/g, (_match, math: string) => `$$\n${math}\n$$`);
  normalized = escapeLiteralDollars(normalized);
  let shift = 0;
  // oxlint-disable-next-line no-control-regex -- restore opaque code and image sentinels
  normalized = normalized.replace(/\u0000OMB_CODE_(\d+)\u0000/g, (token, index: string, at: number) => {
    const part = protectedCode[Number(index)];
    if (!part) return token;
    const { value, sourceOffset } = part;
    // A protected reference link can contain images of its own. Their raw
    // positions stay relative to that unchanged span when it is restored.
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

// Table repair and math normalization each parse the whole message on top of
// react-markdown's own parse, and what they produce depends on the text alone.
// Keep it per text, so a bubble that renders again (a thread list change under
// a message holding a '#') or mounts again (a thread revisited, the raw view
// toggled off) skips both parses. Two transcript windows' worth: the open
// thread and the one before it.
const normalizedCache = new Map<string, Pick<MessageScope, "imageOffsets"> & { source: string }>();
const NORMALIZED_CACHE_MAX = TRANSCRIPT_WINDOW_SIZE * 2;

function normalizeMessageMarkdown(text: string) {
  const cached = normalizedCache.get(text);
  if (cached) return cached;
  // A near-miss table from a model renders as an unreadable run of pipes
  // unless it is repaired before parsing. Table repair moves image source
  // offsets, so image messages skip that repair but still normalize math.
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

// KaTeX is a large parse of the main bundle. It loads the first time a
// message actually contains math, the same way Mermaid waits for a diagram
// fence. The stylesheet travels with that chunk, not with the first paint.
let katexPlugin: KatexPlugin | null = null;
let katexLoad: Promise<void> | null = null;

/** Load rehype-katex and, in the browser, its stylesheet. Static markup
 * tests call this first: renderToStaticMarkup does not run the effect that
 * loads it for a real message. */
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

/** True when normalized markdown still has a `$` or `$$` span. Currency was
 * escaped to `\$` and code fences were restored unchanged, so a price line
 * does not match. A dollar that survived inside code may match; loading
 * KaTeX for that is cheaper than missing a real formula. */
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

/** Whether this message should pull in KaTeX. */
export function messageNeedsKatex(text: string): boolean {
  return normalizedSourceHasMath(normalizeMessageMarkdown(text).source);
}

/** What a message's element renderers need from that message. The renderers
 * are defined once, below: react-markdown makes each one an element type,
 * and a fresh function per render would hand React a new type for every
 * element, so a re-render with unchanged text would throw the whole message
 * away and build it again (code highlights, wrap, copy, spoiler and save
 * state included). Per-message values reach them through this context. */
interface MessageScope {
  message?: MessageAttachmentContext;
  /** markdown image offsets after math normalization → offsets in the stored text */
  imageOffsets?: Map<number, number>;
  threads: ThreadRefsValue["threads"];
  currentBotId?: string;
  /** Files the bot delivered with attach_file, by name. An inline link to one
   * of them saves that delivered copy, so the file shows once, in the text. */
  delivered?: DeliveredFiles;
}

/** A delivered file's name to its stored attachment path. */
export type DeliveredFiles = Readonly<Record<string, string>>;

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const MessageScopeContext = createContext<MessageScope>({ threads: [] });

function MarkdownCode({ children }: { children?: ReactNode }) {
  // fenced code arrives as <pre><code class="language-x">…</code></pre>
  const child: any = Array.isArray(children) ? children[0] : children;
  const className: string = child?.props?.className ?? "";
  const lang = /language-([^\s]+)/.exec(className)?.[1] ?? "";
  // children can be a string OR an array of strings/nodes — flatten
  // strings only, so String() never comma-joins an array
  const flat = (n: any): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
  const code = flat(child?.props?.children).replace(/\n$/, "");
  // a mermaid fence is a picture, not a program: hand it to the
  // diagram renderer instead of the highlighter
  if (lang.trim().toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code} />;
  }
  return <CodeBlock code={code} lang={lang} />;
}

function MarkdownImage(props: ComponentProps<"img"> & ExtraProps) {
  const { message, imageOffsets } = useContext(MessageScopeContext);
  const { src, alt } = props;
  if (!src) {
    return <span className="text-[12px] text-danger" role="alert">Image unavailable</span>;
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
  const { threads, currentBotId, message, delivered } = useContext(MessageScopeContext);
  // a canonical thread link is a chip whatever text carries it;
  // a dead one keeps its label as plain text rather than handing
  // the app's own scheme to the shell
  const address = href ? parseThreadRefUrl(href) : null;
  const ref = address ? resolveThreadRefAddress(threads, address, currentBotId) : null;
  if (ref) return <ThreadLink target={ref} ambiguous={ref.ambiguous}>{children}</ThreadLink>;
  if (address || (href && looksLikeThreadRefUrl(href))) return <span className="break-words">{children}</span>;
  const localPath = localFilePath(href);
  if (localPath) {
    const copy = delivered && Object.hasOwn(delivered, fileName(localPath)) ? delivered[fileName(localPath)] : undefined;
    return <LocalFileLink filePath={copy ?? localPath} name={copy ? fileName(localPath) : undefined} message={message}>{children}</LocalFileLink>;
  }
  if (!href || !/^https?:\/\//i.test(href)) {
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
      {(anchor) => Icon ? (
        // a GitHub reference reads as a small pill. Left to right and
        // isolated, so "#2547" never turns into "2547#" in a right-to-left
        // line. The full address is the tooltip.
        <a {...anchor} href={href} target="_blank" rel="noreferrer" dir="ltr" title={href} data-github-ref={github!.kind} className={GITHUB_REF_CLASS}>
          <Icon size={13} aria-hidden="true" className="shrink-0 self-center text-ink-tertiary" />
          <span>{children}</span>
        </a>
      ) : (
        <a {...anchor} href={href} target="_blank" rel="noreferrer" dir="auto" className={LINK_CLASS}>
          {children}
        </a>
      )}
    </LinkHoverCard>
  );
}

const LINK_CLASS = "break-words text-accent underline decoration-accent/40 hover:decoration-accent [unicode-bidi:isolate]";
const GITHUB_REF_CLASS =
  "inline-flex items-baseline gap-1 whitespace-nowrap rounded-full bg-inset px-1.5 align-baseline font-mono text-[0.88em] text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [unicode-bidi:isolate]";

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownCode,
  img: MarkdownImage,
  code({ children }: { children?: ReactNode }) {
    // break-words because a path or an identifier can be longer than
    // the bubble is wide, and an unbreakable token has nowhere to go
    // but outside it — off the left edge in a right-to-left paragraph,
    // where the line ends.
    return (
      <code dir="ltr" className="ui-code-chip break-words [unicode-bidi:isolate]">{children}</code>
    );
  },
  // markdown never emits a span itself (no raw HTML); the only
  // spans are the ones our remark plugins produced — a thread link,
  // or an @mention highlight that must keep its class and colour
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
    return <div dir={blockDirection(node)} className="mt-2 text-[16px] font-semibold">{children}</div>;
  },
  h2({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-2 text-[15.5px] font-semibold">{children}</div>;
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
    return <div dir={blockDirection(node)} className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
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

// A thread link only ever comes from a "#Title" run or a canonical
// openmausbot://thread/ link, whatever case or escaping its scheme uses.
const MAY_LINK_THREAD = /#|openmausbot/i;
const NO_THREAD_REFS: ThreadRefsValue = { threads: [] };

/** Render message Markdown with math, protected code, scoped attachments, and mentions. */
function ChatMarkdownComponent({ text, message, mentionPeers = NO_MENTION_PEERS, everyone = false, delivered }: {
  text: string; message?: MessageAttachmentContext;
  mentionPeers?: readonly MentionPeer[]; everyone?: boolean;
  delivered?: DeliveredFiles;
}) {
  // "#Title" mentions link to the threads the person can see (ThreadRefs);
  // @mentions were already decorated by remarkMentions, which runs first.
  // Only a message that can hold a thread link reads the thread list (use()
  // may be called conditionally), so opening or renaming a thread, renaming
  // a bot or changing the selection leaves every other bubble alone.
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
      // Keep the formula readable as source. A later math message can retry
      // a failed download instead of inheriting a permanently rejected load.
    });
    return () => {
      alive = false;
    };
  }, [needsMath]);
  const mathPlugin = needsMath && katexReady ? katexPlugin : null;
  return (
    <MessageScopeContext.Provider value={{ message, imageOffsets, threads, currentBotId, delivered }}>
      <div className="chat-md min-w-0 [&>*+*]:mt-2">
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath, remarkWindowsPathDestinations, unwrapLinkedImages, remarkGithubRefs, [remarkMentions, { peers: mentionPeers, everyone }], remarkThreadRefs(threads, currentBotId)]}
          rehypePlugins={mathPlugin ? [mathPlugin] : []}
          urlTransform={chatUrlTransform}
          components={MARKDOWN_COMPONENTS}
        >
          {source}
        </Markdown>
      </div>
    </MessageScopeContext.Provider>
  );
}

/** Compare the roster by the fields that actually change the render, not by
 * identity. Both callers derive this list from `state.bots` / group members
 * with `useMemo`, and the reducer rebuilds those arrays with `.map()` on every
 * bot patch — so a reference test fails on events that changed nothing here,
 * and every mounted bubble re-parses its markdown. Rosters are small; this
 * walk is far cheaper than the re-render it prevents. */
export function samePeers(previous: readonly MentionPeer[], next: readonly MentionPeer[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((peer, index) => {
    const other = next[index]!;
    return peer.name === other.name && peer.hidden === other.hidden && peer.color === other.color;
  });
}

export const ChatMarkdown = memo(ChatMarkdownComponent, (previous, next) => (
  previous.text === next.text
  && samePeers(previous.mentionPeers ?? NO_MENTION_PEERS, next.mentionPeers ?? NO_MENTION_PEERS)
  && previous.everyone === next.everyone
  && previous.message?.threadId === next.message?.threadId
  && previous.message?.messageId === next.message?.messageId
  && sameDelivered(previous.delivered, next.delivered)
));

function sameDelivered(previous: DeliveredFiles | undefined, next: DeliveredFiles | undefined): boolean {
  if (previous === next) return true;
  const a = Object.entries(previous ?? {});
  const b = next ?? {};
  return a.length === Object.keys(b).length && a.every(([name, path]) => b[name] === path);
}
