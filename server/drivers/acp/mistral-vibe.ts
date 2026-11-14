// Mistral Vibe over ACP (`vibe-acp`, github.com/mistralai/mistral-vibe). Verified against
// vibe-acp 3.1.1 on 2026-11-13:
//
//   - initialize answers protocolVersion 1, loadSession true, promptCapabilities.image true,
//     sessionCapabilities {list, fork, close} and exactly one auth method:
//     `browser-auth`, "Sign in through Mistral AI Studio".
//   - Unauthenticated, session/new fails with error -32000 "Missing API key for mistral
//     provider." and `authenticate` with methodId `browser-auth` stays pending until the
//     person finishes the sign-in; the process opens the OS browser (it honours $BROWSER)
//     at console.mistral.ai/codestral/cli/authenticate?... The saved login lives in the
//     account's own Vibe home ($VIBE_HOME, default ~/.vibe).
//   - A browser sign-in leaves a populated `$VIBE_HOME/whoami_cache.json`; `MISTRAL_API_KEY`
//     (Settings → Connections → Model providers, plan key) works with no sign-in.
//   - session/new exposes three config options: `mode` (MausBot's approval modes map there),
//     `model`, and `thinking` (off | high). `thinking` follows the chosen model's own default;
//     item-specific thought levels prove nothing here, so variants stay off.
//   - `vibe-acp --version` prints "vibe-acp 3.1.1".
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels } from "./custom-model-catalog.ts";
import { acpModelOption } from "./config-options.ts";
import { MISTRAL_VIBE_STANDALONE } from "./mistral-vibe-release.ts";

/** The stock chat-capable models mistral.ai lists for Vibe (only some ship per version; a signed-in
 * session's own list replaces these on Refresh). The `mistral-medium-3.5` id is the CLI's current default. */
export const MISTRAL_VIBE_MODELS: ModelCatalog = {
  default: "mistral-medium-3.5",
  options: [
    { id: "mistral-medium-3.5", label: "Mistral Medium 3.5" },
    { id: "mistral-medium", label: "Mistral Medium" },
    { id: "mistral-large", label: "Mistral Large" },
    { id: "codestral", label: "Codestral" },
    { id: "zai-glm-5-3", label: "Z.ai GLM 5.3" },
    { id: "zai-glm-5-3-flash", label: "Z.ai GLM 5.3 Flash" },
  ],
};

export function vibeHome(env: Record<string, string | undefined>): string {
  return env.VIBE_HOME || join(env.HOME || homedir(), ".vibe");
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** A populated `whoami_cache.json` is the sign-in marker (fresh installs do not have it); the
 * provider key rides in the child env either way. */
const MISTRAL_VIBE_KEYCHAIN_SERVICE = "ai.mistral.vibe";

/** The fresh-signed-in marker on macOS: the browser sign-in stores the token in the login keychain right away,
 * while `whoami_cache.json` only reappears after the CLI's next session validates it — so right after a sign-in
 * the keychain entry is the only reliable one. The service is overridable for tests. */
export function macKeychainSignIn(env: Record<string, string | undefined>): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["find-generic-password", "-s", env.VIBE_KEYCHAIN_SERVICE || MISTRAL_VIBE_KEYCHAIN_SERVICE],
      { stdio: "ignore", timeout: 2_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function vibeSignedIn(env: Record<string, string | undefined>, keychainProbe = macKeychainSignIn): boolean {
  if (nonEmpty(env.MISTRAL_API_KEY)) return true;
  const path = join(vibeHome(env), "whoami_cache.json");
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, { encoding: "utf8" });
      if (content.includes("customer_id") || content.includes("api_base")) return true;
    } catch {}
  }
  return keychainProbe(env);
}

/** session/new's `model` option: ids are the picker's wire values verbatim. */
function offeredModels(sessionConfig: unknown): { values: string[]; current?: string } {
  const option = acpModelOption(sessionConfig);
  return {
    values: (option?.options ?? []).map((model) => model.id),
    ...(option?.currentValue ? { current: option.currentValue } : {}),
  };
}

/** Sign-out removes what the engine's own browser sign-in wrote: the whoami cache everywhere, the
 * MISTRAL_API_KEY line of Vibe's fallback `$VIBE_HOME/.env` (its store when the OS keyring is
 * unavailable), and the macOS keychain entries it keeps the token in (current and legacy service names —
 * see vibe's utils/keyring.py). A keyring entry the CLI stored through its own backends on Linux or
 * Windows has no portable command-line delete, so the marker files here are what this app can honestly
 * clear there. A pasted plan key in Connections is not touched. */
/** One level of indirection over `security delete-generic-password` so tests keep a developer's real
 * login items out of the way while the filesystem cleanup stays real. */
export const keychain = {
  delete: (service: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      execFile("security", ["delete-generic-password", "-s", service], { timeout: 5_000, windowsHide: true }, (error) => {
        // "The specified item could not be found" is exit 44: already gone, which is the goal met.
        if (!error || (error as { code?: string | number }).code === 44) return resolve();
        reject(Object.assign(new Error(`The macOS keychain refused to remove the ${service} entry: ${error.message}`), { cause: error }));
      });
    }),
};

