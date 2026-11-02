// Security: Shiki's output is generator-escaped; nothing else reaches the DOM as HTML.
import { useEffect, useMemo, useState } from "react";
import type { HighlighterCore } from "shiki/core";
import { Check, Copy, Download, MoreHorizontal, WrapText, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { countLines, downloadSnippetFile, formatLineCount, getLanguageDisplayName, getSnippetFileName } from "../lib/code-block";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const highlightCache = new Map<string, string>();
export const HIGHLIGHT_CACHE_MAX = 200;
export const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
function rememberHighlight(key: string, html: string) {
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

/** A short stable hash for cache keys. */
export const codeHash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// Shiki's package entry registers every grammar and theme (hundreds of chunks), so each one is imported on its own.
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
const highlightKey = (lang: string, code: string) => `${lang}:${codeHash(code)}`;
// Shiki tokenizes on the renderer's main thread: 100 KB of TypeScript took 1.1 s, 1 MB took 12 s.
export const HIGHLIGHT_MAX_CHARS = 100_000;

export interface CodeBlockProps {
  code: string;
  lang: string;
  initialWrap?: boolean;
}

const PLATE_BUTTON = "inline-flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/** Simple mode's hover plate on a code block or diagram: Copy, and a ⋯ menu for the rest. It shows on hover, on
 * keyboard focus and always on touch screens, and stays while its menu is open. */
export function CodePlate({ copied, onCopy, copyLabel, items }: {
  copied: "idle" | "copied" | "failed";
  onCopy: () => void;
  copyLabel: string;
  items: SidebarMenuItem[];
}) {
  return (
    <div data-code-plate className="absolute end-1 top-1 z-[1] flex gap-0.5 rounded-full bg-composer p-0.5 opacity-0 ring-[0.5px] ring-ink/10 transition-opacity focus-within:opacity-100 group-hover/code:opacity-100 touch:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      <button type="button" onClick={onCopy} className={PLATE_BUTTON}
        title={copied === "copied" ? t("code.copiedTitle") : copied === "failed" ? t("common.copyFailed") : copyLabel}
        aria-label={copied === "copied" ? t("code.copiedTitle") : copied === "failed" ? t("common.copyFailed") : copyLabel}>
        {copied === "failed" ? <X size={14} className="text-danger" aria-hidden="true" />
          : copied === "copied" ? <Check size={14} className="text-success" aria-hidden="true" />
            : <Copy size={14} aria-hidden="true" />}
      </button>
      {copied !== "idle" && <span role="status" className="sr-only">{copied === "failed" ? t("common.copyFailed") : t("code.copiedTitle")}</span>}
      <SidebarPopoverMenu items={items} ariaLabel={t("chat.more")} placement="below" triggerClassName="rounded-full" triggerTitle={t("chat.more")}
        renderTrigger={() => <span className={PLATE_BUTTON}><MoreHorizontal size={14} aria-hidden="true" /></span>} />
    </div>
  );
}

export function CodeBlock({ code, lang, initialWrap = false }: CodeBlockProps) {
  const simple = !useAdvancedMode();
  const highlightable = code.length <= HIGHLIGHT_MAX_CHARS;
  const [html, setHtml] = useState<string | null>(() => highlightable ? highlightCache.get(highlightKey(lang, code)) ?? null : null);
  // React compares dangerouslySetInnerHTML by identity: a fresh object each render rebuilds the highlighted DOM.
  const markup = useMemo(() => (html ? { __html: html } : null), [html]);
  const { state: copied, copy } = useCopyFeedback(code);
  const [wrapLines, setWrapLines] = useState(initialWrap);
  useEffect(() => {
    setWrapLines(initialWrap);
  }, [initialWrap]);

  useEffect(() => {
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
  const body = (pad: string, plainInk: string) => markup ? (
    <div
      className={cn(`text-[13px] [&_pre]:!bg-transparent [&_pre]:m-0 ${pad}`, wrapLines
        ? "whitespace-pre-wrap break-words overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_code]:!whitespace-pre-wrap [&_code]:!break-words"
        : "overflow-x-auto")}
      dangerouslySetInnerHTML={markup}
    />
  ) : (
    <pre className={cn(`text-[13px] ${pad.replaceAll("[&_pre]:", "")}`, plainInk, wrapLines ? "whitespace-pre-wrap break-words overflow-x-hidden" : "overflow-x-auto")}>
      {code}
    </pre>
  );

  if (simple) {
    return (
      <div dir="ltr" className="chat-code-block group/code relative my-2.5 overflow-hidden rounded-lg bg-ink/[0.04]">
        <CodePlate copied={copied} onCopy={copy} copyLabel={t("code.copyTitle")} items={[
          { key: "wrap", label: t("code.wrapLines"), icon: <WrapText size={14} aria-hidden="true" />, active: wrapLines, onSelect: () => setWrapLines((wrap) => !wrap) },
          { key: "save", label: t("code.saveAsFile"), icon: <Download size={14} aria-hidden="true" />, onSelect: download },
          { key: "about", label: t("code.caption", { language: displayLanguage, lines: formatLineCount(lineCount) }), disabled: true, separatorBefore: true, onSelect: () => {} },
        ]} />
        {body("leading-5 [&_pre]:px-3 [&_pre]:py-2", "text-ink-secondary")}
      </div>
    );
  }

  return (
    <div dir="ltr" className="chat-code-block my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
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
        <div className="chat-code-actions flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              wrapLines
                ? "bg-accent/15 text-accent font-medium"
                : "text-ink-secondary hover:bg-raised hover:text-ink"
            }`}
            title={wrapLines ? t("code.unwrapLong") : t("code.wrapLong")}
            aria-label={wrapLines ? t("code.unwrapLong") : t("code.wrapLong")}
            aria-pressed={wrapLines}
          >
            <WrapText size={12} aria-hidden="true" />
            <span>{wrapLines ? t("code.unwrap") : t("code.wrap")}</span>
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={t("code.saveTitle")}
            aria-label={t("code.saveTitle")}
          >
            <Download size={12} aria-hidden="true" />
            <span>{t("code.save")}</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? t("code.copiedTitle") : copied === "failed" ? t("common.copyFailed") : t("code.copyTitle")}
            aria-label={copied === "copied" ? t("code.copiedAria") : copied === "failed" ? t("common.copyFailed") : t("code.copyAria")}
          >
            {copied === "failed" ? <X size={12} className="text-danger" aria-hidden="true" />
              : copied === "copied" ? <Check size={12} className="text-success" aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
            <span aria-hidden="true" className="hidden max-sm:inline touch:inline">{t("code.copy")}</span>
            <span role="status" className={`max-sm:sr-only touch:sr-only ${copied === "failed" ? "text-danger font-medium" : copied === "copied" ? "text-success font-medium" : ""}`}>
              {copied === "failed" ? t("common.copyFailed") : copied === "copied" ? t("code.copied") : t("code.copy")}
            </span>
          </button>
        </div>
      </div>
      {body("leading-relaxed [&_pre]:p-3", "text-ink")}
    </div>
  );
}
