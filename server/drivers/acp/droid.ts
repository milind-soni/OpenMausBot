// Factory Droid: `droid exec -o acp` on the Factory login (~/.factory/auth.v2.*) or FACTORY_API_KEY.
// droid ignores argv for session settings; `droid exec --help` ("Stream JSON-RPC Mode"): "CLI flags do
// not configure JSON-RPC sessions: -m/--model, --auto, -r/--reasoning-effort, and
// --disable-builtin-skills are still validated, but session settings come from JSON-RPC requests."
// So model and autonomy are set over the wire in configureSession (verified on droid 0.196.0).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "../../env-path.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// FACTORY_HOME_OVERRIDE replaces the HOME the CLI resolves, not the data root: paths are
// <home>/.factory/… (0.196.0). With the `secure_auth_storage` flag droid writes auth.v2.loginkeychain
// (macOS) or auth.v2.keyring, falling back to auth.v2.file (names from the 0.196.0 binary).
const AUTH_FILES = ["auth.v2.file", "auth.v2.loginkeychain", "auth.v2.keyring"];

function authFilePaths(env: Record<string, string | undefined>) {
  const home = env.FACTORY_HOME_OVERRIDE || userHome(env);
  return AUTH_FILES.map((name) => join(home, ".factory", name));
}

// `custom:` providers, modelFavorites and sessionDefaultSettings.model live in ~/.factory/settings.json.
interface FactoryCustomModel {
  id?: string;
  model?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
}

interface FactorySettings {
  customModels?: FactoryCustomModel[];
  modelFavorites?: string[];
  sessionDefaultSettings?: { model?: string };
}

const INJECT_ID_PREFIX = "custom:openmausbot-";

export function droidInjectId(host: string, model: string): string {
  const safe = `${host}-${model}`.replace(/[^a-zA-Z0-9._+-]+/g, "-").replace(/-+/g, "-");
  return `${INJECT_ID_PREFIX}${safe}`;
}

/** Upsert a BYOK custom model so session/set_model can reach the local host. */
export function ensureDroidInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const id = droidInjectId(inject.host, inject.model);
  const dir = join(env.FACTORY_HOME_OVERRIDE || userHome(env), ".factory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  let settings: FactorySettings & Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as FactorySettings & Record<string, unknown>;
  } catch (error) {
    if (existsSync(path)) throw error;
  }
  const custom = Array.isArray(settings.customModels) ? [...settings.customModels] : [];
  const match = custom.find(
    (row) =>
      row.id === id || (row.model === inject.model && row.baseUrl === host.baseUrl),
  );
  if (match) {
    if (!match.id) {
      match.id = id;
      settings.customModels = custom;
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    }
    return match.id;
  }
  custom.push({
    id,
    model: inject.model,
    displayName: `${inject.model} (${host.label})`,
    baseUrl: host.baseUrl,
    apiKey: hostApiKey(host, env),
    provider: "generic-chat-completion-api",
  });
  settings.customModels = custom;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return id;
}

/** ACP `session/new` throws "Authentication required" without a Factory login or FACTORY_API_KEY, even
 *  for a BYOK custom model; droid 0.198 only checks that the env var is set. */
export function applyDroidLocalAuthEnv(
  env: Record<string, string | undefined>,
  modelId: string | undefined,
): void {
  if (!decodeInjectId(modelId)) return;
  if (env.FACTORY_API_KEY?.trim()) return;
  // A placeholder FACTORY_API_KEY can take precedence over a login file.
  if (authFilePaths(env).some(existsSync)) return;
  env.FACTORY_API_KEY = "openmausbot-local";
}

function readSettings(env: Record<string, string | undefined>): FactorySettings {
  return JSON.parse(readFileSync(join(env.FACTORY_HOME_OVERRIDE || userHome(env), ".factory", "settings.json"), "utf8")) as FactorySettings;
}

async function resolveModels(env: Record<string, string | undefined>) {
  let catalog = MODELS;
  try {
    const settings = readSettings(env);
    const custom = (settings.customModels ?? []).flatMap((m) => {
      if (m.id?.startsWith(INJECT_ID_PREFIX)) return [];
      const id = m.id || (m.model ? `custom:${m.model}` : "");
      if (!id) return [];
      return [{ id, label: m.displayName || m.model || id, custom: true as const }];
    });
    const merged = [...custom, ...MODELS.options.filter((o) => !custom.some((c) => c.id === o.id))];

    const rank = new Map((settings.modelFavorites ?? []).map((id, i) => [id, i]));
    const options = merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));

    const configured = settings.sessionDefaultSettings?.model;
    const fallback = options[0]?.id ?? MODELS.default;
    catalog = {
      default: configured && options.some((o) => o.id === configured) ? configured : fallback,
      options,
    };
  } catch {}
  return mergeLocalInject(catalog, env);
}

// droid rejects a setting with a bare message ("Model not recognized") naming neither engine nor setting.
async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(
      `Droid rejected ${what} via ${method}: ${(e as Error).message}. ` +
        `Check that \`droid\` is current (0.196.0+ supports it) and that this account can use that value.`,
    );
  }
}

// droid's session modes: normal | spec | auto-low | auto-medium | auto-high. Always set explicitly:
// ~/.factory/settings.json can pin a mode.
const MODE_DEFAULT = "normal"; // auto-approves reads only; everything else asks
const MODE_FULL_AUTO = "auto-high";

// A curated slice of `droid exec -m <bogus>`'s built-in catalog (0.196.0 lists 43).
const MODELS = {
  default: "claude-opus-5",
  options: [
    { id: "auto", label: "Auto (Factory picks)" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "glm-5.2", label: "GLM 5.2" },
    { id: "kimi-k3", label: "Kimi K3" },
    { id: "grok-4.6", label: "Grok 4.6" },
  ],
};

const support: AcpSupport = {
  driverKind: "droidAgent",
  displayName: "Droid",
  models: MODELS,
  defaultCli: "droid",
  nativeSource: "droid.acp",
  loginNote: "Droid CLI is not signed in — run `droid` once and log in, or set FACTORY_API_KEY",

  install: {
    command: {
      darwin: "curl -fsSL https://app.factory.ai/cli | sh",
      linux: "curl -fsSL https://app.factory.ai/cli | sh",
      win32: "irm https://app.factory.ai/cli/windows | iex",
    },
    docsUrl: "https://docs.factory.ai/droid-cli/quickstart",
    signInCommand: "droid",
  },

  spawnArgs: () => ["exec", "-o", "acp"],
  credentialEnv: ["FACTORY_API_KEY"],

  // device-pairing is a browser flow ACP cannot drive; factory-api-key is read from the env.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => authFilePaths(env).some(existsSync) || Boolean(env.FACTORY_API_KEY),
  resolveModels,
  resolveTurnModel: (model, env) => (model ? ensureDroidInjectModel(model, env) : model),
  applyTurnEnv: (env, { requestedModel }) => {
    applyDroidLocalAuthEnv(env, requestedModel);
  },

  async configureSession({ request, sessionId, config, turn }) {
    const modeId = config.fullAuto ? MODE_FULL_AUTO : MODE_DEFAULT;
    await applySetting(request, "session/set_mode", { sessionId, modeId }, `autonomy mode "${modeId}"`);
    const modelId = turn.model ?? MODELS.default;
    await applySetting(request, "session/set_model", { sessionId, modelId }, `model "${modelId}"`);
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DroidAgentDriver = createAcpDriver(support);
