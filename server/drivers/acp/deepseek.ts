// DeepSeek Harness support — DeepSeek's `dsh` (github.com/deepseek-ai/deepseek-harness)
// over ACP stdio (`dsh --profile acp`). The generic protocol runtime lives in
// acp/core.ts; this file is only the per-harness quirks. Verified against
// @deepseek-ai/dsh 0.2.1-rc.2 on 2026-10-22:
//
//   - initialize answers protocolVersion 1, authMethods [] (no sign-in step:
//     the DeepSeek key is read from DEEPSEEK_API_KEY or dsh's own
//     $DSH_HOME/.credentials.yaml), promptCapabilities.image false,
//     sessionCapabilities {close, list, resume} — resume is session/resume,
//     there is no session/load.
//   - session/new advertises two config options: `model` (category "model",
//     values are JSON pairs such as ["deepseek-official","deepseek-v4-flash"],
//     grouped per provider) and `reasoning_effort` (category "thought_level":
//     off | low | high | max). Both are set with session/set_config_option,
//     which answers with the full configOptions so the core can confirm the
//     change. That is exactly the OpenCode-shaped path (selectModel +
//     modelVariants), so model and effort need no driver code of their own.
//   - Warm boot to initialize is 1.6 s; the first boot after an install
//     creates $DSH_HOME/profiles/acp (a cold `npx` boot took ~120 s because
//     it downloaded the dependency tree, so the catalog is only probed on an
//     explicit Refresh, never at app startup).
//
// Picker ids are `<provider>/<model>` so bot settings, badges and config.json
// stay readable; resolveTurnModel turns them into dsh's wire pair just before
// the core selects the model.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome } from "../../env-path.ts";
import { resolveCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const DEEPSEEK_MODELS: ModelCatalog = {
  default: "deepseek-official/deepseek-v4-flash",
  options: [
    { id: "deepseek-official/deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-official/deepseek-flash", label: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
  ],
};

/** `provider/model` → dsh's `["provider","model"]`. An id with no provider
 * is handed to dsh as-is so its own error names the problem. */
export function deepseekWireValue(pickerId: string): string {
  const slash = pickerId.indexOf("/");
  if (slash <= 0 || slash === pickerId.length - 1) return pickerId;
  return JSON.stringify([pickerId.slice(0, slash), pickerId.slice(slash + 1)]);
}

/** Inverse of deepseekWireValue; null for anything but a two-string pair. */
export function deepseekPickerId(wireValue: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireValue);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [provider, model] = parsed;
  if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) return null;
  return `${provider}/${model}`;
}

export function dshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME || harnessHome("dsh", env);
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** dsh 0.2.1 writes `version: 1` with the key under `refs:`; it also migrates
 * the pre-release flat layout (the key at the top level), so both count. An
 * empty or quoted-empty value is "no key": dsh treats it as a boot error. */
function storedCredentialPresent(path: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!doc || typeof doc !== "object") return false;
  const root = doc as Record<string, unknown>;
  const refs = root.refs && typeof root.refs === "object" ? root.refs as Record<string, unknown> : {};
  return nonEmpty(refs.DEEPSEEK_API_KEY) || nonEmpty(root.DEEPSEEK_API_KEY);
}

const DOTENV_LINE = /^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=(.*)$/;

/** One dotenv assignment with a non-empty value, quotes and a trailing comment stripped. */
function dotenvValuePresent(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = DOTENV_LINE.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    const quoted = /^(["'])(.*)\1(?:[ \t]+#.*)?$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/[ \t]+#.*$/, "").trim();
    if (value !== "") return true;
  }
  return false;
}

/** A DeepSeek key dsh will find: the launch env, its stored credential file,
 * or its home .env (the layers dsh documents, read-only here). The stored
 * file outranks the env inside dsh; for "is there a key at all" any layer counts. */
export function hasDeepSeekKey(env: Record<string, string | undefined>): boolean {
  if (nonEmpty(env.DEEPSEEK_API_KEY)) return true;
  const home = dshHome(env);
  return storedCredentialPresent(join(home, ".credentials.yaml")) || dotenvValuePresent(join(home, ".env"));
}

/** Every `value` string under a select option, descending into groups. */
function offeredWireValues(sessionConfig: unknown, configId: string): { values: string[]; current: string | null } {
  const options = (sessionConfig as { configOptions?: unknown[] } | undefined)?.configOptions;
  const option = (Array.isArray(options) ? options : []).find(
    (entry: any) => entry?.id === configId,
  ) as { currentValue?: unknown; options?: unknown } | undefined;
  const values: string[] = [];
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string") values.push(entry.value);
      else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option?.options);
  return { values, current: typeof option?.currentValue === "string" ? option.currentValue : null };
}

/** The `model` config option of a session/new answer, as a picker catalog.
 * Groups carry dsh's provider display name, kept as the option's provider
 * badge so a gateway's copy of a model stays distinguishable. */
export function parseDeepSeekCatalog(sessionResult: unknown): ModelCatalog {
  const options = (sessionResult as { configOptions?: unknown[] } | undefined)?.configOptions;
  const option = (Array.isArray(options) ? options : []).find((entry: any) => entry?.id === "model") as
    { currentValue?: unknown; options?: unknown } | undefined;
  const out: ModelCatalog["options"] = [];
  const collect = (entries: unknown, provider: string | undefined) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (Array.isArray(entry?.options)) {
        const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim()
          : typeof entry.group === "string" ? entry.group : provider;
        collect(entry.options, name);
        continue;
      }
      if (typeof entry?.value !== "string") continue;
      const id = deepseekPickerId(entry.value);
      if (!id || out.some((row) => row.id === id)) continue;
      const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
      out.push({ id, label, ...(provider ? { provider } : {}) });
    }
  };
  collect(option?.options, undefined);
  if (!out.length) throw new Error("dsh advertised no models");
  const current = typeof option?.currentValue === "string" ? deepseekPickerId(option.currentValue) : null;
  return {
    default: current && out.some((row) => row.id === current) ? current : out[0]!.id,
    options: out,
  };
}

