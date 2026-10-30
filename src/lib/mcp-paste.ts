import { importedMcpServerName, slugMcpName } from "../../shared/mcp-name.ts";

/** A value the paste could not give: a variable from the person's terminal, or a placeholder from the instructions. */
export interface PastedGap {
  kind: "variable" | "placeholder";
  /** What to ask for: CF_ID, YOUR_API_KEY. */
  names: string[];
  /** The text around a single gap, so "Bearer $TOKEN" is saved as "Bearer " plus what they paste. */
  before: string;
  after: string;
}

/** A header or an environment variable. Security: its value is a secret and never goes into a message. */
export interface PastedSecret {
  name: string;
  value: string;
  gap?: PastedGap;
}

export interface PastedRemoteServer {
  transport: "remote";
  name: string;
  type: "http" | "sse";
  url: string;
  urlGap?: PastedGap;
  headers: PastedSecret[];
  oauthClientId?: string;
}

export interface PastedStdioServer {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  env: PastedSecret[];
}

export type PastedMcpServer = PastedRemoteServer | PastedStdioServer;

export type McpPasteError = "mcp.paste.notRecognized" | "mcp.paste.badJson" | "mcp.paste.incomplete" | "mcp.paste.badPair";

export type McpPaste = { ok: true; servers: PastedMcpServer[] } | { ok: false; error: McpPasteError };

class PasteError extends Error {
  readonly key: McpPasteError;
  constructor(key: McpPasteError) {
    super(key);
    this.key = key;
  }
}

const URL_START = /^https?:\/\//i;
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEADER_PAIR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/;
const LAUNCHERS = new Set(["npx", "uvx", "bunx"]);
const DLX = new Set(["pnpm", "yarn"]);

/**
 * Reads what someone pasted to add an MCP server: a server's address, a `claude mcp add` or `claude mcp add-json`
 * command (several, one per line, are several servers), an `npx`/`uvx`/`docker run` command, or an `mcpServers` JSON
 * block. Null for blank text. `taken` are the names already in use, so a name made up from an address doesn't clash.
 */
export function readMcpPaste(text: string, taken: readonly string[] = []): McpPaste | null {
  const trimmed = normalizeTypography(text).trim();
  if (!trimmed) return null;
  try {
    const servers = /^[{[]/.test(trimmed) ? fromJson(trimmed) : URL_START.test(trimmed) && !/\s/.test(trimmed)
      ? [remoteServer(undefined, trimmed, undefined, [])]
      : fromCommands(trimmed);
    return { ok: true, servers: uniqueNames(servers, taken) };
  } catch (error) {
    if (error instanceof PasteError) return { ok: false, error: error.key };
    throw error;
  }
}

/** Word processors and chat apps turn quotes and `--` into typographic ones. */
function normalizeTypography(text: string): string {
  return text.replace(/[“”„]/g, "\"").replace(/[‘’]/g, "'").replace(/(^|\s)[–—](?=[a-z])/g, "$1--");
}

/** POSIX-shell words, split into commands at newlines, `;` and `&&`. Backslash-, backtick- and caret-newline continue a line. */
export function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const continuation = (at: number) => text[at] === "\n" ? 1 : text[at] === "\r" && text[at + 1] === "\n" ? 2 : 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\\" || ((c === "`" || c === "^") && continuation(i + 1))) {
      const skip = continuation(i + 1);
      if (skip) { i += skip; continue; }
      if (i + 1 < text.length) { word += text[i + 1]; inWord = true; i += 1; }
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new PasteError("mcp.paste.notRecognized");
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      for (; j < text.length && text[j] !== "\""; j += 1) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const skip = continuation(j + 1);
          if (skip) { j += skip; continue; }
          if ("\"\\$`".includes(text[j + 1]!)) { word += text[j + 1]; j += 1; continue; }
        }
        word += text[j];
      }
      if (j >= text.length) throw new PasteError("mcp.paste.notRecognized");
      inWord = true;
      i = j;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const end = text.indexOf(")", i + 2);
      if (end < 0) throw new PasteError("mcp.paste.notRecognized");
      word += text.slice(i, end + 1);
      inWord = true;
      i = end;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
      continue;
    }
    if (c === "\n" || c === ";") { endCommand(); continue; }
    if (c === "&" && text[i + 1] === "&") { endCommand(); i += 1; continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endCommand();
  return commands;
}

