// MiniMax Code (`mcode`), wrapped: the CLI has no ACP mode (`mcode --acp` exits 0 at once), so
// `mcode-acp.ts` sits in front of it as an ACP server and this driver only describes that bridge.
//
// Each turn is one `mcode exec` run with its own MiniMax session, streamed back as line-delimited
// JSON events. The login lives in the account's own `~/.minimax/auth` store — never read here —
// and `mcode` installs itself under `~/.minimax-code`, which is often outside the app's PATH.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderSnapshot } from "../../contracts.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { versionFromProbe } from "./version-probe.ts";

/** `mcode --model` takes `<provider>/<model>`; these two are what the installed CLI offers. */
const MCODE_MODELS = {
  default: "minimax/MiniMax-M3.1-Flash",
  options: [
    { id: "minimax/MiniMax-M3.1-Flash", label: "MiniMax M3.1 Flash" },
    { id: "minimax/MiniMax-M3", label: "MiniMax M3" },
  ],
};

const LOGIN_NOTE =
  "MiniMax Code is not signed in — open a terminal, run `mcode login` and finish its sign-in, then try again.";

const BRIDGE_SCRIPT = fileURLToPath(new URL("../mcode-acp.ts", import.meta.url));

/**
 * Every home the login could live in: the harness's own `HOME` is usually not the account's, and
 * `mcode` keeps its credential store under the account's real home. No token is ever read.
 */
function accountHomes(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  if (env.OMB_MCODE_HOME) candidates.push(env.OMB_MCODE_HOME);
  if (env.HOME) candidates.push(env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: env.HOME is all there is.
  }
  candidates.push(homedir(), userHome(env));
  return [...new Set(candidates.filter((home) => home.length > 0))];
}

/** The `mcode-public` auth store is per region; a present credential file means signed in. */
function authHeld(home: string): boolean {
  return ["cn", "global"].some((region) =>
    existsSync(join(home, ".minimax", "auth", "prod", region, "mcode-public", "auth.json")));
}

export function mcodeSignedInHome(env: Record<string, string | undefined>): string | undefined {
  return accountHomes(env).find(authHeld);
}

export function mcodeIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return mcodeSignedInHome(env) !== undefined;
}

/** The instance's CLI when it names a path, else the install location `mcode`'s own updater uses. */
export function resolveMcodeCli(env: Record<string, string | undefined>, cli: string): string {
  if (cli && (isAbsolute(cli) || cli.includes("/") || cli.includes("\\") || existsSync(cli))) return cli;
  if (env.OMB_MCODE_CLI) return env.OMB_MCODE_CLI;
  for (const home of accountHomes(env)) {
    const path = join(home, ".minimax-code", "bin", "mcode");
    if (existsSync(path)) return path;
  }
  return cli || "mcode";
}

const support: AcpSupport = {
  driverKind: "mcodeAgent",
  displayName: "MiniMax Code",
  models: MCODE_MODELS,
  defaultCli: "mcode",
  nativeSource: "mcode.acp",
  images: false,
  loginNote: LOGIN_NOTE,

  // node runs the bridge; the mcode binary stays the CLI the snapshot checks.
  resolveCommand: (env, config) => {
    const args = ["--experimental-strip-types", BRIDGE_SCRIPT, "--cli", resolveMcodeCli(env, config.cli)];
    // A packaged Electron main process runs Node scripts only in this mode.
    const launchEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return Promise.resolve({ command: process.execPath, args, env: launchEnv });
  },
  // Each turn re-runs `mcode exec`, so the model is argv, not a live session setting.
  spawnArgs: (config, turn) => [
    ...(turn.model ? ["--model", turn.model] : []),
    ...(config.fullAuto ? ["--auto"] : []),
  ],

  // `mcode` has no ACP `--version` path through the app's PATH; probe the resolved binary instead.
  snapshot: (env, config) => new Promise<ProviderSnapshot>((settle) => {
    const cli = resolveMcodeCli(env, config.cli);
    const home = mcodeSignedInHome(env);
    execFile(cli, ["--version"], { timeout: 8_000, env: home ? { ...env, HOME: home } : env }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        settle({
          state: "unavailable",
          reason: code === "ENOENT"
            ? `\`${config.cli}\` isn't installed, or isn't on this app's PATH. Install MiniMax Code or use Set CLI, then check again.`
            : `\`${config.cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.`,
        });
        return;
      }
      const version = (versionFromProbe(stdout, stderr) ?? "").split(/\r?\n/, 1)[0]?.trim() || null;
      settle({ state: "available", version, authenticated: Boolean(home) });
    });
  }),

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: mcodeIsAuthenticated,

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/not signed in|sign in to minimax|mcode login|unauthori[sz]ed/i.test(message)) return "invalid_credentials";
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const McodeAgentDriver = createAcpDriver(support);
