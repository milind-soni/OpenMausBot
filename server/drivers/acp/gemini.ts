// Gemini CLI (`gemini --acp`). Retired from the default fleet: since 2026-06-18 Google serves the
// Gemini CLI only to enterprise licences (consumer tiers route through Antigravity); opt in with
// {"instances": {"gemini": {"driver": "geminiAgent"}}} in config.json. Remaining auth: GEMINI_API_KEY,
// Vertex, or an enterprise Code Assist licence. Untested against a live CLI: the flag and auth ids
// follow the published Gemini CLI ACP contract.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { credentialEnvValue } from "../../credential-env.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const AUTH_PREFERENCE = ["gemini-api-key", "oauth-personal", "vertex-ai"];

/** oauth_creds.json counts only when it looks alive: unexpired, or a refresh token an enterprise licence may redeem. */
function liveOauthCredential(env: Record<string, string | undefined>): boolean {
  try {
    const creds = JSON.parse(readFileSync(join(userHome(env), ".gemini", "oauth_creds.json"), "utf8")) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
    };
    if (typeof creds.access_token !== "string" || creds.access_token.trim().length === 0) return false;
    const hasRefresh = typeof creds.refresh_token === "string" && creds.refresh_token.trim().length > 0;
    if (creds.expiry_date !== undefined) {
      if (typeof creds.expiry_date !== "number" || !Number.isFinite(creds.expiry_date)) return false;
      return Date.now() < creds.expiry_date || hasRefresh;
    }
    return true;
  } catch {
    return false;
  }
}

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

export function geminiIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return (
    nonBlank(credentialEnvValue(env, "GEMINI_API_KEY")) ||
    nonBlank(credentialEnvValue(env, "GOOGLE_API_KEY")) ||
    (existsSync(join(userHome(env), ".gemini", "oauth_creds.json")) && liveOauthCredential(env))
  );
}

/** `--approval-mode auto_edit` approves edits, `--yolo` everything; Gemini has no automatic reviewer, so Auto stays Ask. */
export function geminiApprovalArgs(fullAuto: boolean, approvalMode: string | undefined): string[] {
  if (fullAuto) return ["--yolo"];
  if (approvalMode === "edits") return ["--approval-mode", "auto_edit"];
  return [];
}

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini",
  models: {
    default: "gemini-2.5-pro",
    options: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  loginNote:
    "Gemini CLI needs a GEMINI_API_KEY, a Vertex AI setup, or an enterprise Code Assist login — consumer Google logins stopped working on 2026-06-18 (use the Antigravity engine for those accounts)",

  // --acp is stable; --experimental-acp still works but warns.
  spawnArgs: (config, turn) => ["--acp", ...geminiApprovalArgs(config.fullAuto, turn.approvalMode), ...(turn.model ? ["-m", turn.model] : [])],
  credentialEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],

  pickAuthMethod: (methods) => {
    const ids = methods.map((m) => m.id).filter((id): id is string => typeof id === "string");
    for (const pref of AUTH_PREFERENCE) if (ids.includes(pref)) return pref;
    return ids[0] ?? null;
  },
  authFailure: "continue",

  isAuthenticated: geminiIsAuthenticated,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GeminiAgentDriver = createAcpDriver(support);
