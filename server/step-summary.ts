// Security: every word here comes from the call's display summary and input preview, which are already redacted, and is
// redacted again before it is cut. An environment assignment's value never leaves: the target skips assignments and the
// detail masks their values.
import { progressFile, type LiveStep } from "../shared/turn-progress.ts";
import { redactSecretsInText } from "./redact.ts";
import { COMMAND_SUMMARY_MAX } from "./tool-summary.ts";

export const STEP_TARGET_MAX = 60;
const ARG_MAX = 40;

const cut = (text: string, limit: number): string => {
  const clean = redactSecretsInText(text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim());
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
};

const ASSIGNMENT = /(^|[\s;&|(`])([A-Za-z_][A-Za-z0-9_]*)=(?:«redacted \d+ chars»|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)`]*)/g;

export function maskAssignments(command: string): string {
  return command.replace(ASSIGNMENT, "$1$2=…");
}

function splitSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === "\"" && i + 1 < command.length) current += command[++i];
      continue;
    }
    if (c === "'" || c === "\"" || c === "`") { quote = c; current += c; continue; }
    if (c === "\\" && i + 1 < command.length) { current += c + command[++i]; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    const redirect = c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">");
    if (depth === 0 && !redirect && (c === ";" || c === "|" || c === "&" || c === "\n")) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((segment) => segment.trim()).filter(Boolean);
}

// A backslash escapes only what a POSIX shell would otherwise read as syntax, so a Windows path keeps its separators.
const ESCAPED_IN_QUOTES = new Set(["\"", "\\", "$", "`"]);
const ESCAPED_BARE = new Set([...ESCAPED_IN_QUOTES, "'", " ", "&", "|", ";", "(", ")", "<", ">"]);

function splitWords(segment: string): string[] {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === "\"" && ESCAPED_IN_QUOTES.has(segment[i + 1] ?? "")) word += segment[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; started = true; continue; }
    if (c === "\\" && ESCAPED_BARE.has(segment[i + 1] ?? "")) { word += segment[++i]; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) out.push(word);
      word = "";
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) out.push(word);
  return out;
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const isFlag = (word: string) => word.startsWith("-") && word.length > 1;
const baseName = (word: string) => word.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? word;
const programName = (word: string) => baseName(word).replace(/\.exe$/i, "");

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPER_VALUE_FLAGS: Record<string, string> = { sudo: "ugCDhprtUT", doas: "uC", env: "uSC", nice: "n", ionice: "cnp", timeout: "sk", stdbuf: "ioe" };
const WRAPPERS = new Set([...Object.keys(WRAPPER_VALUE_FLAGS), "nohup", "time", "exec", "command", "builtin", "caffeinate", "xvfb-run", "chronic", "unbuffer"]);
const PREPARING = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "alias", "true", ":", "shopt", "ulimit",
  "umask", "trap", "mkdir", "touch", "clear", "nvm", "pyenv", "conda", "deactivate", "chmod", "eval"]);
const PLUMBING = new Set(["echo", "printf", "cat", "tee", "head", "tail", "grep", "egrep", "rg", "sort", "uniq", "wc", "sed", "awk",
  "cut", "tr", "jq", "xargs", "less", "more", "column", "sleep", "date", "wait", "test", "[", "ls", "pwd", "which"]);
const INTERPRETER = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|Rscript|tsx|ts-node|osascript|pwsh|powershell|cmd|lua|julia|java|sh|bash|zsh|dash|ksh|fish)$/i;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "poetry", "pdm", "hatch", "deno", "pipenv", "rye"]);
const RUNNER_VERBS = new Set(["run", "exec", "x", "dlx", "run-script", "task"]);
const SCRIPT = /\.(?:py|js|mjs|cjs|ts|mts|tsx|sh|bash|zsh|rb|pl|php|lua|r|jl|ps1|jar)$/i;