function fromCommands(text: string): PastedMcpServer[] {
  const commands = shellCommands(text);
  if (!commands.length) throw new PasteError("mcp.paste.notRecognized");
  return commands.map((words) => {
    const command = words[0] === "$" || words[0] === ">" ? words.slice(1) : words;
    if (command[0] === "claude" && command[1] === "mcp" && command[2] === "add") return fromClaudeAdd(command.slice(3));
    if (command[0] === "claude" && command[1] === "mcp" && command[2] === "add-json") return fromClaudeAddJson(command.slice(3));
    return fromLauncher(command);
  });
}

/** `claude mcp add [options] <name> <commandOrUrl> [args...]`, with options anywhere before `--`, as Claude Code's parser takes them. */
function fromClaudeAdd(args: string[]): PastedMcpServer {
  let transport: string | undefined;
  let clientId: string | undefined;
  const headers: string[] = [];
  const env: string[] = [];
  const positionals: string[] = [];
  let afterDashes: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") { afterDashes = args.slice(i + 1); break; }
    const option = /^(--[a-z][a-z-]*|-[a-zA-Z])(?:=([\s\S]*))?$/.exec(arg);
    if (!option) { positionals.push(arg); continue; }
    const value = () => option[2] ?? args[++i] ?? "";
    const more = (pattern: RegExp, into: string[]) => {
      while (i + 1 < args.length && pattern.test(args[i + 1]!) && !URL_START.test(args[i + 1]!)) into.push(args[++i]!);
    };
    switch (option[1]) {
      case "--transport": case "-t": transport = value().toLowerCase(); break;
      case "--header": case "-H": headers.push(value()); if (option[2] === undefined) more(HEADER_PAIR, headers); break;
      case "--env": case "-e": env.push(value()); if (option[2] === undefined) more(ENV_PAIR, env); break;
      case "--client-id": clientId = value(); break;
      case "--scope": case "-s": case "--callback-port": value(); break;
      default: break;
    }
  }
  const [name, target, ...rest] = [...positionals, ...afterDashes];
  if (!name || !target) throw new PasteError("mcp.paste.incomplete");
  if (transport !== "stdio" && (transport === "http" || transport === "sse" || URL_START.test(target))) {
    const server = remoteServer(name, target, transport === "sse" ? "sse" : transport === "http" ? "http" : undefined, headers.map(headerSecret));
    return clientId ? { ...server, oauthClientId: clientId } : server;
  }
  return { transport: "stdio", name: importedMcpServerName(name), command: target, args: rest, env: env.map(envSecret) };
}

/** `claude mcp add-json [options] <name> <json>`: one server's entry. */
function fromClaudeAddJson(args: string[]): PastedMcpServer {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--scope" || arg === "-s") { i += 1; continue; }
    if (arg.startsWith("-") && !arg.startsWith("{")) continue;
    positionals.push(arg);
  }
  const [name, json] = positionals;
  if (!name || !json) throw new PasteError("mcp.paste.incomplete");
  const server = entryServer(name, parseJson(json));
  if (!server) throw new PasteError("mcp.paste.notRecognized");
  return server;
}

/** A bare `npx …`, `uvx …`, `pnpm dlx …` or `docker run …` line, with any `KEY=value` before it. */
function fromLauncher(words: string[]): PastedMcpServer {
  let at = 0;
  const env: PastedSecret[] = [];
  while (at < words.length && ENV_PAIR.test(words[at]!)) env.push(envSecret(words[at++]!));
  const [command, ...args] = words.slice(at);
  if (!command) throw new PasteError("mcp.paste.notRecognized");
  if (command === "docker" && args[0] === "run") return dockerServer(args, env);
  if (!LAUNCHERS.has(command) && !(DLX.has(command) && args[0] === "dlx")) throw new PasteError("mcp.paste.notRecognized");
  const packageArg = args.find((arg, index) => !arg.startsWith("-") && !(index === 0 && arg === "dlx"));
  if (!packageArg) throw new PasteError("mcp.paste.incomplete");
  return { transport: "stdio", name: packageName(packageArg), command, args, env };
}