export const DEEPSEEK_MODELS_TIMEOUT_ENV = "OPENMAUS_DEEPSEEK_MODELS_TIMEOUT_MS";
/** A warm `dsh --profile acp` answers session/new in ~2 s; the first boot
 * after an install also creates the profile, so leave real headroom. */
export const DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS = 60_000;

function catalogTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[DEEPSEEK_MODELS_TIMEOUT_ENV];
  if (raw === undefined) return DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS;
}

/** Ask the installed dsh what it offers: initialize, session/new in `cwd`,
 * read the catalog, session/close. Rejects on any failure so the core keeps
 * the last usable catalog; never resolves to an empty or guessed list. */
export function fetchDeepSeekCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ModelCatalog> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const resolved = resolveCli(cli, ["--profile", "acp"], env);
      child = spawn(resolved.command, resolved.args, { stdio: ["pipe", "pipe", "ignore"], env: env as NodeJS.ProcessEnv, windowsHide: true });
    } catch (error) {
      return reject(error instanceof Error ? error : new Error(String(error)));
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { catalog: ModelCatalog } | { error: Error }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {}
      try {
        if (child.kill()) {
          const hardKill = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 1_000);
          hardKill.unref?.();
        }
      } catch {}
      if ("catalog" in outcome) resolve(outcome.catalog);
      else reject(outcome.error);
    };
    timer = setTimeout(() => finish({ error: new Error(`dsh timed out after ${catalogTimeoutMs(env)} ms without answering session/new`) }), catalogTimeoutMs(env));
    child.once("error", (error) => finish({ error }));
    // A child that already exited makes stdin emit EPIPE, and an unhandled stream 'error' crashes the server.
    child.stdin?.on("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ error: new Error(`dsh exited (${signal ?? code}) before answering session/new`) }));

    let buf = "";
    let nextId = 0;
    const send = (method: string, params: unknown): number => {
      nextId += 1;
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`, (error) => {
          if (error) finish({ error });
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
      return nextId;
    };
    let initId = 0;
    let sessionReqId = 0;
    let closeId = 0;
    let catalog: ModelCatalog | null = null;
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === initId) {
          if (!msg.result) return finish({ error: new Error(`dsh rejected initialize: ${JSON.stringify(msg.error ?? msg)}`) });
          sessionReqId = send("session/new", { cwd, mcpServers: [] });
        } else if (sessionReqId && msg?.id === sessionReqId) {
          const sessionId = typeof msg.result?.sessionId === "string" ? msg.result.sessionId : null;
          try {
            catalog = parseDeepSeekCatalog(msg.result);
          } catch (error) {
            // Best effort: the close is sent, but an unusable answer does not wait on it.
            if (sessionId) send("session/close", { sessionId });
            return finish({ error: error instanceof Error ? error : new Error(String(error)) });
          }
          if (!sessionId) return finish({ catalog });
          // Leave no half-open session behind in dsh's persisted list.
          closeId = send("session/close", { sessionId });
        } else if (closeId && msg?.id === closeId) {
          finish({ catalog: catalog! });
        }
      }
    });
    initId = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "openmausbot", version: "catalog" },
    });
  });
}

export const deepseekSupport: AcpSupport = {
  driverKind: "deepseekAgent",
  displayName: "DeepSeek Harness",
  models: DEEPSEEK_MODELS,
  defaultCli: "dsh",
  nativeSource: "deepseek.acp",
  loginNote: "DeepSeek Harness has no DeepSeek API key — paste one under Settings → Connections → Model providers, or set DEEPSEEK_API_KEY",

  install: {
    command: {
      darwin: "npm install -g @deepseek-ai/dsh",
      linux: "npm install -g @deepseek-ai/dsh",
      win32: "npm install -g @deepseek-ai/dsh",
    },
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    needsNode: true,
    // Keyless is "paste a key in Settings", not a terminal sign-in.
    settings: "connections",
  },

  spawnArgs: () => ["--profile", "acp"],
  credentialEnv: ["DEEPSEEK_API_KEY"],
  // Model and reasoning effort are session config options (see header).
  selectModel: { configId: "model" },
  modelVariants: true,
  resumeMethod: "resume",
  // Refresh only: a fresh profile boot can take long, and startup must not wait on it.
  resolveModels: (env, config) => fetchDeepSeekCatalog(config.cli || "dsh", env, tmpdir()),
  resolveModelsOnCreate: false,

  // initialize advertises no auth methods; the key rides in the child env or
  // dsh's own credential file, so there is nothing to call authenticate for.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => hasDeepSeekKey(env),

  resolveTurnModel: (model) => (model ? deepseekWireValue(model) : model),
  fallbackModel: (sessionConfig, catalogDefault) => {
    const { values, current } = offeredWireValues(sessionConfig, "model");
    const wanted = catalogDefault ? deepseekWireValue(catalogDefault) : "";
    if (wanted && values.includes(wanted)) return wanted;
    if (current && values.includes(current)) return current;
    return null;
  },

  // House convention for ACP harnesses: the persona rides in the prompt text.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DeepSeekAgentDriver = createAcpDriver(deepseekSupport);
