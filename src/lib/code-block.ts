/**
 * Utilities for formatting and inspecting source code blocks rendered in chat.
 * Provides language display normalization, accurate line counting, and line count formatting.
 */

/** Known language identifier mappings for user-friendly display labels. */
const KNOWN_LANGUAGES: Record<string, string> = {
  // JavaScript & TypeScript
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript (TSX)",
  node: "Node.js",

  // Web & Styling
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

  // Shell & Scripts
  sh: "Bash",
  bash: "Bash",
  zsh: "Bash",
  shell: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  fish: "Fish",

  // Systems & General Purpose Languages
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

  // Query & Data
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  protobuf: "Protobuf",

  // Dev & Infra
  docker: "Dockerfile",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  make: "Makefile",
  diff: "Diff",
  wasm: "WebAssembly",
};

/**
 * Returns a human-friendly display label for a code block language identifier.
 *
 * @param lang - Raw language identifier from markdown fence (e.g. "ts", "py", "sh").
 * @returns Normalized language name (e.g. "TypeScript", "Python", "Bash"), or "Code" if unspecified.
 *
 * @example
 * ```ts
 * getLanguageDisplayName("ts"); // "TypeScript"
 * getLanguageDisplayName("py"); // "Python"
 * getLanguageDisplayName("");   // "Code"
 * ```
 */
export function getLanguageDisplayName(lang?: string | null): string {
  if (!lang || !lang.trim()) {
    return "Code";
  }

  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_LANGUAGES, normalized)) {
    return KNOWN_LANGUAGES[normalized] ?? normalized;
  }

  // Fallback: capitalize first character if unknown (e.g. "zig" -> "Zig")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Counts rendered lines, including deliberate trailing blank lines.
 * ChatMarkdown already removes the newline added by the Markdown renderer.
 *
 * @param code - Raw source code string.
 * @returns Total number of lines (0 if empty, >= 1 otherwise).
 *
 * @example
 * ```ts
 * countLines("console.log(1);"); // 1
 * countLines("a\nb\n");          // 3
 * countLines("");                // 0
 * ```
 */
export function countLines(code?: string | null): number {
  if (!code) {
    return 0;
  }

  return code.split(/\r\n|\r|\n/).length;
}

/**
 * Formats a numeric line count into a readable label with proper singular/plural grammar.
 *
 * @param count - Total line count.
 * @returns Formatted label such as "1 line" or "42 lines".
 *
 * @example
 * ```ts
 * formatLineCount(1);  // "1 line"
 * formatLineCount(15); // "15 lines"
 * ```
 */
export function formatLineCount(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/** Known file extension mappings for language identifiers. */
const KNOWN_EXTENSIONS: Record<string, string> = {
  // JavaScript & TypeScript
  js: "js",
  javascript: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  node: "js",

  // Web & Styling
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

  // Shell & Scripts
  sh: "sh",
  bash: "sh",
  zsh: "zsh",
  shell: "sh",
  ps1: "ps1",
  powershell: "ps1",
  fish: "fish",

  // Systems & General Purpose
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

  // Query & Data
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  protobuf: "proto",

  // Dev & Infra
  docker: "dockerfile",
  dockerfile: "dockerfile",
  makefile: "makefile",
  make: "makefile",
  diff: "diff",
  wasm: "wasm",
};

/**
 * Resolves the appropriate file extension for a code block language identifier.
 *
 * @param lang - Raw language identifier from markdown fence (e.g. "ts", "python", "sh").
 * @returns File extension without leading dot (e.g. "ts", "py", "sh"), defaulting to "txt" if unknown or omitted.
 *
 * @example
 * ```ts
 * getCodeFileExtension("python"); // "py"
 * getCodeFileExtension("ts");     // "ts"
 * getCodeFileExtension("");       // "txt"
 * ```
 */
export function getCodeFileExtension(lang?: string | null): string {
  if (!lang || !lang.trim()) {
    return "txt";
  }

  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_EXTENSIONS, normalized)) {
    return KNOWN_EXTENSIONS[normalized] ?? "txt";
  }

  // If identifier is simple alphanumeric and short (<= 8 chars), use it directly
  if (/^[a-z0-9_-]{1,8}$/.test(normalized)) {
    return normalized;
  }

  return "txt";
}

/**
 * Returns a clean default filename for saving a code snippet based on its language.
 *
 * @param lang - Raw language identifier from markdown fence.
 * @returns Default filename such as "snippet.py" or "snippet.ts".
 *
 * @example
 * ```ts
 * getSnippetFileName("python"); // "snippet.py"
 * getSnippetFileName("ts");     // "snippet.ts"
 * getSnippetFileName(null);     // "snippet.txt"
 * ```
 */
export function getSnippetFileName(lang?: string | null): string {
  const ext = getCodeFileExtension(lang);
  return ext === "dockerfile" || ext === "makefile" ? ext : `snippet.${ext}`;
}

/**
 * Triggers a client-side file download for source code content.
 * Safely handles browser environment checks and cleans up created Object URLs.
 *
 * @param filename - Name of the file to save (e.g. "snippet.py").
 * @param code - Content of the code snippet.
 */
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
    // Chromium may consume the Blob after the click task. The browser owns
    // save/cancel feedback; a click is not evidence that the file was saved.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
