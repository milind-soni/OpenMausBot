import { execFile } from "node:child_process";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

const GH_TOKEN_TIMEOUT_MS = 5_000;
const GH_MAX_BUFFER = 1_000_000;
const GH_TOKEN_REMEMBER_MS = 5 * 60_000;
const GH_NO_TOKEN_REMEMBER_MS = 60_000;
const GH_CHILD_DROP = new Set(["PATH", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

/** GH_HOST picks the GitHub that Copilot CLI and gh sign in to; null for a value that is not a bare host name. */
export function githubHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase() || "github.com";
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? host : null;
}

/** github.com and GHE.com data residency serve the REST API at api.<host>; GitHub Enterprise Server at <host>/api/v3. */
export function copilotUserUrl(host = "github.com"): string {
  const api = host === "github.com" || host.endsWith(".ghe.com") ? `https://api.${host}` : `https://${host}/api/v3`;
  return `${api}/copilot_internal/user`;
}

/** `gh auth token` prints GH_TOKEN, GITHUB_TOKEN or their enterprise forms before its stored login (gh 2.102.0);
 * a token on the engine was already taken, so any left here is the server's and must not answer for the login. */
export function ghTokenEnv(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { PATH: path };
  for (const [name, value] of Object.entries(env)) if (!GH_CHILD_DROP.has(name.toUpperCase())) child[name] = value;
  return child;
}

const ghTokens = new Map<string, { until: number; value: Promise<string | null> }>();

/** One `gh auth token` per host and gh config answers every read for a while, so the limit clock and the sidebar
 * do not each spawn gh. */
export function readGhCliToken(env: NodeJS.ProcessEnv, host: string): Promise<string | null> {
  const key = [host, env.GH_CONFIG_DIR ?? "", env.XDG_CONFIG_HOME ?? "", env.APPDATA ?? "", env.HOME ?? env.USERPROFILE ?? ""].join("\u0000");
  const now = Date.now();
  for (const [stale, entry] of ghTokens) if (entry.until <= now) ghTokens.delete(stale);
  const cached = ghTokens.get(key);
  if (cached) return cached.value;
  const value = spawnGhAuthToken(env, host);
  const entry = { until: Number.POSITIVE_INFINITY, value };
  ghTokens.set(key, entry);
  void value.then((token) => {
    if (ghTokens.get(key) === entry) entry.until = Date.now() + (token ? GH_TOKEN_REMEMBER_MS : GH_NO_TOKEN_REMEMBER_MS);
  });
  return value;
}

function spawnGhAuthToken(env: NodeJS.ProcessEnv, host: string): Promise<string | null> {
  const withPath = ghTokenEnv(env, augmentedPath());
  const { command, args } = resolveCliSpawn("gh", ["auth", "token", "--hostname", host], withPath);
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { env: withPath, timeout: GH_TOKEN_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, windowsHide: true, shell: false, encoding: "utf8" },
        (error, stdout) => {
          resolve(error || !stdout ? null : stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** GitHub answers its primary and secondary rate limits with 403 and a message naming the limit. */
export function githubRateLimited(body: unknown): boolean {
  const message = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  return typeof message === "string" && /rate limit/i.test(message);
}
