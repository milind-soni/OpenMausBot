import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCli } from "../procs.ts";
import { augmentedPath } from "../env-path.ts";

/** Read-only account usage lookups. They never start a turn or spend allowance. */

const TIMEOUT_MS = 10_000;

function keychainSecret(service: string, account?: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  return new Promise(resolve => execFile("security", args, { timeout: TIMEOUT_MS }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null)));
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Usage read failed (${res.status})`);
  return res.json();
}

/** Claude Code stores its sign-in in the macOS keychain, or ~/.claude/.credentials.json elsewhere. */
async function claudeAccessToken(): Promise<string | null> {
  let raw = await keychainSecret("Claude Code-credentials");
  if (!raw) {
    try { raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"); } catch { return null; }
  }
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string") return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch { return null; }
}

export async function readClaudeAccountUsage(): Promise<unknown> {
  const token = await claudeAccessToken();
  if (!token) throw new Error("Claude is not signed in");
  return getJson("https://api.anthropic.com/api/oauth/usage", {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
}

/** agy keeps a go-keyring entry (service "gemini", account "antigravity") holding an OAuth token. */
async function antigravityAccessToken(): Promise<string | null> {
  const raw = await keychainSecret("gemini", "antigravity");
  if (!raw) return null;
  try {
    const body = raw.startsWith("go-keyring-base64:") ? Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8") : raw;
    const entry = JSON.parse(body);
    const token = typeof entry.token === "string" ? JSON.parse(entry.token) : entry.token;
    if (typeof token?.access_token !== "string") return null;
    if (typeof token.expiry === "string" && Date.parse(token.expiry) <= Date.now() + 60_000) return null;
    return token.access_token;
  } catch { return null; }
}

export async function readAntigravityQuota(cli: string): Promise<unknown> {
  let token = await antigravityAccessToken();
  if (!token) {
    // `agy models` refreshes the stored sign-in as a side effect; it starts no conversation.
    await new Promise<void>(resolve => execCli(cli, ["models"], { timeout: 30_000, env: { ...process.env, PATH: augmentedPath() } }, () => resolve()));
    token = await antigravityAccessToken();
  }
  if (!token) throw new Error("Antigravity is not signed in");
  let project = "";
  try { project = readFileSync(join(homedir(), ".gemini", "antigravity-cli", "cache", "default_project_id.txt"), "utf8").trim(); } catch {}
  return getJson("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "antigravity" },
    body: JSON.stringify(project ? { project } : {}),
  });
}
