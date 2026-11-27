// Devin CLI over ACP (`devin acp`), billed to the Devin account `devin auth login` signed in, or to WINDSURF_API_KEY.
// Checked against devin 3000.12.57 and 3000.12.59:
//   - initialize offers authMethods [devin-browser] and image input; the CLI reads WINDSURF_API_KEY, then the
//     credentials `devin auth login` stored;
//   - session/new advertises the account's models as the `model` config option and its permission modes as `mode`
//     (accept-edits, smart, ask, plan, bypass); session/set_config_option sets both and answers with the full
//     configOptions;
//   - a mode the session does not list (the CLI's own `auto`) is acknowledged but leaves the mode unchanged, and
//     neither `--permission-mode` nor DEVIN_PERMISSION_MODE reaches an ACP session, so accept-edits is the strictest
//     mode that can still edit.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AccountErrorCode, type AcpConfig, type AcpSupport } from "./core.ts";
import type { AcpPromptSteer } from "./steer.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";

/** Leaves the session on the model the person set in Devin itself. */
const AGENT_DEFAULT = { id: "agent-default", label: "Devin default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp"];
const SIGN_IN = "devin auth login";
const API_KEY_ENV = "WINDSURF_API_KEY";
/** What initialize advertises on 3000.12.x; 3000.15+ keeps the method but refuses session/new until authenticate carries the key. */
const AUTH_METHOD = "devin-browser";
const LOGIN_NOTE = `Devin is not signed in. Run ${SIGN_IN} in a terminal, or set ${API_KEY_ENV}, then check again.`;
export const DEVIN_MODE = { ask: "accept-edits", full: "bypass" } as const;

/** Where `devin auth login` may have stored the sign-in. On Windows, `%APPDATA%\devin`. Elsewhere two folders are
 * accepted: the XDG data folder Devin's documentation names (docs.devin.ai/cli/enterprise/devin-auth), `$XDG_DATA_HOME/devin`
 * or `~/.local/share/devin`; and the XDG config folder, `$XDG_CONFIG_HOME/devin` or `~/.config/devin`, which this driver
 * read when it was checked against devin 3000.12.57 and 3000.12.59. */
export function devinCredentialsFiles(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string[] {
  const home = userHome(env);
  const dirs = platform === "win32"
    ? [env.APPDATA?.trim() || join(home, "AppData", "Roaming")]
    : [env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), env.XDG_CONFIG_HOME?.trim() || join(home, ".config")];
  return dirs.map((dir) => join(dir, "devin", "credentials.toml"));
}

/** Signed in by WINDSURF_API_KEY, or by the `credentials.toml` that `devin auth login` writes. */
export function devinSignedIn(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  return Boolean(env[API_KEY_ENV]?.trim()) || devinCredentialsFiles(env, platform).some((file) => existsSync(file));
}

function devinAuthMethod(methods: Array<{ id?: string }>, env: Record<string, string | undefined>): string | null {
  if (!env[API_KEY_ENV]?.trim()) return null;
  const offered = methods.find((method) => method.id === AUTH_METHOD || String(method.id ?? "").startsWith("devin-"));
  return offered?.id ?? null;
}

/** The key goes to the CLI's authenticate request, never to argv, logs or events. */
function devinAuthMeta(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const key = env[API_KEY_ENV]?.trim();
  return key ? { api_key: key } : undefined;
}

/** No exit grace: devin 3000.12.57 exits on EOF but orphans the MCP servers it started from its own config, which then
 * hold the discovery folder for seconds where the tree kill would have stopped them. A Devin Pro account advertises
 * 145 models, past discovery's default cap of 128; above 128 the per-model variant switches are skipped, as for OMP. */
const DISCOVERY: AcpDiscoveryOptions = {
  passthrough: AGENT_DEFAULT, variantLimit: 128, maxModels: 4096,
  authMethod: devinAuthMethod, authMeta: devinAuthMeta,
};

export function resolveDevinModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
}

/** devin 3000.12.59 refuses a signed-out prompt with -32000 "Please log in to use Devin. Use `/login` to authenticate again." */
export function classifyDevinError(error: unknown): ProviderErrorCode | undefined {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === -32000 && typeof message === "string" && /\blog in to use devin\b/i.test(message) ? "invalid_credentials" : undefined;
}

