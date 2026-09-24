// Code highlighting for chat code blocks. The full Shiki bundle ships ~300
// grammars (the app's dist grew to 11 MB); this loads a curated set on demand
// with the JavaScript regex engine (no WASM). Anything else stays plain text.
import type { HighlighterCore, LanguageInput } from "shiki/core";

const THEME = "github-dark-default";

const LANGS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  py: "python",
  golang: "go",
  rs: "rust",
  htm: "html",
  md: "markdown",
  yml: "yaml",
  patch: "diff",
  kt: "kotlin",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  svg: "xml",
  docker: "dockerfile",
};

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark-default.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme]) =>
    createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  return highlighter;
}

/** Resolves a fence label ("ts", "Bash") to a supported grammar, or null. */
export function resolveLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  const name = ALIASES[key] ?? key;
  return name in LANGS ? name : null;
}

/** Highlighted HTML for `code`, or null when the language isn't supported. */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const name = resolveLanguage(lang);
  if (!name) return null;
  const core = await getHighlighter();
  let ready = loaded.get(name);
  if (!ready) {
    ready = LANGS[name]!().then((mod) => core.loadLanguage(mod.default));
    loaded.set(name, ready);
    ready.catch(() => loaded.delete(name));
  }
  await ready;
  return core.codeToHtml(code, { lang: name, theme: THEME });
}
