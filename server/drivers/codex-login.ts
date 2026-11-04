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

/** codex-cli 0.160.1 says "Logged in using …", "Not logged in", or "Error checking login status: …" for an auth.json it cannot read.
 * From 0.166.0 an API-key login says "API key configured - sk-…" instead of "Logged in using an API key - sk-…". */
export function codexLoginStatus(cli: string, env: Env): Promise<"signed-in" | "signed-out" | "unknown"> {
  return new Promise((resolve) => execCli(cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) => {
    const said = `${stdout}\n${stderr ?? ""}`;
    resolve(!err && /^(?:logged in|api key configured)\b/im.test(said) ? "signed-in"
      : err && /^(?:not logged in|error checking login status)\b/im.test(said) ? "signed-out" : "unknown");
  }));
}

/** Without a login Codex still runs a turn and fails only after a minute of reconnects. Only Codex's own "not
 * logged in" counts, and a login it reads from elsewhere is remembered so later turns skip the check. */
export function codexLoginCheck(cli: string): (env: Env) => Promise<"missing" | "present"> {
  let confirmedWithout: string | null | undefined;
  return async (env) => {
    const stored = storedCodexLogin(env);
    if (readable(stored) || stored === confirmedWithout) return "present";
    const status = await codexLoginStatus(cli, env);
    if (status === "signed-in") confirmedWithout = stored;
    // Another Codex may be rewriting auth.json: a half-written file is not a missing login.
    return status === "signed-out" && !readable(storedCodexLogin(env)) ? "missing" : "present";
  };
}
