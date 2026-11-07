// Huawei CodeArts Agent, wrapped: the official CLI has no ACP mode, so `codearts-acp.ts` sits in
// front of it as an ACP server and this driver only describes that bridge to the shared runtime.
//
// The adapter (`codearts_cli.py`) runs one headless task per invocation with its own CodeArts
// session database, keeps the login in CodeArts' own store, reports a single result envelope, and
// needs up to 900 s for real work — hence the 900 s default and the bridge's keep-alive heartbeats.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** `codearts models --pure` on 26.10.9. Replaced by the live catalog only if the CLI offers one. */
const CODEARTS_MODELS = {
  default: "huaweicloud-maas/kimi-k3.1-pro",
  options: [
    { id: "huaweicloud-maas/kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
    { id: "huaweicloud-maas/kimi-k3", label: "Kimi K3" },
    { id: "huaweicloud-maas/glm-5.3", label: "GLM 5.3" },
    { id: "huaweicloud-maas/glm-5.3-flash", label: "GLM 5.3 Flash" },
    { id: "huaweicloud-maas/GLM-5.2", label: "GLM 5.2" },
    { id: "huaweicloud-maas/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
    { id: "huaweicloud-maas/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash 1017" },
    { id: "huaweicloud-maas/openpangu-2.0-pro", label: "OpenPangu 2.0 Pro" },
    { id: "huaweicloud-maas/openpangu-2.0-flash", label: "OpenPangu 2.0 Flash" },
    { id: "huaweicloud-maas/speed", label: "智速模式" },
  ],
};

const LOGIN_NOTE =
  "CodeArts is not signed in — open a terminal, run the CodeArts CLI once and finish its sign-in, then try again.";

const BRIDGE_SCRIPT = fileURLToPath(new URL("../codearts-acp.ts", import.meta.url));

/** CodeArts writes its sign-in into `<home>/.codeartsdoer/cli-data/auth.json`; no token is read here. */
export function codeartsSignedIn(env: Record<string, string | undefined>): boolean {
  const homes = [env.OMB_CODEARTS_HOME, userHome(env)].filter((home): home is string => typeof home === "string" && home.length > 0);
  return homes.some((home) => existsSync(join(home, ".codeartsdoer", "cli-data", "auth.json")));
}

const support: AcpSupport = {
  driverKind: "codeartsAcpAgent",
  displayName: "CodeArts",
  models: CODEARTS_MODELS,
  defaultCli: "codearts",
  nativeSource: "codearts.acp",
  images: false,
  loginNote: LOGIN_NOTE,

  // node runs the bridge; the CodeArts binary stays the CLI the snapshot and the adapter check.
  resolveCommand: (env, config) => {
    const args = ["--experimental-strip-types", BRIDGE_SCRIPT];
    if (isAbsolute(config.cli)) args.push("--cli", config.cli);
    // A packaged Electron main process runs Node scripts only in this mode.
    const launchEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return Promise.resolve({ command: process.execPath, args, env: launchEnv });
  },
  // The adapter re-runs headless per task, so the model is argv, not a live session setting.
  spawnArgs: (config, turn) => [
    ...(turn.model ? ["--model", turn.model] : []),
    ...(config.fullAuto ? ["--auto"] : []),
  ],

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: codeartsSignedIn,

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/CODEARTS_AUTH_REQUIRED|CODEARTS_PROVIDER_UNAVAILABLE|not signed in|authentication (?:required|failed)/i.test(message)) {
      return "invalid_credentials";
    }
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const CodeArtsAgentDriver = createAcpDriver(support);