function programOf(words: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  for (;;) {
    while (i < words.length && isAssignment(words[i]!)) i++;
    const word = words[i];
    if (word === undefined) return undefined;
    const name = programName(word);
    if (!WRAPPERS.has(name)) return { name, args: words.slice(i + 1) };
    i++;
    while (i < words.length && (isFlag(words[i]!) || isAssignment(words[i]!))) {
      const flag = words[i++]!;
      if (/^-[A-Za-z]$/.test(flag) && (WRAPPER_VALUE_FLAGS[name]?.includes(flag[1]!) || /^\d[\w.]*$/.test(words[i] ?? ""))) i++;
    }
    if (name === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[i] ?? "")) i++;
  }
}

function plainArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") continue;
    if (isFlag(word)) {
      if (/^-[A-Za-z]$/.test(word) && /^\d[\w.]*$/.test(args[i + 1] ?? "")) i++;
      continue;
    }
    if (isAssignment(word) || !word.trim()) continue;
    out.push(word);
  }
  return out;
}

function siteOf(raw: string): string | undefined {
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function shortArg(word: string): string {
  const site = siteOf(word);
  if (site) return site;
  const name = /[\\/]/.test(word) ? baseName(word) : word;
  return name.length > ARG_MAX ? `${name.slice(0, ARG_MAX - 1)}…` : name;
}

const INLINE_SCRIPT: Record<string, RegExp> = { pwsh: /^-(?:c|command)$/i, powershell: /^-(?:c|command)$/i, cmd: /^\/c$/i };

function interpreterTarget(name: string, args: string[]): string {
  const inlineFlag = SHELLS.has(name) ? /^-[a-z]*c[a-z]*$/ : INLINE_SCRIPT[name.toLowerCase()];
  const inline = inlineFlag ? args.findIndex((word) => inlineFlag.test(word)) : -1;
  if (inline >= 0 && args[inline + 1]) return commandTarget(args.slice(inline + 1).join(" ")) ?? name;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "-m" && args[i + 1]) return args[i + 1]!;
    if (word === "-c" || word === "-e" || word === "--eval" || word === "-p" || word === "--print") return name;
    if (word === "-jar" && args[i + 1]) return baseName(args[i + 1]!);
    if (/^-[WXI]$/.test(word)) { i++; continue; }
    if (isFlag(word)) continue;
    if ((name === "deno" || name === "bun") && /^(?:run|test|task)$/.test(word)) {
      const rest = plainArgs(args.slice(i + 1));
      return rest[0] ? (SCRIPT.test(rest[0]) ? baseName(rest[0]) : `${name} ${word} ${shortArg(rest[0])}`) : `${name} ${word}`;
    }
    return SCRIPT.test(word) || /[\\/]/.test(word) ? baseName(word) : name === "bun" ? `bun ${shortArg(word)}` : baseName(word);
  }
  return name;
}

function segmentTarget(segment: string): string | undefined {
  const inner = /^\((.*)\)$/s.exec(segment.trim());
  if (inner) return commandTarget(inner[1]!);
  const program = programOf(splitWords(segment));
  if (!program) return undefined;
  const { name, args } = program;
  if (!name) return undefined;
  if (SCRIPT.test(name)) return name;
  if (INTERPRETER.test(name)) return interpreterTarget(name, args);
  const plain = plainArgs(name === "git" ? args.filter((_, i) => !/^-[Cc]$/.test(args[i - 1] ?? "")) : args);
  const site = plain.map(siteOf).find(Boolean);
  if (site) return `${name} ${site}`;
  const first = plain[0];
  if (!first) return name;
  if (RUNNERS.has(name) && RUNNER_VERBS.has(first) && plain[1]) return `${name} ${first} ${shortArg(plain[1])}`;
  return `${name} ${shortArg(first)}`;
}

