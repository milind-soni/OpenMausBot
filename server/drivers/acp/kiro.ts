// Kiro CLI over ACP (`kiro-cli acp --agent-engine=v3 --auth-method=cli`), billed to the Kiro account `kiro-cli login`
// signed in, or to a Kiro Pro key in KIRO_API_KEY. Checked against kiro-cli 3.1.0:
//   - initialize offers authMethods [aws-builder-id, aws-iam-identity-center] ([kiro-login] in older bundles) and no
//     image input; `--auth-method=cli` keeps the access tokens inside Kiro;
//   - session/new advertises the account's models as the `model` config option, each model's effort as `effortLevel`,
//     Kiro's agents as `mode`, and `autopilot` (on/off), which sessions start "on";
//   - session/set_config_option sets each of them and answers with the full configOptions;
//   - `clientCapabilities._meta.kiro.hooks` keeps Kiro's own hooks running inside Kiro instead of asking the client;
//   - the V2 flags (`--agent-engine v2`, `--v2`) are refused by V3, which takes model and effort per session, not argv.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AccountErrorCode, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";

/** Leaves the session on the model the person picked in Kiro itself. */
const AGENT_DEFAULT = { id: "agent-default", label: "Kiro default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp", "--agent-engine=v3", "--auth-method=cli"];
const SIGN_IN = "kiro-cli login";
const API_KEY_ENV = "KIRO_API_KEY";
const LOGIN_NOTE = `Kiro is not signed in. Run ${SIGN_IN} in a terminal, or set ${API_KEY_ENV}, then check again.`;
const AUTH_METHODS = ["aws-builder-id", "aws-iam-identity-center", "kiro-login"];
/** Kiro's own hooks run inside Kiro; without this, V3 sends its `_kiro/hooks/*` requests to the client. */
const CLIENT_META = { kiro: { hooks: { enabled: true, v2: true } } };
/** A tool Kiro runs on its own at the start of a session to read its cloud settings; it is not the person's work. */
const CLOUD_CONFIG_TOOL = "fetch_cloud_config";
/** Where Kiro echoes a message sent while a turn runs back into the reply's text. */
const STEERING_ECHO = "[STEERING steer-";

/** Kiro keeps its sign-in in `data.sqlite3` in the system's local data folder: `~/Library/Application Support/kiro-cli`
 * on macOS, `$XDG_DATA_HOME/kiro-cli` (`~/.local/share/kiro-cli`) on Linux, and `%LOCALAPPDATA%\kiro-cli` on Windows. */
export function kiroDataDir(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const home = userHome(env);
  if (platform === "darwin") return join(home, "Library", "Application Support", "kiro-cli");
  if (platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "kiro-cli");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "kiro-cli");
}

/** Signed in by KIRO_API_KEY, or by a token `kiro-cli login` stored in the `auth_kv` table (`kirocli:social:token`,
 * `kirocli:odic:token`, or the older `codewhisperer:odic:token`). The store is only read, never written. */
export function kiroSignedIn(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  if (env[API_KEY_ENV]?.trim()) return true;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(kiroDataDir(env, platform), "data.sqlite3"), { readOnly: true });
    return db.prepare("SELECT 1 FROM auth_kv WHERE key LIKE '%:token' AND length(value) > 0 LIMIT 1").get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, clientCapabilitiesMeta: CLIENT_META, exitGraceMs: 1_000 };

export function resolveKiroModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
}

/** Hides Kiro's own cloud-settings tool, start to end, and cuts the steering echo out of the reply's text. */
export function kiroUpdateFilter(): (update: Record<string, any>) => Record<string, any> | null {
  const hiddenTools = new Set<string>();
  return (update) => {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (update._meta?.kiro?.toolId === CLOUD_CONFIG_TOOL) {
      if (toolCallId && update.status !== "completed" && update.status !== "failed") hiddenTools.add(toolCallId);
      else hiddenTools.delete(toolCallId);
      return null;
    }
    if (toolCallId && hiddenTools.has(toolCallId)) {
      if (update.status === "completed" || update.status === "failed") hiddenTools.delete(toolCallId);
      return null;
    }
    const text = update.sessionUpdate === "agent_message_chunk" ? update.content?.text : undefined;
    if (typeof text !== "string" || !text.includes(STEERING_ECHO)) return update;
    const kept = text.slice(0, text.indexOf(STEERING_ECHO)).trimEnd();
    return kept ? { ...update, content: { ...update.content, text: kept } } : null;
  };
}

export function describeKiroAccountError(code: AccountErrorCode): string {
  return code === "invalid_credentials" ? LOGIN_NOTE
    : "Kiro refused this request for the signed-in account. Check its Kiro plan and credits, then try again.";
}

const SUPPORT: AcpSupport = {
  driverKind: "kiroAgent",
  displayName: "Kiro",
  models: MODELS,
  defaultCli: "kiro-cli",
  nativeSource: "kiro.acp",
  images: false,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "curl -fsSL https://cli.kiro.dev/install | bash", linux: "curl -fsSL https://cli.kiro.dev/install | bash", win32: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
    docsUrl: "https://kiro.dev/docs/getting-started/installation/",
    signInCommand: SIGN_IN,
  },
  spawnArgs: () => SPAWN_ARGS,
  credentialEnv: [API_KEY_ENV],
  clientCapabilitiesMeta: CLIENT_META,
  resolveModels: (env, config) => resolveKiroModels(env, config),
  // Every fleet has this instance: the catalog comes from the startup cache and refreshes when the engine is picked.
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  pickAuthMethod: (methods) => AUTH_METHODS.find((id) => methods.some((method) => method.id === id)) ?? null,
  authFailure: "continue",
  isAuthenticated: (env) => kiroSignedIn(env),
  describeAccountError: describeKiroAccountError,
  accountErrorText: (code) => code === "invalid_credentials" ? undefined : { key: "chat.notice.kiroAccountRefused" },
  // Autopilot is set every turn, so an approval change never restarts Kiro.
  sessionScopedApproval: true,
  async configureSession({ request, sessionId, config }) {
    // Off, Kiro asks before each write or command and the app answers; on, only under Full access, it goes ahead.
    const value = config.fullAuto ? "on" : "off";
    try {
      await request("session/set_config_option", { sessionId, configId: "autopilot", value });
    } catch (error) {
      throw new Error(`Kiro rejected permission mode "${value}": ${(error as Error).message}`);
    }
  },
  updateFilter: kiroUpdateFilter,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KiroAgentDriver = createAcpDriver(SUPPORT);
