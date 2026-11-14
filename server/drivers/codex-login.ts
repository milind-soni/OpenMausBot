// Codex keeps its own login in <CODEX_HOME>/auth.json unless config.toml moves it to the keyring
// (`cli_auth_credentials_store`, "file" by default in codex-cli 0.160.1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execCli } from "../procs.ts";
import { codexHome } from "./codex-identity.ts";

type Env = Record<string, string | undefined>;

export function storedCodexLogin(env: Env): string | null {
  const home = codexHome(env);
  if (!home) return null;
  try { return readFileSync(join(home, "auth.json"), "utf8"); } catch { return null; }
}

const readable = (stored: string | null): boolean => {
  if (stored === null) return false;
  try { JSON.parse(stored); return true; } catch { return false; }
};

/** codex-cli 0.160.1 says "Logged in using …", "Not logged in", or "Error checking login status: …" for an auth.json it
 * cannot read; 0.165.0 says "API key configured - …" for an API-key login. */
export function codexReportsLogin(said: string): boolean {
  return /^(?:logged in|api key configured)\b/im.test(said);
}

/** 0.160.1 says "Logged in using an API key - …", 0.165.0 "API key configured - …": a key, not a ChatGPT sign-in. */
const API_KEY_LOGIN = /^(?:api key configured|logged in using an api key)\b/im;

export type CodexLoginStatus = "signed-in" | "signed-out" | "unknown";

/** `apiKey` is true for an API-key login, which `codex logout` as a ChatGPT sign-out cannot confirm. */
export function readCodexLogin(cli: string, env: Env): Promise<{ status: CodexLoginStatus; apiKey: boolean }> {
  return new Promise((resolve) => execCli(cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) => {
    const said = `${stdout}\n${stderr ?? ""}`;
    const signedIn = !err && codexReportsLogin(said);
    resolve({
      status: signedIn ? "signed-in" : err && /^(?:not logged in|error checking login status)\b/im.test(said) ? "signed-out" : "unknown",
      apiKey: signedIn && API_KEY_LOGIN.test(said),
    });
  }));
}

export async function codexLoginStatus(cli: string, env: Env): Promise<CodexLoginStatus> {
  return (await readCodexLogin(cli, env)).status;
}

/** Without a login Codex still runs a turn and fails only after a minute of reconnects. Only Codex's own "not
 * logged in" counts, and a login it reads from elsewhere is remembered so later turns skip the check, until
 * `forget` is called because a turn found that login gone. */
export function codexLoginCheck(cli: string): { check: (env: Env) => Promise<"missing" | "present">; forget: () => void } {
  let confirmedWithout: string | null | undefined;
  let forgets = 0;
  return {
    check: async (env) => {
      const stored = storedCodexLogin(env);
      if (readable(stored) || stored === confirmedWithout) return "present";
      const forgetsBefore = forgets;
      const status = await codexLoginStatus(cli, env);
      if (status === "signed-in" && forgets === forgetsBefore) confirmedWithout = stored;
      // Another Codex may be rewriting auth.json: a half-written file is not a missing login.
      return status === "signed-out" && !readable(storedCodexLogin(env)) ? "missing" : "present";
    },
    forget: () => { forgets += 1; confirmedWithout = undefined; },
  };
}
