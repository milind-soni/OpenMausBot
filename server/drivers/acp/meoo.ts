// Meoo (秒悟), wrapped: the `meoo` CLI manages projects and deployments but has no ACP and no chat
// mode, so `meoo-acp.ts` sits in front of the platform's Agent Run HTTP API and this driver only
// describes that bridge to the shared runtime.
//
// One Agent Run per turn, read to its end and replayed as ACP chunks (see the bridge: the upstream
// sends whole-reply snapshots, so live streaming would duplicate text). The agent key lives in
// `~/.config/agenthub-meoo/meoo-auth.env`, the project id one directory over; neither is read here.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderSnapshot } from "../../contracts.ts";
import { augmentedPath, userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { versionFromProbe } from "./version-probe.ts";

/** `GET /projects/<id>/agent/capabilities` on 2026-11-07 for this account's project; `auto` is its own default. */
const MEOO_MODELS = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto" },
    { id: "max", label: "Max" },
    { id: "moonshot/kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
    { id: "moonshot/kimi-k3", label: "Kimi K3" },
    { id: "qwen3.8-max", label: "Qwen3.8-Max" },
    { id: "qwen3.8-flash", label: "Qwen3.8-Flash" },
    { id: "qwen3.7-max", label: "Qwen3.7-Max" },
    { id: "qwen3.7-plus", label: "Qwen3.7-Plus" },
    { id: "deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro-0813", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-0731", label: "DeepSeek V4 Flash" },
    { id: "MiniMax/MiniMax-M3.1-Flash", label: "MiniMax M3.1 Flash" },
    { id: "bigmodel/glm-5.3", label: "GLM-5.3" },
    { id: "bigmodel/glm-5.3-flash", label: "GLM-5.3-Flash" },
    { id: "glm-5.2", label: "GLM-5.2" },
    { id: "glm-5.2-fast-preview", label: "GLM-5.2-Fast" },
  ],
};

const LOGIN_NOTE =
  "Meoo is not signed in — put MEOO_AK in ~/.config/agenthub-meoo/meoo-auth.env (or run the Meoo CLI once), then try again.";

const BRIDGE_SCRIPT = fileURLToPath(new URL("../meoo-acp.ts", import.meta.url));

/**
 * Every home the Meoo files could live in: `HOME` is often the harness's own home while the key and
 * the CLI's `~/.meoo/credentials.json` sit in the account's real home. No key is ever read here.
 */
function accountHomes(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  if (env.OMB_MEOO_HOME) candidates.push(env.OMB_MEOO_HOME);
  if (env.HOME) candidates.push(env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: env.HOME is all there is.
  }
  candidates.push(homedir(), userHome(env));
  return [...new Set(candidates.filter((home) => home.length > 0))];
}

/** A `MEOO_AK=...` line is what authorises an Agent Run; the file itself is never logged or forwarded. */
function agentKeyHeld(home: string): boolean {
  try {
    return /^\s*MEOO_AK\s*=\s*\S+/m.test(readFileSync(join(home, ".config", "agenthub-meoo", "meoo-auth.env"), "utf-8"));
  } catch {
    return false;
  }
}

/** The home whose Meoo files hold an agent key, if any. */
export function meooSignedInHome(env: Record<string, string | undefined>): string | undefined {
  return accountHomes(env).find(agentKeyHeld);
}

/** The CLI's own sign-in (v0.5.8 writes `~/.meoo/credentials.json`); only the snapshot mentions it. */
export function meooCliSignedIn(home: string): boolean {
  return existsSync(join(home, ".meoo", "credentials.json"));
}

export function meooIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return meooSignedInHome(env) !== undefined;
}

/** The instance's CLI when it names a path, else the npm prefix the CLI installs into (`~/.npm-global/bin`). */
export function resolveMeooCli(env: Record<string, string | undefined>, cli: string): string {
  if (cli && (isAbsolute(cli) || cli.includes("/") || cli.includes("\\") || existsSync(cli))) return cli;
  if (env.OMB_MEOO_CLI) return env.OMB_MEOO_CLI;
  for (const home of accountHomes(env)) {
    const path = join(home, ".npm-global", "bin", "meoo");
    if (existsSync(path)) return path;
  }
  return cli || "meoo";
}

const support: AcpSupport = {
  driverKind: "meooAgent",
  displayName: "Meoo",
  models: MEOO_MODELS,
  defaultCli: "meoo",
  nativeSource: "meoo.acp",
  images: false,
  loginNote: LOGIN_NOTE,

  // node runs the bridge; the meoo binary stays the CLI the snapshot checks.
  resolveCommand: (env) => {
    const launchEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return Promise.resolve({ command: process.execPath, args: ["--experimental-strip-types", BRIDGE_SCRIPT], env: launchEnv });
  },
  // Every turn is a fresh Agent Run, so the model is argv, not a live session setting.
  spawnArgs: (_config, turn) => (turn.model ? ["--model", turn.model] : []),

  // The CLI has no ACP path through the app's PATH, so probe the resolved binary and report whether an
  // agent key is present instead of waiting for the first turn to fail.
  snapshot: (env, config) => new Promise<ProviderSnapshot>((settle) => {
    const cli = resolveMeooCli(env, config.cli);
    const home = meooSignedInHome(env);
    // os.homedir() follows HOME, which is often not the account's home, so the npm prefix is added by hand.
    const bins = accountHomes(env).map((candidate) => join(candidate, ".npm-global", "bin")).filter((dir) => existsSync(dir));
    const probeEnv = {
      ...env,
      PATH: [...bins, augmentedPath()].join(delimiter),
      ...(home ? { HOME: home } : {}),
    };
    execFile(cli, ["--version"], { timeout: 8_000, env: probeEnv }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        settle({
          state: "unavailable",
          reason: code === "ENOENT"
            ? `\`${config.cli}\` isn't installed, or isn't on this app's PATH. Install the Meoo CLI or use Set CLI, then check again.`
            : `\`${config.cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.`,
        });
        return;
      }
      const version = (versionFromProbe(stdout, stderr) ?? "").split(/\r?\n/, 1)[0]?.trim() || null;
      if (!home) {
        settle({ state: "unavailable", reason: LOGIN_NOTE, authenticationUnavailableReason: LOGIN_NOTE, version });
        return;
      }
      settle({ state: "available", version, authenticated: true });
    });
  }),

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: meooIsAuthenticated,

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/Meoo is not signed in|MEOO_AK|unauthori[sz]ed|401|403/i.test(message)) return "invalid_credentials";
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const MeooAgentDriver = createAcpDriver(support);
