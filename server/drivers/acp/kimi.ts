// Kimi Code harness support — Moonshot's `kimi` CLI over ACP stdio
// (`kimi acp`), on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against kimi-code 0.29.1: initialize reports
// loadSession:true (session/load resume works), mcpCapabilities http+sse,
// and a full session/new → session/prompt roundtrip streams
// agent_thought_chunk + agent_message_chunk and settles with end_turn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, LOCAL_HOSTS, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const STATIC_KIMI_MODELS: ModelCatalog = {
  default: "kimi-code/k3",
  options: [
    { id: "kimi-code/k3", label: "Kimi K3" },
    { id: "kimi-code/k3-256k", label: "Kimi K3 256K" },
    { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:/-]*$/i;
const LOCAL_PROVIDER_PREFIXES = LOCAL_HOSTS.map((host) => `${host.id}/`);

function isLocalInjectAlias(slug: string): boolean {
  return LOCAL_PROVIDER_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function kimiDataRoot(env: Record<string, string | undefined>): string {
  return env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".kimi-code");
}

function credentialsPath(env: Record<string, string | undefined>) {
  return join(kimiDataRoot(env), "credentials", "kimi-code.json");
}

/** Quote a TOML string value. */
function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quote a TOML key when it is not a bare identifier. */
function quoteTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return quoteToml(key);
}

/** Strip a `#` comment that is not inside a quoted string. */
function stripTomlLineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "#") return line.slice(0, i);
    if (c === '"' || c === "'") quote = c;
  }
  return line;
}

/** Decode a TOML basic-string escape at `text[i]` (`i` points at the `\\`).
 *  Invalid / unknown / surrogate / out-of-range sequences return ok:false so
 *  the heading is not canonicalized to a colliding alias. */
function takeTomlBasicEscape(
  text: string,
  i: number,
): { ok: true; value: string; next: number } | { ok: false } {
  const code = text[i + 1];
  if (code === undefined) return { ok: false };
  if (code === "u") {
    const hex = text.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { ok: false };
    const point = parseInt(hex, 16);
    if (point >= 0xd800 && point <= 0xdfff) return { ok: false };
    return { ok: true, value: String.fromCharCode(point), next: i + 6 };
  }
  if (code === "U") {
    const hex = text.slice(i + 2, i + 10);
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) return { ok: false };
    const point = parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return { ok: false };
    return { ok: true, value: String.fromCodePoint(point), next: i + 10 };
  }
  const named: Record<string, string> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  if (!(code in named)) return { ok: false };
  return { ok: true, value: named[code]!, next: i + 2 };
}

/** Canonical `a.b.c` form of a `[table]` heading, quotes and comments removed. */
function canonicalizeTomlHeading(heading: string): string | null {
  const trimmed = stripTomlLineComment(heading).trim();
  const match = trimmed.match(/^\[([^[\]]+)\]$/);
  if (!match) return null;
  const parts: string[] = [];
  const inner = match[1]!;
  let i = 0;
  const skipSep = () => {
    while (i < inner.length && (inner[i] === "." || inner[i] === " " || inner[i] === "\t")) i += 1;
  };
  skipSep();
  while (i < inner.length) {
    const q = inner[i];
    if (q === '"' || q === "'") {
      i += 1;
      let value = "";
      while (i < inner.length && inner[i] !== q) {
        if (q === '"' && inner[i] === "\\") {
          const taken = takeTomlBasicEscape(inner, i);
          if (!taken.ok) return null;
          value += taken.value;
          i = taken.next;
          continue;
        }
        value += inner[i];
        i += 1;
      }
      if (inner[i] === q) i += 1;
      parts.push(value);
      skipSep();
      continue;
    }
    let value = "";
    while (i < inner.length && inner[i] !== ".") {
      value += inner[i];
      i += 1;
    }
    const part = value.trim();
    if (part) parts.push(part);
    skipSep();
  }
  return parts.length ? parts.join(".") : null;
}

/** Unwrap `"key"` / `'key'` so a quoted assignment matches the bare name. */
function unquoteTomlKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    return key.slice(1, -1);
  }
  return key;
}

