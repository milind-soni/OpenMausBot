// Factory Droid harness support — the `droid` CLI over ACP stdio
// (`droid exec -o acp`), on the Factory login (~/.factory/auth.v2.file) or a
// FACTORY_API_KEY. The generic protocol runtime lives in acp/core.ts; this
// file is only the per-harness quirks. Verified against droid 0.196.0:
// initialize reports protocolVersion 1, loadSession:true (session/load resume
// works), promptCapabilities image+embeddedContext, and authMethods
// device-pairing + factory-api-key.
//
// UNLIKE every other ACP harness here, droid ignores argv for session
// settings. `droid exec --help` says so under "Stream JSON-RPC Mode": "CLI
// flags do not configure JSON-RPC sessions: -m/--model, --auto,
// -r/--reasoning-effort, and --disable-builtin-skills are still validated,
// but session settings come from JSON-RPC requests." So a `-m` that only
// reaches argv is accepted and then ignored, and the session runs whatever
// ~/.factory/settings.json selected. Model and autonomy are session config
// options set over the wire (session/set_model, session/set_mode), which is
// why both live in configureSession() below and NOT in spawnArgs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// FACTORY_HOME_OVERRIDE replaces the HOME the CLI resolves, NOT the data root:
// droid builds every path as <home>/.factory/… (verified against 0.196.0 —
// `FACTORY_HOME_OVERRIDE=/tmp/x droid exec -o acp` created /tmp/x/.factory/).
// Kimi's KIMI_CODE_HOME is a data root; this one is not, so the `.factory`
// segment stays on both branches.
//
// Which credential file exists depends on the `secure_auth_storage` feature
// flag droid fetches for the account: with secure storage on it writes
// auth.v2.loginkeychain (macOS) or auth.v2.keyring (keytar), and only falls
// back to auth.v2.file when that write fails. droid's own check tries all of
// them, so checking one name alone reports a fresh signed-in login as logged
// out. Names read from the 0.196.0 binary.
const AUTH_FILES = ["auth.v2.file", "auth.v2.loginkeychain", "auth.v2.keyring"];

function authFilePaths(env: Record<string, string | undefined>) {
  const home = env.FACTORY_HOME_OVERRIDE || env.HOME || homedir();
  return AUTH_FILES.map((name) => join(home, ".factory", name));
}

// droid's real catalog is half user-local: `custom:` providers (Azure, a
// local LM Studio server, …) live in ~/.factory/settings.json, the user
// orders the picker with modelFavorites, and sessionDefaultSettings.model is
// the model the CLI itself starts on. None of that can be enumerated from a
// static list, so read it and fall back to the built-in slice if unreadable.
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

function factoryHome(env: Record<string, string | undefined>): string {
  return env.FACTORY_HOME_OVERRIDE || env.HOME || env.USERPROFILE || homedir();
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
  const dir = join(factoryHome(env), ".factory");
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

/** ACP `session/new` throws "Authentication required" unless a Factory
 *  login or FACTORY_API_KEY is present — even for a BYOK custom model.
 *  Droid 0.198 only checks that the env var is set, then uses the
 *  custom row's own key for the local host. Do not invent a key for
 *  subscription models, and do not overwrite a real Factory key. */
export function applyDroidLocalAuthEnv(
  env: Record<string, string | undefined>,
  modelId: string | undefined,
): void {
  if (!decodeInjectId(modelId)) return;
  if (env.FACTORY_API_KEY?.trim()) return;
  // session/new already succeeds on a Factory login file. A placeholder
  // FACTORY_API_KEY can take precedence over that login, so leave env
  // alone when one of the auth files is present.
  if (authFilePaths(env).some(existsSync)) return;
  env.FACTORY_API_KEY = "openmausbot-local";
}

function readSettings(env: Record<string, string | undefined>): FactorySettings {
  return JSON.parse(readFileSync(join(factoryHome(env), ".factory", "settings.json"), "utf8")) as FactorySettings;
}

async function resolveModels(env: Record<string, string | undefined>) {
  let catalog = MODELS;
  try {
    const settings = readSettings(env);
    const custom = (settings.customModels ?? []).flatMap((m) => {
      // Live inject rows come from mergeLocalInject as host::model. Skip the
      // BYOK copies we wrote so the picker does not list the same model twice.
      if (m.id?.startsWith(INJECT_ID_PREFIX)) return [];
      const id = m.id || (m.model ? `custom:${m.model}` : "");
      if (!id) return [];
      return [{ id, label: m.displayName || m.model || id, custom: true as const }];
    });
    const merged = [...custom, ...MODELS.options.filter((o) => !custom.some((c) => c.id === o.id))];

    // Favourites first, in the user's own order; everything else keeps its
    // existing order (Array.prototype.sort is stable).
    const rank = new Map((settings.modelFavorites ?? []).map((id, i) => [id, i]));
    const options = merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));

    const configured = settings.sessionDefaultSettings?.model;
    const fallback = options[0]?.id ?? MODELS.default;
    catalog = {
      default: configured && options.some((o) => o.id === configured) ? configured : fallback,
      options,
    };
  } catch {
    // no settings file yet, or unreadable: ship the built-ins
  }
  return mergeLocalInject(catalog, env);
}

