import { t } from "./i18n";
const KNOWN_LANGUAGES: Record<string, string> = {
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript (TSX)",
  node: "Node.js",

  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON5",
  xml: "XML",
  svg: "SVG",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",

  sh: "Bash",
  bash: "Bash",
  zsh: "Bash",
  shell: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  fish: "Fish",

  c: "C",
  cpp: "C++",
  "c++": "C++",
  cc: "C++",
  cxx: "C++",
  cs: "C#",
  csharp: "C#",
  "c#": "C#",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  golang: "Go",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  php: "PHP",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  dart: "Dart",
  r: "R",
  lua: "Lua",

  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  protobuf: "Protobuf",

  docker: "Dockerfile",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  make: "Makefile",
  diff: "Diff",
  wasm: "WebAssembly",
};

export function getLanguageDisplayName(lang?: string | null): string {
  if (!lang || !lang.trim()) {
    return "Code";
  }

  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_LANGUAGES, normalized)) {
    return KNOWN_LANGUAGES[normalized] ?? normalized;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function countLines(code?: string | null): number {
  if (!code) {
    return 0;
  }

  return code.split(/\r\n|\r|\n/).length;
}

export function formatLineCount(count: number): string {
  return count === 1 ? t("code.lineOne") : t("code.lines", { count });
}

const KNOWN_EXTENSIONS: Record<string, string> = {
  js: "js",
  javascript: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  node: "js",

  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  jsonc: "json",
  json5: "json5",
  xml: "xml",
  svg: "svg",
  md: "md",
  markdown: "md",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",

  sh: "sh",
  bash: "sh",
  zsh: "zsh",
  shell: "sh",
  ps1: "ps1",
  powershell: "ps1",
  fish: "fish",

  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "cs",
  csharp: "cs",
  "c#": "cs",
  rs: "rs",
  rust: "rs",
  go: "go",
  golang: "go",
  py: "py",
  python: "py",
  rb: "rb",
  ruby: "rb",
  php: "php",
  java: "java",
  kt: "kt",
  kotlin: "kt",
  swift: "swift",
  dart: "dart",
  r: "r",
  lua: "lua",

  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  protobuf: "proto",

  docker: "dockerfile",
  dockerfile: "dockerfile",
  makefile: "makefile",
  make: "makefile",
  diff: "diff",
  wasm: "wasm",
};

export function getCodeFileExtension(lang?: string | null): string {
  if (!lang || !lang.trim()) {
    return "txt";
  }

  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_EXTENSIONS, normalized)) {
    return KNOWN_EXTENSIONS[normalized] ?? "txt";
  }

  if (/^[a-z0-9_-]{1,8}$/.test(normalized)) {
    return normalized;
  }

  return "txt";
}

export function getSnippetFileName(lang?: string | null): string {
  const ext = getCodeFileExtension(lang);
  return ext === "dockerfile" || ext === "makefile" ? ext : `snippet.${ext}`;
}

export function downloadSnippetFile(filename: string, code: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Chromium may consume the Blob after the click task.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** The fence info arrives split: the first word rides on the code element's language class and the
 * rest on its data.meta, so only both halves together name the language and find the wrap directive. */
export function parseFenceInfo(lang: string, meta: unknown): { lang: string; wrap: boolean } {
  const words = [...(lang ? [lang] : []), ...(typeof meta === "string" ? meta.split(/\s+/) : [])].filter(Boolean);
  const isWrap = (word: string) => word.toLowerCase() === "wrap";
  return { wrap: words.some(isWrap), lang: words.find((word) => !isWrap(word)) ?? "" };
}