/** devin 3000.12.57 offers, beside allow once and reject, `allow_session` and three more `allow_always` grants: always in
 * this project, always in every project, and switching the session to bypass mode. Only grants that end with the session
 * are kept. Its request names the command only in `_meta["cognition.ai/editableCommand"]`, without a title or kind. */
export function devinPermissionRequest(params: Record<string, any>): Record<string, any> {
  const options = Array.isArray(params.options) ? params.options : [];
  const kept = options.filter((option: { optionId?: unknown; kind?: unknown }) =>
    option.kind === "allow_once" || String(option.kind ?? "").startsWith("reject") || option.optionId === "allow_session");
  const toolCall = params.toolCall ?? {};
  const command = toolCall._meta?.["cognition.ai/editableCommand"];
  const described = typeof command === "string" && command && toolCall.rawInput?.command === undefined
    ? { ...toolCall, kind: toolCall.kind ?? "execute", title: toolCall.title ?? command, rawInput: { ...toolCall.rawInput, command } }
    : toolCall;
  return { ...params, options: kept, toolCall: described };
}

export function describeDevinAccountError(code: AccountErrorCode): string {
  return code === "invalid_credentials" ? LOGIN_NOTE
    : "Devin refused this request for the signed-in account. Check its Devin plan and credits, then try again.";
}

/** devin 3000.12.57 reports `agentInfo.version` "0.0.0-dev", so only `agentCapabilities._meta["cognition.ai/midTurnPrompts"]`
 * tells that a second session/prompt joins the running turn. Both prompts then end with `end_turn`, the same usage and the same
 * `_meta["cognition.ai/userMessageId"]`. */
export const DEVIN_STEER: AcpPromptSteer = {
  kind: "prompt",
  capability: "cognition.ai/midTurnPrompts",
  run: (response) => {
    const run = (response as { _meta?: Record<string, unknown> } | null)?._meta?.["cognition.ai/userMessageId"];
    return typeof run === "string" ? run : undefined;
  },
};

const SUPPORT: AcpSupport = {
  driverKind: "devinAgent",
  displayName: "Devin",
  models: MODELS,
  defaultCli: "devin",
  nativeSource: "devin.acp",
  images: true,
  loginNote: LOGIN_NOTE,
  install: {
    command: {
      darwin: "curl -fsSL https://cli.devin.ai/install.sh | bash",
      linux: "curl -fsSL https://cli.devin.ai/install.sh | bash",
      win32: "irm https://static.devin.ai/cli/setup.ps1 | iex",
    },
    docsUrl: "https://docs.devin.ai/cli",
    signInCommand: SIGN_IN,
  },
  spawnArgs: () => SPAWN_ARGS,
  credentialEnv: [API_KEY_ENV],
  resolveModels: (env, config) => resolveDevinModels(env, config),
  // Every fleet has this instance: the catalog comes from the startup cache and refreshes when the engine is picked.
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  pickAuthMethod: devinAuthMethod,
  authMeta: devinAuthMeta,
  authFailure: "continue",
  isAuthenticated: (env) => devinSignedIn(env),
  classifyError: classifyDevinError,
  describeAccountError: describeDevinAccountError,
  accountErrorText: (code) => code === "invalid_credentials" ? undefined : { key: "chat.notice.devinAccountRefused" },
  permissionRequest: devinPermissionRequest,
  sessionScopedApproval: true,
  steer: DEVIN_STEER,
  async configureSession({ request, sessionId, config }) {
    const value = config.fullAuto ? DEVIN_MODE.full : DEVIN_MODE.ask;
    let confirmed: unknown;
    try {
      const answer = await request("session/set_config_option", { sessionId, configId: "mode", value });
      confirmed = answer?.configOptions?.find((option: { id?: unknown }) => option.id === "mode")?.currentValue;
    } catch (error) {
      throw new Error(`Devin rejected permission mode "${value}": ${(error as Error).message}`);
    }
    if (confirmed !== value) throw new Error(`Devin did not switch to permission mode "${value}".`);
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DevinAgentDriver = createAcpDriver(SUPPORT);
