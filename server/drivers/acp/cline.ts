// Cline owns its saved provider/model configuration. Its free and ClinePass models run on Cline's own `cline` and
// `cline-pass` providers, which a turn switches the session to.
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { engineFailure } from "../engine-errors.ts";
import { AcpReportedFailure } from "./failure-words.ts";
import { clineTierModels, clineTierProvider } from "./cline-models.ts";

const DEFAULT_OPTION = { id: "cline-default", label: "Cline default (configured)" };
const MODELS: ModelCatalog = { default: DEFAULT_OPTION.id, options: [DEFAULT_OPTION] };

type ClineSettings = { provider: string; model?: string; apiKey?: string; auth?: { accessToken?: string; apiKey?: string } };

function savedProvider(env: Record<string, string | undefined>, cli: string): { settings: ClineSettings; fingerprint: string } | null {
  try {
    const args = resolveCli(cli, [], env).args;
    const flag = (name: string) => {
      const index = args.lastIndexOf(name);
      return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    };
    const home = flag("--config") || env.CLINE_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".cline");
    const data = flag("--data-dir") || env.CLINE_DATA_DIR || join(home, "data");
    const path = env.CLINE_PROVIDER_SETTINGS_PATH || join(data, "settings", "providers.json");
    if (statSync(path).size > 256 * 1024) return null;
    const text = readFileSync(path, "utf8");
    const stored = JSON.parse(text);
    if (stored?.version !== 1 || !stored.providers || Array.isArray(stored.providers)) return null;
    const provider = env.CLINE_PROVIDER || stored.lastUsedProvider;
    if (typeof provider !== "string" || !/^[\w.-]{1,100}$/.test(provider)) return null;
    const settings = stored.providers[provider]?.settings;
    if (!settings || settings.provider !== provider) return null;
    for (const name of ["model", "apiKey"] as const) {
      if (settings[name] !== undefined && typeof settings[name] !== "string") return null;
    }
    if (settings.auth !== undefined) {
      if (!settings.auth || typeof settings.auth !== "object" || Array.isArray(settings.auth)) return null;
      for (const name of ["accessToken", "apiKey"] as const) {
        if (settings.auth[name] !== undefined && typeof settings.auth[name] !== "string") return null;
      }
    }
    return { settings, fingerprint: createHash("sha256").update(text).digest("hex") };
  } catch {
    return null;
  }
}

const OAUTH = new Set(["cline", "cline-pass", "openai-codex"]);

function oauthSignedIn(settings: ClineSettings | undefined): boolean {
  return Boolean(settings && OAUTH.has(settings.provider) &&
    (settings.auth?.accessToken?.trim() || settings.apiKey?.trim() || settings.auth?.apiKey?.trim()));
}

const LOGIN_NOTE = "Cline is not configured. Run cline auth in a terminal, then try again.";

/** Cline 3.0.74: "You have reached your weekly Clinepass limit. The limit resets in 8h 30m, please try again later." */
const PLAN_LIMIT = /\breached your (?:session|daily|weekly|monthly|\d+-hour) [\w-]+ limit\b/i;
const RESET_IN = /\bresets in ((?:\s*\d+\s*[dhm]\b)+)/i;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

export function clinePlanLimit(error: unknown, now = Date.now()): AcpReportedFailure | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!PLAN_LIMIT.test(text)) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of RESET_IN.exec(text)?.[1]?.matchAll(/(\d+)\s*([dhm])/gi) ?? []) {
    delayMs += Number(amount) * UNIT_MS[unit!.toLowerCase()]!;
  }
  // holds the whole engine, free models too; hold only the ClinePass models via limitFacts if that bites.
  // Cline rounds the wait down to the minute.
  const resetsAt = delayMs > 0 ? now + delayMs + 60_000 : undefined;
  const failure = engineFailure("Cline", "", { kind: "usage_limit", status: null, resetsAt })!;
  return new AcpReportedFailure({ ...failure, ...(resetsAt === undefined ? {} : { limitResetsAt: resetsAt }) }, true);
}

type ConfigOption = { id?: string; currentValue?: unknown };

