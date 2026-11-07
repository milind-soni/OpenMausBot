// Tencent CodeBuddy, both builds: `codebuddy-intl --acp` and `codebuddy-cn --acp`.
//
// Verified on 2026-11-06 against this host's installs: `initialize` answers
// protocolVersion 1 with promptCapabilities {image, embeddedContext},
// mcpCapabilities {http, sse}, loadSession, delegateToolsSupport, multitaskSupport,
// metaPromptSupport, and four authMethods (iOA / external / internal / selfhosted).
// The CLI keeps its own sign-in in ~/.codebuddy/auth.info, so nothing here stores a key.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** Model ids the CLI accepts on --model; the ACP config option can add more at session time. */
/**
 * The list `codebuddy --model` advertises in its own --help, unchanged and in its order (both editions report the
 * same set). `custom-local:trae` is deliberately absent: it needs a local endpoint the CLI's config does not carry,
 * and picking it exits before the first turn. A live ACP session replaces this list with what it advertises.
 */
const CODEBUDDY_MODEL_OPTIONS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4.1-flash-sg", label: "DeepSeek V4.1 Flash (SG)" },
  { id: "default-model", label: "Default" },
  { id: "fast-model", label: "Fast" },
  { id: "balanced-model", label: "Balanced" },
  { id: "primary-model", label: "Primary" },
  { id: "gpt-6-astra", label: "Astra (GPT-6)" },
  { id: "gpt-5.6-sol", label: "Sol (GPT-5.6)" },
  { id: "gpt-5.6-terra", label: "Terra (GPT-5.6)" },
  { id: "gpt-5.6-luna", label: "Luna (GPT-5.6)" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "grok-4.7", label: "Grok 4.7" },
  { id: "glm-5.3", label: "GLM 5.3" },
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "hy4-preview", label: "HY4 Preview" },
  { id: "hy3", label: "HY3" },
];

const CODEBUDDY_MODELS = {
  default: "deepseek-v4.1-flash",
  options: CODEBUDDY_MODEL_OPTIONS,
};

const CODEBUDDY_CN_MODELS = {
  default: "deepseek-v4.1-flash",
  options: CODEBUDDY_MODEL_OPTIONS,
};

/** auth.info is the CLI's own credential blob; a present file with a size is a login, and it never gets read here. */
function authInfoHeld(directory: string): boolean {
  const path = join(directory, "auth.info");
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** codebuddy-intl keeps ~/.codebuddy; codebuddy-cn keeps ~/.codebuddy-cn (both also honour CODEBUDDY_HOME). */
export function codebuddyIsAuthenticated(homeDir: string) {
  return (env: Record<string, string | undefined>): boolean => {
    const home = env.CODEBUDDY_HOME || join(userHome(env), homeDir);
    if (authInfoHeld(home)) return true;
    // A server-side install may keep the other build's login; a non-empty file in either place means signed in.
    return authInfoHeld(join(userHome(env), homeDir === ".codebuddy" ? ".codebuddy-cn" : ".codebuddy"));
  };
}

/** loginNote is shown only when the CLI is present and isAuthenticated says no. */
function loginNote(build: string): string {
  return `CodeBuddy ${build} is not signed in — run its own login in a terminal first, then return here.`;
}

const CODEBUDDY_INSTALL = {
  command: { darwin: "npm install -g @tencent-ai/codebuddy-cli", linux: "npm install -g @tencent-ai/codebuddy-cli", win32: "npm install -g @tencent-ai/codebuddy-cli" },
  npmPackage: "@tencent-ai/codebuddy-cli",
  docsUrl: "https://www.codebuddy.ai",
};

const intl: AcpSupport = {
  driverKind: "codebuddyAgent",
  displayName: "CodeBuddy",
  models: CODEBUDDY_MODELS,
  defaultCli: "codebuddy-intl",
  nativeSource: "codebuddy.acp",
  loginNote: loginNote("(international)"),
  install: CODEBUDDY_INSTALL,
  // --acp is the verified ACP stdio entry point; the model travels on argv, not as a session option.
  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["--model", turn.model] : [])],
  // Already signed in from the CLI; never launch an interactive login from here.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: codebuddyIsAuthenticated(".codebuddy"),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

const cn: AcpSupport = {
  ...intl,
  driverKind: "codebuddyCnAgent",
  displayName: "CodeBuddy CN",
  models: CODEBUDDY_CN_MODELS,
  defaultCli: "codebuddy-cn",
  nativeSource: "codebuddy-cn.acp",
  loginNote: loginNote("(China)"),
  isAuthenticated: codebuddyIsAuthenticated(".codebuddy-cn"),
};

export const CodeBuddyDriver = createAcpDriver(intl);
export const CodeBuddyCnDriver = createAcpDriver(cn);

/** Exposed for the engine-status probe: the intl build's version banner is what pins which CLI got picked. */
export const CODEBUDDY_CLI_VERSION = /codebuddy/i;

/** Reads nothing today; kept as the single place a future quota panel would attach to. */
export function codebuddyAuthPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CODEBUDDY_HOME || join(userHome(env), ".codebuddy"), "auth.info");
}

/** True when the auth blob is newer than `since`; used by setup helpers that wait for a login to land. */
export function codebuddyLoginLanded(since: number, env: Record<string, string | undefined> = process.env): boolean {
  try {
    return readFileSync(codebuddyAuthPath(env)).length > 0 && statSync(codebuddyAuthPath(env)).mtimeMs >= since;
  } catch {
    return false;
  }
}