const segmentProgram = (segment: string) => programOf(splitWords(segment.replace(/^\(/, "")))?.name ?? "";

export function commandTarget(command: string): string | undefined {
  const segments = splitSegments(command.replace(/«redacted \d+ chars»/g, "«redacted»"));
  if (!segments.length) return undefined;
  const names = segments.map(segmentProgram);
  const main = names.findIndex((name) => name && !PREPARING.has(name) && !PLUMBING.has(name));
  const fallback = names.findIndex((name) => name && !PREPARING.has(name));
  const target = segmentTarget(segments[main >= 0 ? main : fallback >= 0 ? fallback : 0]!);
  return target ? cut(target, STEP_TARGET_MAX) : undefined;
}

function parsedInput(input: string | undefined): Record<string, unknown> | string | undefined {
  if (!input?.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {}
  return input;
}

function inputField(parsed: Record<string, unknown> | string | undefined, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (parsed && typeof parsed === "object") {
      const value = parsed[name];
      if (typeof value === "string" && value.trim()) return value;
      continue;
    }
    const match = typeof parsed === "string" ? new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(parsed) : null;
    if (!match) continue;
    try {
      const value = JSON.parse(`"${match[1]}"`) as string;
      if (value.trim()) return value;
    } catch {}
  }
  return undefined;
}

function firstChangedPath(parsed: Record<string, unknown> | string | undefined): { path: string; added: boolean } | undefined {
  if (!Array.isArray(parsed)) return undefined;
  const changes = parsed as Array<{ path?: unknown; kind?: { type?: unknown } } | null>;
  const first = changes.find((change) => typeof change?.path === "string");
  if (!first) return undefined;
  return { path: first.path as string, added: changes.every((change) => change?.kind?.type === "add") };
}

const WEB_SEARCH = /web.?search|search.?(?:the.?)?web|google.?search|brave.?search|bing.?search|tavily|exa.?search|duckduckgo|perplexity|internet.?search/i;
const FETCH = /fetch|read.?page|read.?url|get.?page|scrape|crawl/i;
const WRITE = /^(?:write|write.?file|create.?file)$/i;
const EDIT = /^(?:edit|multi.?edit|notebook.?edit|str.?replace|replace|apply.?patch)$/i;
const READ = /^(?:read|read.?file|view|open.?file)$/i;

function withDetail(step: LiveStep, detail: string | undefined): LiveStep {
  const shown = detail ? cut(detail, COMMAND_SUMMARY_MAX) : "";
  return shown && shown !== step.target ? { ...step, detail: shown } : step;
}

export function toolStep(call: { title?: string; summary?: string; input?: string }): LiveStep | undefined {
  const title = (call.title ?? "").replace(/^mcp__.+?__/, "").trim();
  const parsed = parsedInput(call.input);
  if (call.summary?.trim()) {
    const target = commandTarget(call.summary);
    return target ? withDetail({ activity: "command", target }, maskAssignments(call.summary)) : undefined;
  }
  if (WEB_SEARCH.test(title)) {
    const query = typeof parsed === "string" && !parsed.trimStart().startsWith("{") ? parsed : inputField(parsed, ["query", "q", "search_query", "searchQuery"]);
    if (!query) return undefined;
    const target = cut(query, STEP_TARGET_MAX);
    return target ? withDetail({ activity: "web", target }, query) : undefined;
  }
  const url = inputField(parsed, ["url", "uri", "href", "link"]);
  if (url && FETCH.test(title)) {
    const site = siteOf(url.trim());
    if (!site) return undefined;
    const { hostname, pathname } = new URL(url.trim());
    return withDetail({ activity: "fetch", target: cut(site, STEP_TARGET_MAX) }, `${hostname.replace(/^www\./i, "")}${pathname === "/" ? "" : pathname}`);
  }
  const changed = title === "edit" ? firstChangedPath(parsed) : undefined;
  if (changed) {
    const file = progressFile(changed.path);
    return file ? { activity: changed.added ? "write" : "edit", target: cut(file, STEP_TARGET_MAX) } : undefined;
  }
  const activity = WRITE.test(title) ? "write" : EDIT.test(title) ? "edit" : READ.test(title) ? "read" : null;
  if (!activity) return undefined;
  const file = progressFile(inputField(parsed, ["file_path", "notebook_path", "path", "filePath", "file"]));
  return file ? { activity, target: cut(file, STEP_TARGET_MAX) } : undefined;
}