const DOCKER_FLAGS = new Set(["-i", "-t", "-it", "-ti", "-d", "--rm", "--init", "--interactive", "--tty", "--detach", "--privileged"]);

/** Security: `-e KEY=value` would show the value in the listing's arguments, so it moves to the write-only environment
 * and docker is told `-e KEY` (pass it through). */
function dockerServer(args: string[], env: PastedSecret[]): PastedMcpServer {
  const out: string[] = [args[0]!];
  let image: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (image || !arg.startsWith("-")) {
      image ??= arg;
      out.push(arg);
    } else if ((arg === "-e" || arg === "--env") && i + 1 < args.length) {
      const pair = args[++i]!;
      const name = pair.split("=")[0]!;
      env.push(pair.includes("=") ? envSecret(pair) : { name, value: "", gap: { kind: "variable", names: [name], before: "", after: "" } });
      out.push(arg, name);
    } else if (arg.includes("=") || DOCKER_FLAGS.has(arg) || i + 1 >= args.length) {
      out.push(arg);
    } else {
      out.push(arg, args[++i]!);
    }
  }
  if (!image) throw new PasteError("mcp.paste.incomplete");
  return { transport: "stdio", name: packageName(image.replace(/:[^/:]*$/, "")), command: "docker", args: out, env };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PasteError("mcp.paste.badJson");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `{"mcpServers": {...}}` (Claude Code, Cursor, Claude Desktop), `{"servers": {...}}` (VS Code), a bare `{name: entry}`
 * map, or one entry, with or without a `name`. */
function fromJson(text: string): PastedMcpServer[] {
  const root = parseJson(text);
  if (!isRecord(root)) throw new PasteError("mcp.paste.notRecognized");
  const single = entryServer(typeof root.name === "string" ? root.name : undefined, root);
  if (single) return [single];
  const block = isRecord(root.mcpServers) ? root.mcpServers : isRecord(root.servers) ? root.servers : root;
  const servers = Object.entries(block).map(([name, entry]) => entryServer(name, entry));
  if (!servers.length || servers.some((server) => !server)) throw new PasteError("mcp.paste.notRecognized");
  return servers as PastedMcpServer[];
}

const strings = (value: unknown): Array<[string, string]> => isRecord(value)
  ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  : [];

function entryServer(name: string | undefined, entry: unknown): PastedMcpServer | null {
  if (!isRecord(entry)) return null;
  const url = typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (url !== undefined) {
    const headers = strings(entry.headers).map(([key, value]) => secret(key, value));
    return remoteServer(name, url, type === "sse" ? "sse" : type ? "http" : undefined, headers);
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) return null;
  const listed = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
  const [command, ...inline] = listed.length ? [entry.command.trim()] : shellCommands(entry.command)[0] ?? [entry.command];
  const env = strings(entry.env).map(([key, value]) => secret(key, value));
  const all = [...inline, ...listed];
  return { transport: "stdio", name: name ? importedMcpServerName(name) : packageName(all.find((arg) => !arg.startsWith("-")) ?? command ?? ""), command: command!, args: all, env };
}

