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
import { clinePassModels, clineTierModels, clineTierProvider } from "./cline-models.ts";

const DEFAULT_OPTION = { id: "cline-default", label: "Cline default (configured)" };
const MODELS: ModelCatalog = { default: DEFAULT_OPTION.id, options: [DEFAULT_OPTION] };

// Cline 3.0.74 refuses session/set_config_option `provider` while CLINE_PROVIDER is set, so the child gets this instead.
const PROVIDER_ENV = "OMB_CLINE_PROVIDER";

type ClineSettings ={ provider: string; model?: string; apiKey?: string; auth?: { accessToken?: string; apiKey?: string } };

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
    const provider = env.CLINE_PROVIDER || env[PROVIDER_ENV] || stored.lastUsedProvider;
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
  // Cline rounds the wait down to the minute.
  const resetsAt = RESET_IN.test(text) ? now + delayMs + 60_000 : undefined;
  const failure = engineFailure("Cline", "", { kind: "usage_limit", status: null, resetsAt })!;
  const facts = { ...failure, ...(resetsAt === undefined ? {} : { limitResetsAt: resetsAt }) };
  if (!/\bclinepass\b/i.test(text)) return new AcpReportedFailure(facts, true);
  // limitFacts reads this message to hold only the ClinePass models, so the generic localized text cannot stand in.
  const message = failure.message.replace("This Cline account has reached its usage limit", PASS_LIMIT)
    .replace("switch this bot to another AI", "pick a free Cline model or another AI");
  return new AcpReportedFailure({ ...facts, message, text: undefined }, true);
}

const PASS_LIMIT = "Your ClinePass allowance has run out";

/** Cline 3.0.74: "No access to ClinePass subscription models yet. Subscribe to ClinePass, ...: https://app.cline.bot/..." */
const NO_PASS = /\bNo access to ClinePass subscription models\b/i;

export function clineReportedFailure(error: unknown): AcpReportedFailure | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!NO_PASS.test(text)) return clinePlanLimit(error);
  return new AcpReportedFailure({
    message: "ClinePass models need a ClinePass subscription. Subscribe at https://app.cline.bot/dashboard/subscription?personal=true, or pick a free Cline model.",
  }, false);
}

type ConfigOption ={ id?: string; currentValue?: unknown };

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
  // Cline 3.0.74 has no ACP effort option; without --thinking it reuses the level last chosen in its TUI.
  effortLevels: ["none", "low", "medium", "high", "xhigh"],
  spawnArgs: (_config, turn) => ["--acp", "--auto-approve", "false", ...(turn.effort ? ["--thinking", turn.effort] : [])],
  restartOnMcpChange: true,
  credentialEnv: ["CLINE_API_KEY"],
  transformEnv(env, config) {
    const saved = savedProvider(env, config.cli)?.settings;
    const provider = env.CLINE_PROVIDER || saved?.provider;
    delete env.CLINE_PROVIDER;
    if (provider) env[PROVIDER_ENV] = provider;
    if (!saved) return;
    // ACP restores OAuth accounts itself but needs CLINE_API_KEY for BYOK; never another account's key.
    if (!OAUTH.has(saved.provider)) env.CLINE_API_KEY ||= saved.apiKey || saved.auth?.apiKey;
  },
  spawnFingerprint: (env, config) => savedProvider(env, config.cli)?.fingerprint ?? "unconfigured",
  pickAuthMethod: (methods, env) => {
    const provider = env[PROVIDER_ENV] ?? "";
    return !env.CLINE_API_KEY && OAUTH.has(provider) && methods.some((method) => method.id === provider) ? provider : null;
  },
  authFailure: "fail-request",
  // Missing credentials are rejected by session/new; never launch an interactive sign-in during a turn.
  isAuthenticated: (env, config) => {
    if (env.CLINE_API_KEY?.trim()) return true;
    return oauthSignedIn(savedProvider(env, config.cli)?.settings);
  },
  requireAuthenticationBeforeSpawn: true,
  // Cline's list is read only for someone signed in to Cline: nobody else's server calls Cline.
  resolveModels: async (env, config, instanceId) => ({ default: DEFAULT_OPTION.id,
    options: [DEFAULT_OPTION, ...await CLINE_SUPPORT.isAuthenticated(env, config, instanceId) ? await clineTierModels() : []] }),
  resolveTurnModel(model, env) {
    if (clineTierProvider(model)) return model;
    if (model && model !== DEFAULT_OPTION.id) {
      throw new Error("Pick a Cline model from the list, or Cline default (configured).");
    }
    return env.CLINE_MODEL?.trim();
  },
  async configureSession({ request, sessionId, env, config, turn, currentModelId, configOptions }) {
    // The same array the driver keeps for the next turn, so set_model below must update its `model` entry too.
    let options = configOptions as ConfigOption[];
    const option = (id: string) => options.find((entry) => entry.id === id);
    const setOption = async (configId: string, value: string) => {
      const current = option(configId);
      if (!current || current.currentValue === value) return;
      const result = await request("session/set_config_option", { sessionId, configId, value }) as { configOptions?: unknown } | undefined;
      options = Array.isArray(result?.configOptions) ? result.configOptions : options;
    };
    const setModel = async (modelId: string) => {
      await request("session/set_model", { sessionId, modelId });
      const current = option("model");
      if (current) current.currentValue = modelId;
    };
    const tier = clineTierProvider(turn.model);
    if (tier) {
      // The agent lists only its provider's models, but runs a model it did not list.
      await setOption("provider", tier);
      if (option("model")) await setOption("model", turn.model!);
      else if (turn.model !== currentModelId) await setModel(turn.model!);
      return;
    }
    const provider = env[PROVIDER_ENV];
    if (provider) await setOption("provider", provider);
    // session/new falls back when a saved custom model is missing from Cline's built-in catalog.
    const model = env.CLINE_MODEL?.trim() || savedProvider(env, config.cli)?.settings.model?.trim();
    if (model && model !== (option("model")?.currentValue ?? currentModelId)) await setModel(model);
  },
  reportedFailure: clineReportedFailure,
  // The ClinePass allowance holds only the ClinePass models; free models keep running.
  // Cline default runs the saved provider's model, so a ClinePass limit on it holds the default too.
  limitFacts: (text, model) => clineTierProvider(model) === "cline-pass" || text.startsWith(PASS_LIMIT)
    ? { limit: "model", limitModels: [...new Set([clineTierProvider(model) ? model! : DEFAULT_OPTION.id, ...clinePassModels()])] }
    : { limit: "engine" },
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