export async function removeMistralVibeSignIn(env: Record<string, string | undefined>): Promise<void> {
  const home = vibeHome(env);
  try { rmSync(join(home, "whoami_cache.json"), { force: true }); } catch {}
  const envFile = join(home, ".env");
  if (existsSync(envFile)) {
    // Vibe 3.1.2's fallback store writes the key bare or export-prefixed (vibe/setup/auth/api_key_persistence.py).
    const kept = readFileSync(envFile, { encoding: "utf8" }).split("\n").filter((line) => !/^(?:export )?MISTRAL_API_KEY=/u.test(line));
    writeFileSync(envFile, kept.join("\n"), { mode: 0o600 });
  }
  if (process.platform !== "darwin") return;
  const service = env.VIBE_KEYCHAIN_SERVICE || MISTRAL_VIBE_KEYCHAIN_SERVICE;
  await Promise.all([service, "vibe"].map((name) => keychain.delete(name)));
}


/** Discovers models in a temporary session, so a refresh leaves no record in the person's Vibe history. */export async function resolveMistralVibeModels(
  env: Record<string, string | undefined>,
  config: Pick<AcpConfig, "cli">,
): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli || "vibe-acp", [], {
    default: MISTRAL_VIBE_MODELS.default,
    variants: false,
    maxModels: 128,
    exitGraceMs: 2_000,
  });
}

export const mistralVibeSupport: AcpSupport = {
  driverKind: "mistralVibeAgent",
  displayName: "Mistral (Vibe)",
  models: MISTRAL_VIBE_MODELS,
  defaultCli: "vibe-acp",
  cliVersion: /^vibe-acp /u,
  nativeSource: "mistral-vibe.acp",
  images: true,
  loginNote:
    "Start a first chat: the browser sign-in to Mistral AI Studio opens (it completes behind it). Or paste a Mistral API key under Settings → Connections → Model providers.",
  install: {
    command: {
      darwin: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
      linux: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
      // uv first: Vibe ships no Windows installer, its README installs it through uv.
      win32: "powershell -ExecutionPolicy ByPass -c 'irm https://astral.sh/uv/install.ps1 | iex; uv tool install mistral-vibe'",
    },
    docsUrl: "https://github.com/mistralai/mistral-vibe/releases",
    // On every platform, Settings can install the pinned build from mistral-vibe's releases: no Node.js, no uv.
    standalone: MISTRAL_VIBE_STANDALONE,
  },
  spawnArgs: () => [],
  credentialEnv: ["MISTRAL_API_KEY"],
  // The app signs in through the engine's own authenticate step: the child opens the browser itself and
  // holds the request until the person finishes there (see header).
  browserSignIn: {
    product: "Mistral",
    methodId: (methods) => (methods.some((method) => method.id === "browser-auth") ? "browser-auth" : null),
    signedIn: (env) => vibeSignedIn(env),
    serverHint:
      "OpenMausBot cannot reach a browser on this server. Sign in from a machine that runs OpenMausBot, or paste a Mistral API key under Settings → Connections → Model providers.",
    failure(stage, detail) {
      switch (stage) {
        case "start": return detail === "ENOENT"
          ? "Mistral Vibe isn't installed where OpenMausBot runs. Install it on this card, then try again."
          : "Mistral Vibe did not start a sign-in in time. Update the CLI on this card, then try again.";
        case "initialize": return "Mistral Vibe did not answer its sign-in handshake in time. Update the CLI on this card, then try again.";
        case "authenticate": return "The Mistral sign-in did not finish. It may have been cancelled in the browser; start it again to retry.";
        case "processEnded": return "The Mistral sign-in ended before finishing. Update the CLI on this card, then try again.";
        case "expired": return "The Mistral sign-in window expired. Start it again to retry.";
      }
    },
    removeCredentials: removeMistralVibeSignIn,
  },
  // Model is a session config option (see header); ids pass through unchanged.
  selectModel: { configId: "model" },
  shareProcess: true,
  resolveModels: resolveMistralVibeModels,
  resolveModelsOnCreate: false,
  fallbackModel(sessionConfig, catalogDefault) {
    const { values, current } = offeredModels(sessionConfig);
    if (catalogDefault && values.includes(catalogDefault)) return catalogDefault;
    return current ?? null;
  },

  // initialize advertises exactly one method: a browser sign-in the process opens itself,
  // which the authenticate request blocks on until the person finishes (see header).
  pickAuthMethod: (methods) => (methods.some((method) => method.id === "browser-auth") ? "browser-auth" : null),
  authFailure: "continue",
  isAuthenticated: (env) => vibeSignedIn(env),

  // House convention for ACP harnesses: the persona rides in the prompt text.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const MistralVibeAgentDriver = createAcpDriver(mistralVibeSupport);