export const CLINE_SUPPORT: AcpSupport = {
  driverKind: "clineAgent",
  displayName: "Cline",
  models: MODELS,
  defaultCli: "cline",
  nativeSource: "cline.acp",
  images: true,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "npm install -g cline", linux: "npm install -g cline", win32: "npm install -g cline" },
    needsNode: true,
    docsUrl: "https://docs.cline.bot/usage/acp",
    signInCommand: "cline auth",
  },
  // Never inherit Cline's terminal auto-approval default or a saved grant: the ACP broker answers permissions.
  spawnArgs: () => ["--acp", "--auto-approve", "false"],
  restartOnMcpChange: true,
  credentialEnv: ["CLINE_API_KEY"],
  transformEnv(env, config) {
    const saved = savedProvider(env, config.cli)?.settings;
    // Not CLINE_PROVIDER: Cline 3.0.74 refuses session/set_config_option `provider` while it is set.
    if (!saved) return;
    // ACP restores OAuth accounts itself but needs CLINE_API_KEY for BYOK; never another account's key.
    if (!OAUTH.has(saved.provider)) env.CLINE_API_KEY ||= saved.apiKey || saved.auth?.apiKey;
  },
  spawnFingerprint: (env, config) => savedProvider(env, config.cli)?.fingerprint ?? "unconfigured",
  pickAuthMethod: (methods, env) => {
    const provider = env.CLINE_PROVIDER || savedProvider(env, "cline")?.settings.provider || "";
    return !env.CLINE_API_KEY && OAUTH.has(provider) && methods.some((method) => method.id === provider) ? provider : null;
  },
  authFailure: "fail-request",
  // Missing credentials are rejected by session/new; never launch an interactive sign-in during a turn.
  isAuthenticated: (env, config) => {
    if (env.CLINE_API_KEY?.trim()) return true;
    return oauthSignedIn(savedProvider(env, config.cli)?.settings);
  },
  requireAuthenticationBeforeSpawn: true,
  resolveModels: async () => ({ default: DEFAULT_OPTION.id, options: [DEFAULT_OPTION, ...await clineTierModels()] }),
  resolveTurnModel(model, env) {
    if (clineTierProvider(model)) return model;
    if (model && model !== DEFAULT_OPTION.id) {
      throw new Error("Pick a Cline model from the list, or Cline default (configured).");
    }
    return env.CLINE_MODEL?.trim();
  },
  async configureSession({ request, sessionId, env, config, turn, currentModelId, configOptions }) {
    const options = configOptions as ConfigOption[];
    const option = (id: string) => options.find((entry) => entry.id === id);
    const setOption = async (configId: string, value: string) => {
      const current = option(configId);
      if (current && current.currentValue !== value) await request("session/set_config_option", { sessionId, configId, value });
    };
    const tier = clineTierProvider(turn.model);
    if (tier) {
      // The agent lists only its provider's models, but runs a model it did not list.
      await setOption("provider", tier);
      if (option("model")) await setOption("model", turn.model!);
      else if (turn.model !== currentModelId) await request("session/set_model", { sessionId, modelId: turn.model });
      return;
    }
    const saved = savedProvider(env, config.cli)?.settings;
    const provider = env.CLINE_PROVIDER || saved?.provider;
    if (provider) await setOption("provider", provider);
    // session/new falls back when a saved custom model is missing from Cline's built-in catalog.
    const model = env.CLINE_MODEL?.trim() || saved?.model?.trim();
    if (model && model !== (option("model")?.currentValue ?? currentModelId)) {
      await request("session/set_model", { sessionId, modelId: model });
    }
  },
  reportedFailure: (error) => clinePlanLimit(error),
};

export const ClineAgentDriver = {
  ...createAcpDriver(CLINE_SUPPORT),
  async create(input: Parameters<ReturnType<typeof createAcpDriver>["create"]>[0]) {
    // Cline 3.0.70 records ACP mcpServers without connecting them; its native settings override connects
    // the scoped stdio servers instead, without rewriting the user's MCP file.
    const directory = mkdtempSync(join(tmpdir(), "omb-cline-mcp-"));
    const cleanup = () => {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    };
    try {
      const driver = createAcpDriver({
        ...CLINE_SUPPORT,
        applyTurnEnv(env, { threadId, mcpServers }) {
          const path = join(directory, `${createHash("sha256").update(threadId).digest("hex")}.json`);
          const mcp = Object.fromEntries(mcpServers.flatMap((server) => "command" in server ? [server] : []).map(({ name, command, args, env: serverEnv }) => [name, {
            transport: { type: "stdio", command, args, env: Object.fromEntries(serverEnv.map(({ name, value }) => [name, value])) },
          }]));
          const text = JSON.stringify({ mcpServers: mcp });
          let previous: string | undefined;
          try { previous = readFileSync(path, "utf8"); } catch {}
          if (previous !== text) {
            writeFileSync(`${path}.next`, text, { mode: 0o600 });
            renameSync(`${path}.next`, path);
          }
          // An empty selection also replaces ambient native MCP settings.
          env.CLINE_MCP_SETTINGS_PATH = path;
        },
      });
      const instance = await driver.create(input);
      const dispose = instance.dispose;
      instance.dispose = async () => {
        try { await dispose(); } finally { cleanup(); }
      };
      return instance;
    } catch (error) {
      cleanup();
      throw error;
    }
  },
};
