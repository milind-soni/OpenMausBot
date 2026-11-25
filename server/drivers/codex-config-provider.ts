// `codex exec --ignore-user-config` skips config.toml and every provider the person declared there: a background
// call on one fails with "Model provider `x` not found" (codex-cli 0.167). Such a call carries the provider's own
// table as `-c` overrides. A bearer token, or a header in its own `http_headers` table, moves into the child's
// environment instead of argv.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeCodexSelection } from "./codex-catalog.ts";
import { codexHome } from "./codex-identity.ts";

/** Providers Codex defines itself. */
const BUILT_IN = new Set(["openai", "oss", "ollama", "lmstudio"]);
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const KEY_LINE = new RegExp(String.raw`^(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*=\s*(.*)$`);

/** A key path below `model_providers.<id>` (empty for an inline table) and its TOML value as written. */
interface Entry { path: string[]; raw: string }

export function codexConfigProviderArgs(env: Record<string, string | undefined>, modelId: string | null | undefined): string[] {
  const provider = decodeCodexSelection(modelId).modelProvider;
  const home = codexHome(env);
  if (!provider || BUILT_IN.has(provider) || !BARE_KEY.test(provider) || !home) return [];
  let profiles: string[] = [];
  try {
    profiles = readdirSync(home).filter((file) => file.endsWith(".config.toml")).sort();
  } catch {}
  for (const file of ["config.toml", ...profiles]) {
    let text: string;
    try {
      text = readFileSync(join(home, file), "utf8");
    } catch {
      continue;
    }
    const entries = providerTable(text, provider);
    if (entries.length) return overrides(env, provider, entries);
  }
  return [];
}

function splitKey(text: string): string[] | null {
  const parts: string[] = [];
  const part = new RegExp(String.raw`\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)`, "y");
  for (let index = 0; index < text.length;) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
    index = part.lastIndex;
    if (!match[4]) break;
  }
  return parts.length ? parts : null;
}

/** The value starting `text` on line `at`, up to its comment; an open array runs on to the next lines. */
function scanValue(lines: string[], at: number, text: string): { raw: string | null; next: number } {
  const triple = /^("""|''')/.exec(text)?.[1];
  if (triple) {
    let next = at + 1;
    if (!text.slice(3).includes(triple)) while (next < lines.length && !lines[next++]!.includes(triple));
    return { raw: null, next };
  }
  let raw = "";
  let depth = 0;
  let quote = "";
  for (let index = at, line = text; ; line = lines[index]?.trim() ?? "") {
    let end = line.length;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (char === "\\" && quote === '"') i++;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth--;
      else if (char === "#") { end = i; break; }
    }
    raw += `${raw ? " " : ""}${line.slice(0, end).trim()}`;
    index++;
    if (depth <= 0 || quote || index >= lines.length) return { raw: depth === 0 && !quote && raw ? raw : null, next: index };
  }
}

/** Every key under `model_providers.<id>`, whether set in its table, a subtable, a parent table or dotted. */
function providerTable(text: string, provider: string): Entry[] {
  const entries: Entry[] = [];
  const lines = text.split(/\r?\n/);
  let table: string[] | null = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) { index++; continue; }
    if (line.startsWith("[")) {
      const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
      table = header ? splitKey(header[1]!) : null;
      index++;
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (!match) { index++; continue; }
    const { raw, next } = scanValue(lines, index, match[2]!);
    index = next;
    const key = splitKey(match[1]!);
    const path = table && key ? [...table, ...key] : [];
    if (raw && path[0] === "model_providers" && path[1] === provider) entries.push({ path: path.slice(2), raw });
  }
  return entries;
}

function stringValue(raw: string): string | null {
  if (raw.startsWith("'")) return raw.length >= 2 && raw.endsWith("'") ? raw.slice(1, -1) : null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function overrides(env: Record<string, string | undefined>, provider: string, entries: Entry[]): string[] {
  const args: string[] = [];
  const variable = (suffix: string) => `OPENMAUSBOT_CODEX_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
  const set = (key: string, raw: string) => args.push("-c", `model_providers.${[provider, key].filter(Boolean).join(".")}=${raw}`);
  const token = entries.find((entry) => entry.path.join(".") === "experimental_bearer_token");
  const bearer = token ? stringValue(token.raw) : null;
  let headers = 0;
  for (const { path, raw } of entries) {
    if (!path.every((part) => BARE_KEY.test(part)) || path[0] === "experimental_bearer_token" || (bearer !== null && path[0] === "env_key")) continue;
    const value = path[0] === "http_headers" && path.length === 2 ? stringValue(raw) : null;
    if (value === null) {
      set(path.join("."), raw);
      continue;
    }
    const name = variable(`HEADER_${++headers}`);
    env[name] = value;
    set(`env_http_headers.${path[1]}`, JSON.stringify(name));
  }
  if (bearer !== null) {
    env[variable("TOKEN")] = bearer;
    set("env_key", JSON.stringify(variable("TOKEN")));
  }
  return args;
}