// droid answers a rejected setting with a bare JSON-RPC message ("Model not
// recognized", "Method not found") that reaches the error card verbatim,
// naming neither the engine nor the setting that failed. Say what we asked for.
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

// Autonomy maps onto droid's session modes (session/new advertises
// normal | spec | auto-low | auto-medium | auto-high). Always set it
// explicitly: ~/.factory/settings.json can pin a mode, and inheriting it
// would either make every session yolo or make fullAuto silently ask.
const MODE_DEFAULT = "normal"; // auto-approves reads only; everything else asks
const MODE_FULL_AUTO = "auto-high";

// A curated slice of `droid exec -m <bogus>`'s built-in catalog (0.196.0 lists
// 43). Custom models from ~/.factory/settings.json are per-machine and carry a
// `custom:` prefix, so they can't be enumerated statically; a bot can still be
// switched onto one through the model picker (PATCH /api/bots/:id).
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

  // No model/mode flags here on purpose: see the header note. `-o acp` is the
  // ACP entry point; everything else is negotiated over the protocol.
  spawnArgs: () => ["exec", "-o", "acp"],
  credentialEnv: ["FACTORY_API_KEY"],

  // The advertised methods are device-pairing (a browser flow that cannot be
  // driven over ACP) and factory-api-key (read from the child env, no
  // authenticate call needed). Ride the ambient login instead, like Kimi.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The signed-in CLI is the primary source; FACTORY_API_KEY is the fallback
  // droid itself advertises, and it is checked last so an ambient key can
  // never be what makes an otherwise logged-out instance look ready.
  isAuthenticated: (env) => authFilePaths(env).some(existsSync) || Boolean(env.FACTORY_API_KEY),
  resolveModels,
  resolveTurnModel: (model, env) => (model ? ensureDroidInjectModel(model, env) : model),
  applyTurnEnv: (env, { requestedModel }) => {
    applyDroidLocalAuthEnv(env, requestedModel);
  },

  async configureSession({ request, sessionId, config, turn }) {
    const modeId = config.fullAuto ? MODE_FULL_AUTO : MODE_DEFAULT;
    await applySetting(request, "session/set_mode", { sessionId, modeId }, `autonomy mode "${modeId}"`);
    // Pin the model for the same reason as the mode: with no set_model the
    // session runs whatever ~/.factory/settings.json selected, which can be a
    // `custom:` provider pointing at its own endpoint and key.
    const modelId = turn.model ?? MODELS.default;
    await applySetting(request, "session/set_model", { sessionId, modelId }, `model "${modelId}"`);
  },

  // House convention for ACP harnesses (grok, gemini, kimi all do this): the
  // persona rides in the prompt text rather than a CLI system-prompt flag.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DroidAgentDriver = createAcpDriver(support);