function remoteServer(name: string | undefined, url: string, type: "http" | "sse" | undefined, headers: PastedSecret[]): PastedRemoteServer {
  const urlGap = gapIn(url);
  return {
    transport: "remote",
    name: name ? importedMcpServerName(name) : hostName(url),
    type: type ?? (/\/sse\/?(?:[?#]|$)/i.test(url) ? "sse" : "http"),
    url,
    ...(urlGap ? { urlGap } : {}),
    headers,
  };
}

function headerSecret(pair: string): PastedSecret {
  const colon = pair.indexOf(":");
  if (colon <= 0) throw new PasteError("mcp.paste.badPair");
  return secret(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim());
}

function envSecret(pair: string): PastedSecret {
  const equals = pair.indexOf("=");
  if (equals <= 0) throw new PasteError("mcp.paste.badPair");
  return secret(pair.slice(0, equals), pair.slice(equals + 1));
}

function secret(name: string, value: string): PastedSecret {
  const gap = gapIn(value);
  return gap ? { name, value: "", gap } : { name, value };
}

const VARIABLE = /\$\{([^}]*)\}|\$\(([^)]*)\)|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const PLACEHOLDER = /<([^<>\s][^<>]{0,63})>|\b(YOUR[_-][A-Za-z0-9_-]+|your[_-][a-z0-9_-]+)\b/g;

/** A shell variable (`$CF_ID`, `${CF_ID}`, `$(…)`), a config variable (`${env:X}`, `${input:x}`), or a placeholder
 * (`<api-key>`, `YOUR_API_KEY`): nothing that could be a real value. */
export function gapIn(value: string): PastedGap | undefined {
  const found: Array<{ start: number; end: number; name: string; kind: PastedGap["kind"] }> = [];
  for (const match of value.matchAll(VARIABLE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^(?:env|input):/, "").replace(/:-[\s\S]*$/, "").trim();
    found.push({ start: match.index, end: match.index + match[0].length, name: raw || match[0], kind: "variable" });
  }
  for (const match of value.matchAll(PLACEHOLDER)) {
    if (found.some((gap) => match.index < gap.end && match.index + match[0].length > gap.start)) continue;
    found.push({ start: match.index, end: match.index + match[0].length, name: (match[1] ?? match[2] ?? "").trim(), kind: "placeholder" });
  }
  if (!found.length) return undefined;
  const names = [...new Set(found.map((gap) => gap.name))];
  const kind = found.some((gap) => gap.kind === "variable") ? "variable" : "placeholder";
  const only = found.length === 1 ? found[0]! : null;
  return { kind, names, before: only ? value.slice(0, only.start) : "", after: only ? value.slice(only.end) : "" };
}

const GENERIC_LABELS = new Set(["www", "mcp", "api", "server", "servers", "app", "remote", "sse", "gateway", "co", "com", "org", "net", "ac", "gov"]);

/** A name from an address: mcp.acme.example is "acme". */
function hostName(url: string): string {
  let host: string;
  try { host = new URL(url).hostname; } catch { return ""; }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "server";
  const labels = host.split(".").filter(Boolean);
  if (labels.length > 1) labels.pop();
  return importedMcpServerName(labels.filter((label) => !GENERIC_LABELS.has(label)).at(-1) ?? labels.at(-1) ?? "server");
}

/** A name from a package or image: @modelcontextprotocol/server-github is "github", mcp-server-fetch is "fetch". */
function packageName(spec: string): string {
  const parts = spec.replace(/(?!^)@[^/@]*$/, "").split("/");
  const base = parts.at(-1) ?? spec;
  const stem = base.replace(/^(?:mcp-server-|server-|mcp-)/, "").replace(/(?:-mcp-server|-mcp|-server)$/, "");
  const scope = (parts.at(-2) ?? "").replace(/^@/, "");
  return importedMcpServerName(GENERIC_LABELS.has(stem) && scope ? scope : stem || base) || "server";
}

/** A taken name gets -2, -3…, so adding never overwrites a server already there. */
function uniqueNames(servers: PastedMcpServer[], taken: readonly string[]): PastedMcpServer[] {
  const used = new Set(taken);
  return servers.map((server) => {
    let name = server.name || "server";
    if (used.has(name)) {
      for (let n = 2; used.has(name); n += 1) name = slugMcpName(`${server.name.slice(0, 29)}-${n}`);
    }
    used.add(name);
    return name === server.name ? server : { ...server, name };
  });
}
