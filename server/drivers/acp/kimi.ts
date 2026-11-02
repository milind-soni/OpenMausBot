// Kimi Code: Moonshot's `kimi acp` on the Kimi Code subscription login
// (~/.kimi-code/credentials), not a Moonshot API key. Verified on kimi-code 0.29.1.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import type { DeviceSignIn } from "../device-auth.ts";
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

/** kimi-code 2.4.1 (resolveKimiTokenStorageName) keeps a kimi.com login in credentials/kimi-code.json and a kimi.ai
 * one, the region it picks outside China, in credentials/kimi-code-env-<hash>.json. */
const KIMI_TOKEN_FILE = /^kimi-code(?:-env-[0-9a-f]+)?\.json$/;

/** kimi-code 2.4.1 (revokedTombstone) keeps a sign-in the provider refused as a file with both tokens empty, and reads an
 * unparseable file as no sign-in. */
function kimiTokenHeld(path: string): boolean {
  try {
    const token: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!token || typeof token !== "object") return false;
    const { access_token: access, refresh_token: refresh } = token as Record<string, unknown>;
    return !(access === "" && refresh === "");
  } catch {
    return false;
  }
}

/** Reads the child's own data root (a custom HOME or KIMI_CODE_HOME), never the server user's. */
function kimiSignedIn(env: Record<string, string | undefined>): boolean {
  const credentials = join(kimiDataRoot(env), "credentials");
  try {
    return readdirSync(credentials).some((name) => KIMI_TOKEN_FILE.test(name) && kimiTokenHeld(join(credentials, name)));
  } catch {
    return false;
  }
}

/** Never the CLI's own words, which may carry tokens (kimi-code 2.4.1 ends with "Login failed: …" or "Login cancelled: …",
 * and after 900s with "Login failed: Device authorization timed out"). */
function kimiLoginFailure(output: string): string {
  if (/expired|timed out/i.test(output)) return "The Kimi sign-in code expired. Start sign-in again for a new code.";
  if (/denied|login cancelled/i.test(output)) return "Kimi sign-in was declined in the browser. Start sign-in again to try once more.";
  return "Kimi sign-in did not finish. Check the server's connection, then try again.";
}

/** `kimi login`, Kimi Code's device-code login (kimi-code 2.4.1). Kimi has no status command, so nothing is checked first. */
export const KIMI_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "kimi",
  product: "Kimi",
  account: "Kimi Code",
  homeEnv: "KIMI_CODE_HOME",
  homeDir: ".kimi-code",
  loginArgs: ["login"],
  install: "Install it with Moonshot's installer (https://code.kimi.com), or from Settings when this server has npm, then try again.",
  failure: kimiLoginFailure,
  signedIn: kimiSignedIn,
};

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return quoteToml(key);
}

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

/** Invalid, unknown, surrogate or out-of-range escapes return ok:false, so a heading is never
 *  canonicalized to a colliding alias. */
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

function unquoteTomlKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    return key.slice(1, -1);
  }
  return key;
}

function tomlRowKey(row: string): string {
  const eq = row.indexOf("=");
  return unquoteTomlKey(eq < 0 ? row : row.slice(0, eq));
}

/** `[[array]]` headings bound a table but are not patchable; skipping `#` comments keeps an
 *  apostrophe from opening a phantom string. */
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

function hasTomlTable(text: string, heading: string): boolean {
  const name = canonicalizeTomlHeading(heading);
  return name !== null && tomlTables(text).some((table) => table.name === name);
}

/** Insert missing keys into an existing table, never overwriting set values. */
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
  // Kimi 0.36+ refuses openai_legacy as a wire protocol (ACP then falls through to OAuth).
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

/** Env keys Kimi 0.36+ reads to synthesize an in-memory default model. ACP `session/new` checks auth
 *  against `default_model`, not `-m`, so without one an expired login fails even a local host. */
const KIMI_MODEL_ENV = [
  "KIMI_MODEL_NAME",
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_BASE_URL",
  "KIMI_MODEL_PROVIDER_TYPE",
  "KIMI_MODEL_DISPLAY_NAME",
] as const;

/** Kimi strips these reserved entries when it persists config.toml, so they ride the env only. */
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
  // The env overlay accepts openai | anthropic | kimi, not the toml openai_legacy type.
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
  // The CLI's own catalog aliases (~/.kimi-code/config.toml; `kimi provider list` reports the same four).
  models: STATIC_KIMI_MODELS,
  resolveModels: (env) => mergeLocalInject(readKimiModelCatalog(env), env),
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi is not signed in to your Kimi Code account — choose Sign in to Kimi in engine setup",

  install: {
    command: {
      darwin: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      win32: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    npmPackage: "@moonshot-ai/kimi-code",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    signInCommand: "kimi login",
  },
  deviceSignIn: KIMI_DEVICE_SIGN_IN,

  // -m is a global commander option and must precede `acp` (0.29.1).
  resolveTurnModel: (model, env) => (model ? ensureKimiInjectAlias(model, env) : model),
  spawnArgs: (_config, turn) => {
    const model = turn.model;
    return [...(model ? ["-m", model] : []), "acp"];
  },

  // A leaked Moonshot/Kimi API key must not flip billing to pay-as-you-go.
  transformEnv: (env) => {
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
    stripKimiModelEnv(env);
  },
  applyTurnEnv: (env, { requestedModel }) => {
    applyKimiLocalModelEnv(env, requestedModel);
  },

  // The only authMethod is {id:"login", type:"terminal"}, a device-code flow ACP cannot drive.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: kimiSignedIn,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
