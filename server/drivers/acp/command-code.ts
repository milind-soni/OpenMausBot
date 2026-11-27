// Command Code over ACP (`command-code acp`), billed to the Command Code account `cmd login` stored.
// Checked against command-code 1.88.4 (npm `command-code`, which installs the same program as `cmd`, `cmdc`,
// `commandcode` and `command-code`; the app runs `command-code` because `cmd` is the Windows shell). Its ACP
// initialize offers one auth method, `command-code-cli`, which only points at `cmd login`; session/new refuses a
// missing login with -32000 "Not authenticated. Run `cmd login` in a terminal first.". A session advertises its
// whole catalog as the `model` config option (95 models in 1.88.4, opening on the person's own default) and each model's
// effort as `effort`; session/set_config_option confirms both. Its modes are default (asks), auto-accept, plan,
// dont-ask and bypass. A session's model lives in `~/.commandcode/projects/<cwd slug>/<session id>.meta.json`;
// picking one there never changes the default the next session opens on.
import { readFileSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AccountErrorCode, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";

/** Leaves the session on the model the person picked in Command Code itself. */
const AGENT_DEFAULT = { id: "agent-default", label: "Command Code default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp"];
const SIGN_IN = "cmd login";
const API_KEY_ENV = "COMMAND_CODE_API_KEY";
const LOGIN_NOTE = `Command Code is not signed in. Run ${SIGN_IN} in a terminal, or set ${API_KEY_ENV}, then check again.`;
// Set every turn: a person's own default mode must never skip the app's approvals.
const MODE_ASK = "default";
const MODE_FULL = "bypass";
/** `COMMANDCODE_API_ENV` picks the account file the CLI reads (1.88.4: getCommandAuthFileName). */
const AUTH_FILES: Record<string, string> = { prod: "auth.json", staging: "auth.staging.json", local: "auth.local.json" };

/** The account file `cmd login` writes: `<home>/.commandcode/auth.json`, holding `{apiKey, userName}`. */
export function commandCodeAuthFile(env: Record<string, string | undefined>): string {
  return join(userHome(env), ".commandcode", AUTH_FILES[env.COMMANDCODE_API_ENV ?? ""] ?? AUTH_FILES.prod);
}

/** The CLI takes `COMMAND_CODE_API_KEY` before the stored login, as either one signs it in. */
export function commandCodeSignedIn(env: Record<string, string | undefined>): boolean {
  if (env[API_KEY_ENV]?.trim()) return true;
  try {
    const stored = JSON.parse(readFileSync(commandCodeAuthFile(env), "utf8")) as { apiKey?: unknown } | null;
    return typeof stored?.apiKey === "string" && stored.apiKey.trim() !== "";
  } catch {
    return false;
  }
}

/** Discovery switches its session through every model, which Command Code records under the discovery's own
 * temporary folder's project; only that session's files, and then its emptied project folder, are removed. */
export async function forgetCommandCodeDiscoverySession({ sessionId, env }: { sessionId: string; env: Record<string, string | undefined> }): Promise<void> {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return;
  const projects = join(userHome(env), ".commandcode", "projects");
  const folders = await readdir(projects).catch(() => [] as string[]);
  for (const folder of folders.filter((name) => name.includes("omb-acp-models-"))) {
    const files = await readdir(join(projects, folder)).catch(() => [] as string[]);
    const ours = files.filter((name) => name.startsWith(`${sessionId}.`));
    if (!ours.length) continue;
    await Promise.all(ours.map((name) => rm(join(projects, folder, name), { force: true })));
    await rmdir(join(projects, folder)).catch(() => {});
  }
}

const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, exitGraceMs: 1_000, forgetSession: forgetCommandCodeDiscoverySession };

export function resolveCommandCodeModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
}

/** ACP's -32000 is `auth_required`; only the login refusal's own words make it one. */
export function classifyCommandCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error !== null && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const text = typeof value?.message === "string" ? value.message.toLowerCase() : "";
  return value?.code === -32000 && /\bnot authenticated\b|\bcmd login\b/.test(text) ? "invalid_credentials" : undefined;
}

export function describeCommandCodeAccountError(code: AccountErrorCode): string {
  return code === "invalid_credentials" ? LOGIN_NOTE
    : "Command Code refused this request for the signed-in account. Check its plan and credits on commandcode.ai, then try again.";
}

const SUPPORT: AcpSupport = {
  driverKind: "commandCodeAgent",
  displayName: "Command Code",
  models: MODELS,
  defaultCli: "command-code",
  nativeSource: "command-code.acp",
  images: true,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "npm install -g command-code", linux: "npm install -g command-code", win32: "npm install -g command-code" },
    needsNode: true,
    docsUrl: "https://commandcode.ai/docs/acp",
    signInCommand: SIGN_IN,
  },
  spawnArgs: () => SPAWN_ARGS,
  credentialEnv: [API_KEY_ENV],
  resolveModels: (env, config) => resolveCommandCodeModels(env, config),
  // Every fleet has this instance: the catalog comes from the startup cache and refreshes when the engine is picked.
  resolveModelsOnCreate: false,
  // command-code 1.89 acknowledges session/load in a live process but keeps the MCP connections it opened first,
  // so a rotated app bearer is answered "unauthorized" on every agents tool until the process is replaced.
  restartOnMcpChange: true,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  // The OS keeps no login the CLI could be walked through over ACP; `cmd login` opens a browser.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => commandCodeSignedIn(env),
  classifyError: classifyCommandCodeError,
  describeAccountError: describeCommandCodeAccountError,
  accountErrorText: (code) => code === "invalid_credentials" ? undefined : { key: "chat.notice.commandCodeAccountRefused" },
  async configureSession({ request, sessionId, config }) {
    const modeId = config.fullAuto ? MODE_FULL : MODE_ASK;
    try {
      await request("session/set_mode", { sessionId, modeId });
    } catch (error) {
      throw new Error(`Command Code rejected permission mode "${modeId}": ${(error as Error).message}`);
    }
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const CommandCodeAgentDriver = createAcpDriver(SUPPORT);
