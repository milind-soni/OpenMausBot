// Whether Grok's own login still works, beyond auth.json being there: an expired or revoked login keeps the file. Only
// `grok models` is asked, and auth.json is only stat'ed, never read.
import { statSync } from "node:fs";

import { execCli } from "../../procs.ts";

export type GrokLogin = "signed-in" | "signed-out" | "unknown";
interface Probe { stamp: string; at: number; login: Promise<GrokLogin>; settled?: GrokLogin }

/** grok 1.0.25 `grok models` prints "You are logged in with …", "You are using XAI_API_KEY.", "You are authenticated via
 * deployment key." or "You are not authenticated.", and exits 0 either way; its errors say "Not logged in. Run `grok login`.",
 * "Token expired. …" or "Your auth token is invalid or expired. …". */
export function readGrokModelsLogin(output: string): GrokLogin {
  if (/\bYou are (?:logged in|using XAI_API_KEY|authenticated via)\b/i.test(output)) return "signed-in";
  if (/\bYou are not authenticated\b|\bnot logged in\b|\btoken (?:is invalid or )?expired\b/i.test(output)) return "signed-out";
  return "unknown";
}

function askGrokModels(cli: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<GrokLogin> {
  return new Promise((resolve) => execCli(cli, ["models"], { timeout: timeoutMs, env }, (error, stdout, stderr) => {
    resolve((error as { killed?: boolean } | null)?.killed ? "unknown" : readGrokModelsLogin(`${stdout}\n${stderr ?? ""}`));
  }));
}

/** An access token past its time makes `grok models` say it is not authenticated and then refresh the token in that same
 * process, so only a second "not authenticated" counts as signed out. */
async function probeGrokLogin(cli: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<GrokLogin> {
  const first = await askGrokModels(cli, env, timeoutMs);
  return first === "signed-out" ? askGrokModels(cli, env, timeoutMs) : first;
}

/** False for a missing auth.json, or one `grok models` twice calls signed out; a probe that times out, fails or says
 * something else keeps the file's answer. A probe is reused while auth.json is unchanged and younger than `freshMs`; an
 * older one answers at once while a new probe runs, so only an engine's first status read, or one after sign-in or
 * sign-out, waits for `grok models`. */
export function grokLoginCheck(options: { timeoutMs?: number; freshMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const freshMs = options.freshMs ?? 5 * 60_000;
  const probes = new Map<string, Probe>();
  return async (cli: string, env: Record<string, string | undefined>, authFile: string): Promise<boolean> => {
    let stamp: string;
    try {
      const info = statSync(authFile);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      return false;
    }
    const key = JSON.stringify([cli, authFile]);
    const known = probes.get(key);
    const probe = () => {
      const next: Probe = { stamp, at: Date.now(), login: probeGrokLogin(cli, env, timeoutMs) };
      void next.login.then((login) => { next.settled = login; });
      probes.set(key, next);
      return next;
    };
    if (!known || known.stamp !== stamp) return (await probe().login) !== "signed-out";
    if (Date.now() - known.at >= freshMs && known.settled !== undefined) {
      probe();
      return known.settled !== "signed-out";
    }
    return (await known.login) !== "signed-out";
  };
}