/** Bare key on the left of `key = value`. */
function tomlRowKey(row: string): string {
  const eq = row.indexOf("=");
  return unquoteTomlKey(eq < 0 ? row : row.slice(0, eq));
}

/** Walk `text` and yield `[table]` spans. `[[array]]` headings bound a table
 *  but are not themselves patchable. `#` comments in `out` mode are skipped
 *  so an apostrophe in a comment cannot open a phantom string. */
function tomlTables(text: string): Array<{ name: string; headingStart: number; bodyStart: number; end: number }> {
  type Mode = "out" | "basic" | "literal" | "mlbasic" | "mllit";
  const headings: Array<{ name: string | null; patchable: boolean; lineStart: number; lineEnd: number }> = [];
  let mode: Mode = "out";
  let i = 0;
  const atLineStart = (idx: number) => idx === 0 || text[idx - 1] === "\n";
  while (i < text.length) {
    if (mode === "mlbasic") {
      if (text.startsWith('"""', i)) {
        mode = "out";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "mllit") {
      if (text.startsWith("'''", i)) {
        mode = "out";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "basic") {
      if (text[i] === "\n") {
        mode = "out";
        i += 1;
        continue;
      }
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') mode = "out";
      i += 1;
      continue;
    }
    if (mode === "literal") {
      if (text[i] === "\n") {
        mode = "out";
        i += 1;
        continue;
      }
      if (text[i] === "'") mode = "out";
      i += 1;
      continue;
    }
    if (text.startsWith('"""', i)) {
      mode = "mlbasic";
      i += 3;
      continue;
    }
    if (text.startsWith("'''", i)) {
      mode = "mllit";
      i += 3;
      continue;
    }
    if (text[i] === '"') {
      mode = "basic";
      i += 1;
      continue;
    }
    if (text[i] === "'") {
      mode = "literal";
      i += 1;
      continue;
    }
    if (text[i] === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (atLineStart(i)) {
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
      if (text[j] === "[") {
        const nl = text.indexOf("\n", j);
        const lineEnd = nl < 0 ? text.length : nl;
        const raw = text.slice(j, lineEnd).replace(/\r$/, "");
        const stripped = stripTomlLineComment(raw).trim();
        const array = stripped.startsWith("[[");
        const name = array
          ? canonicalizeTomlHeading(`[${stripped.replace(/^\s*\[\[/, "").replace(/\]\]\s*$/, "")}]`)
          : canonicalizeTomlHeading(raw);
        headings.push({ name, patchable: !array && name !== null, lineStart: i, lineEnd });
        i = lineEnd + (nl < 0 ? 0 : 1);
        continue;
      }
    }
    i += 1;
  }
  return headings
    .map((heading, index) => ({
      heading,
      end: index + 1 < headings.length ? headings[index + 1]!.lineStart : text.length,
    }))
    .filter((entry) => entry.heading.patchable && entry.heading.name)
    .map((entry) => ({
      name: entry.heading.name!,
      headingStart: entry.heading.lineStart,
      bodyStart: entry.heading.lineEnd + (text[entry.heading.lineEnd] === "\n" ? 1 : 0),
      end: entry.end,
    }));
}

/** Keys assigned at line start in a table body, including `"quoted"` keys. */
function tomlKeys(block: string): Set<string> {
  const keys = new Set<string>();
  type Mode = "out" | "basic" | "literal" | "mlbasic" | "mllit";
  let mode: Mode = "out";
  let lineStart = 0;
  let lineStartMode: Mode = "out";
  const take = (end: number) => {
    if (lineStartMode !== "out") return;
    const line = stripTomlLineComment(block.slice(lineStart, end));
    const eq = line.indexOf("=");
    if (eq > 0) keys.add(unquoteTomlKey(line.slice(0, eq)));
  };
  for (let i = 0; i < block.length; i++) {
    if (mode === "mlbasic") {
      if (block.startsWith('"""', i)) {
        mode = "out";
        i += 2;
      }
    } else if (mode === "mllit") {
      if (block.startsWith("'''", i)) {
        mode = "out";
        i += 2;
      }
    } else if (mode === "basic") {
      if (block[i] === "\\") i += 1;
      else if (block[i] === '"') mode = "out";
    } else if (mode === "literal") {
      if (block[i] === "'") mode = "out";
    } else if (block[i] === "#") {
      const nl = block.indexOf("\n", i);
      i = nl < 0 ? block.length : nl;
      if (nl < 0) break;
    } else if (block.startsWith('"""', i)) {
      mode = "mlbasic";
      i += 2;
    } else if (block.startsWith("'''", i)) {
      mode = "mllit";
      i += 2;
    } else if (block[i] === '"') {
      mode = "basic";
    } else if (block[i] === "'") {
      mode = "literal";
    }
    if (i < block.length && block[i] === "\n") {
      take(i);
      lineStart = i + 1;
      if (mode === "basic" || mode === "literal") mode = "out";
      lineStartMode = mode;
    }
  }
  take(block.length);
  return keys;
}

/** Whether `text` already has this table, ignoring quotes and trailing comments. */
function hasTomlTable(text: string, heading: string): boolean {
  const name = canonicalizeTomlHeading(heading);
  return name !== null && tomlTables(text).some((table) => table.name === name);
}

/** Insert missing keys into an existing table. Does not overwrite set values. */
function patchTomlTable(text: string, heading: string, rows: string[]): string {
  const name = canonicalizeTomlHeading(heading);
  if (!name) return text;
  const table = tomlTables(text).find((entry) => entry.name === name);
  if (!table) return text;
  const keys = tomlKeys(text.slice(table.bodyStart, table.end));
  const missing = rows.filter((row) => !keys.has(tomlRowKey(row)));
  if (!missing.length) return text;
  let insertAt = table.end;
  while (insertAt > table.bodyStart && (text[insertAt - 1] === "\n" || text[insertAt - 1] === "\r")) insertAt -= 1;
  const before = text.slice(0, insertAt);
  const after = text.slice(insertAt);
  const pad = before.endsWith("\n") || before.length === 0 ? "" : "\n";
  return `${before}${pad}${missing.join("\n")}${after.startsWith("\n") ? "" : "\n"}${after}`;
}

/** Write [providers.host] + [models."host/alias"] so `kimi -m` hits the local host. */
export function ensureKimiInjectAlias(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const alias = `${inject.host}/${inject.model.replace(/\//g, "-")}`;
  const dataRoot = kimiDataRoot(env);
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const original = text;

  const providerHeading = `[providers.${inject.host}]`;
  const modelHeading = `[models.${quoteTomlKey(alias)}]`;
  const blocks: string[] = [];
  if (!hasTomlTable(text, providerHeading)) {
    blocks.push(
      [
        providerHeading,
        `type = "openai_legacy"`,
        `base_url = ${quoteToml(host.baseUrl)}`,
        `api_key = ${quoteToml(hostApiKey(host, env))}`,
        "",
      ].join("\n"),
    );
  }
  // Kimi 0.36+ refuses openai_legacy as a wire protocol; ACP then
  // skips default-model binding and falls through to OAuth. Patch
  // aliases written before those keys existed; do not overwrite a
  // user's protocol or context size.
  if (hasTomlTable(text, modelHeading)) {
    text = patchTomlTable(text, modelHeading, [`protocol = "openai"`, `max_context_size = 262144`]);
  } else {
    blocks.push(
      [
        modelHeading,
        `provider = ${quoteToml(inject.host)}`,
        `model = ${quoteToml(inject.model)}`,
        `protocol = "openai"`,
        `max_context_size = 262144`,
        "",
      ].join("\n"),
    );
  }
  if (blocks.length) {
    const prefix = text && !text.endsWith("\n") ? `${text}\n\n` : text ? `${text}\n` : "";
    writeFileSync(path, `${prefix}${blocks.join("\n")}`);
  } else if (text !== original) {
    writeFileSync(path, text);
  }
  return alias;
}

/** Env keys Kimi 0.36+ reads to synthesize an in-memory default model.
 *  ACP `session/new` runs auth readiness against `default_model`, not `-m`.
 *  Without a default, a missing/expired `kimi login` becomes
 *  "Authentication required" even when the picker is a local host. */
const KIMI_MODEL_ENV = [
  "KIMI_MODEL_NAME",
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_BASE_URL",
  "KIMI_MODEL_PROVIDER_TYPE",
  "KIMI_MODEL_DISPLAY_NAME",
] as const;

/** Overlay a local inject as Kimi's in-memory default. Does not write
 *  config.toml — Kimi strips these reserved entries on persist. */
export function applyKimiLocalModelEnv(
  env: Record<string, string | undefined>,
  modelId: string | undefined,
): void {
  const inject = decodeInjectId(modelId);
  if (!inject) return;
  const host = localHost(inject.host);
  if (!host) return;
  env.KIMI_MODEL_NAME = inject.model;
  env.KIMI_MODEL_API_KEY = hostApiKey(host, env);
  env.KIMI_MODEL_BASE_URL = host.baseUrl;
  // Env overlay accepts openai | anthropic | kimi — not the toml
  // openai_legacy type we write for the on-disk provider row.
  env.KIMI_MODEL_PROVIDER_TYPE = "openai";
  env.KIMI_MODEL_DISPLAY_NAME = `${inject.model} (${host.label})`;
}

/** Drop leftover shell `KIMI_MODEL_*` so they cannot steal a cloud turn. */
function stripKimiModelEnv(env: Record<string, string | undefined>): void {
  for (const key of KIMI_MODEL_ENV) delete env[key];
}

function readKimiModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  const dataRoot = kimiDataRoot(env);
  let text = "";
  try {
    text = readFileSync(join(dataRoot, "config.toml"), "utf8");
  } catch {
    return STATIC_KIMI_MODELS;
  }
  const options = STATIC_KIMI_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let current: { slug: string; name?: string } | null = null;
  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug) || isLocalInjectAlias(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if ((stripped.startsWith("[model.") || stripped.startsWith("[models.")) && stripped.endsWith("]")) {
      flush();
      let inner = stripped.replace(/^\[models?\./, "").slice(0, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (current && (key === "name" || key === "label") && value) current.name = value;
  }
  flush();
  return { default: STATIC_KIMI_MODELS.default, options };
}

const support: AcpSupport = {
  driverKind: "kimiAgent",
  displayName: "Kimi",
  // Aliases from the CLI's own catalog (~/.kimi-code/config.toml
  // [models."kimi-code/…"] — `kimi provider list` reports the same four).
  models: STATIC_KIMI_MODELS,
  resolveModels: (env) => mergeLocalInject(readKimiModelCatalog(env), env),
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi Code CLI is not signed in — run `kimi login` in a terminal",

  // Official installers put the binary on PATH without requiring an existing
  // Node install. Keep the commands platform-specific so Windows never gets a
  // POSIX-only curl|bash instruction.
  install: {
    command: {
      darwin: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      win32: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    signInCommand: "kimi login",
  },

  // -m is a global commander option and must precede the `acp` subcommand
  // (verified against 0.29.1).
  resolveTurnModel: (model, env) => (model ? ensureKimiInjectAlias(model, env) : model),
  spawnArgs: (_config, turn) => {
    const model = turn.model;
    return [...(model ? ["-m", model] : []), "acp"];
  },

  // Subscription CLI: a leaked Moonshot/Kimi API key must not flip billing
  // to pay-as-you-go inside the spawned agent (mirrors claude/grok).
  transformEnv: (env) => {
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
    // A leftover shell overlay would steal every Kimi turn, including
    // subscription models. applyTurnEnv puts the inject back per turn.
    stripKimiModelEnv(env);
  },
  applyTurnEnv: (env, { requestedModel }) => {
    applyKimiLocalModelEnv(env, requestedModel);
  },

  // The only advertised authMethod is {id:"login", type:"terminal"} — a
  // device-code flow that cannot be driven over ACP. Never pick it; ride
  // the ambient login from a prior `kimi login` instead.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // Match the child CLI's own data-root precedence. A custom instance HOME or
  // KIMI_CODE_HOME must not be checked against the server user's home instead.
  isAuthenticated: (env) => existsSync(credentialsPath(env)),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
