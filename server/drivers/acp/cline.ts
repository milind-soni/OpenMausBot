// Cline owns its saved provider/model configuration; no static OMB catalog switches providers.
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveCli } from "../../procs.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import type { ModelCatalog } from "../../contracts.ts";

const MODELS: ModelCatalog = {
  default: "cline-default",
  options: [{ id: "cline-default", label: "Cline default (configured)" }],
};

type ClineSettings = { provider: string; model?: string; apiKey?: string; auth?: { accessToken?: string; apiKey?: string } };

function savedProvider(env: Record<string, string | undefined>, config: AcpConfig): { settings: ClineSettings; fingerprint: string } | null {
  try {
    const args = resolveCli(config.cli, [], env).args;
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

const LOGIN_NOTE = "Cline is not configured. Run cline auth in a terminal, then try again.";

const SUPPORT: AcpSupport = {
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
    const saved = savedProvider(env, config)?.settings;
    if (!saved) return;
    env.CLINE_PROVIDER ||= saved.provider;
    env.CLINE_MODEL ||= saved.model;
    // ACP restores OAuth accounts itself but needs CLINE_API_KEY for BYOK; never another account's key.
    if (!OAUTH.has(saved.provider)) env.CLINE_API_KEY ||= saved.apiKey || saved.auth?.apiKey;
  },
  spawnFingerprint: (env, config) => savedProvider(env, config)?.fingerprint ?? "unconfigured",
  pickAuthMethod: (methods, env) => !env.CLINE_API_KEY && OAUTH.has(env.CLINE_PROVIDER ?? "")
    && methods.some((method) => method.id === env.CLINE_PROVIDER) ? env.CLINE_PROVIDER! : null,
  authFailure: "fail-request",
  // Missing credentials are rejected by session/new; never launch an interactive sign-in during a turn.
  isAuthenticated: (env, config) => {
    if (env.CLINE_API_KEY?.trim()) return true;
    const saved = savedProvider(env, config)?.settings;
    return Boolean(saved && OAUTH.has(saved.provider) &&
      (saved.auth?.accessToken?.trim() || saved.apiKey?.trim() || saved.auth?.apiKey?.trim()));
  },
  requireAuthenticationBeforeSpawn: true,
  resolveTurnModel(model, env) {
    if (model && model !== "cline-default") {
      throw new Error("Select Cline default (configured). Change Cline's provider or model with cline auth in a terminal.");
    }
    return env.CLINE_MODEL?.trim();
  },
  async configureSession({ request, sessionId, env, currentModelId }) {
    // session/new falls back when a saved custom model is missing from Cline's built-in catalog.
    const model = env.CLINE_MODEL?.trim();
    if (model && model !== currentModelId) {
      await request("session/set_model", { sessionId, modelId: model });
    }
  },
};

export const ClineAgentDriver = {
  ...createAcpDriver(SUPPORT),
  async create(input: Parameters<ReturnType<typeof createAcpDriver>["create"]>[0]) {
    // Cline 3.0.70 records ACP mcpServers without connecting them; its native settings override connects
    // the scoped stdio servers instead, without rewriting the user's MCP file.
    const directory = mkdtempSync(join(tmpdir(), "omb-cline-mcp-"));
    const cleanup = () => {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    };
    try {
      const driver = createAcpDriver({
        ...SUPPORT,
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
