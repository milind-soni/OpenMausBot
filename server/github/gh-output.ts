// Reading what GitHub CLI prints. Its text is for people and changes between releases, so every reader here takes what it
// can recognise and answers null otherwise; fixtures/ holds what real releases printed (gh-output.test.ts).
import { stripVTControlCharacters } from "node:util";

export const VERIFICATION_URL = "https://github.com/login/device";

/** gh's own wording around the code: `! First copy your one-time code: ABCD-1234`, or `! One-time code (ABCD-1234) copied
 * to clipboard` when it put it on the clipboard. GitHub's user codes are eight letters and digits with a dash. */
const CODE = /one-time code(?: \(|: )([A-Z0-9]{4}-[A-Z0-9]{4})\b/iu;
const URL_IN_LINE = /https:\/\/[^\s"'<>]+/gu;

export function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/gu, "\n");
}

/** `gh version 2.103.3 (2026-10-26)` → [2, 103, 3]. */
export function parseGhVersion(text: string): [number, number, number] | null {
  const match = /\bgh version (\d+)\.(\d+)\.(\d+)\b/u.exec(plain(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: readonly number[] | null, floor: readonly number[]): boolean {
  if (!version) return false;
  for (let i = 0; i < floor.length; i++) {
    const have = version[i] ?? 0, want = floor[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

/** The code and where to type it, once gh has printed both. Only GitHub's own device page counts: any other address in
 * the output is never shown to the person as the place to type a code. */
export function parseDeviceCode(output: string): { code: string; verificationUrl: string } | null {
  const text = plain(output);
  const code = CODE.exec(text)?.[1]?.toUpperCase();
  if (!code) return null;
  for (const raw of text.match(URL_IN_LINE) ?? []) {
    try {
      const url = new URL(raw.replace(/[.,;)]+$/u, ""));
      if (url.protocol === "https:" && url.host === "github.com" && url.pathname.replace(/\/$/u, "") === "/login/device") return { code, verificationUrl: VERIFICATION_URL };
    } catch {
      continue;
    }
  }
  return null;
}

/** Why a login that gh ended without signing in ended, in one plain line, never gh's whole output. */
export function loginFailure(output: string): { outcome: "expired" | "failed"; reason: string } {
  const text = plain(output);
  if (/expired_token|device[_ ]code[^\n]*expired|code has expired|token has expired/iu.test(text)) return { outcome: "expired", reason: "The code expired before it was entered on GitHub." };
  if (/access_denied|denied|cancel+ed the authori[sz]ation/iu.test(text)) return { outcome: "failed", reason: "The sign-in was turned down on GitHub." };
  if (/timed out|timeout|no such host|connection refused|network is unreachable|dial tcp|read tcp|EOF\b/iu.test(text)) return { outcome: "failed", reason: "GitHub could not be reached from this server. Check its network connection, then try again." };
  const line = text.split("\n").map((one) => one.trim()).filter((one) => one && !CODE.test(one) && !one.startsWith("Open this URL")).at(-1);
  return { outcome: "failed", reason: line ? `GitHub CLI stopped: ${line.slice(0, 200)}` : "GitHub CLI stopped before the sign-in finished." };
}

export interface GhAccount {
  /** success: the token works; invalid: GitHub said so (HTTP 401, an expired or rejected token); unknown: anything else,
   * such as no network. gh reports a network failure with the same `error` state as a refused token, so only GitHub's own
   * 401 counts as refused. */
  state: "success" | "invalid" | "unknown";
  login: string | null;
  scopes: string[];
  error?: string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const cleanLogin = (value: unknown) => (typeof value === "string" && LOGIN.test(value) ? value : null);

/** `X-OAuth-Scopes`-style `repo, read:org, gist`, or gh's quoted `'gist', 'read:org', 'repo'`. */
export function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((one) => one.trim().replace(/^'|'$/gu, "").trim()).filter((one) => /^[a-z:_]{1,40}$/u.test(one)))].sort();
}

/** `gh auth status --hostname github.com --json hosts` (gh 2.7x and later): the active github.com account. */
export function parseStatusJson(stdout: string): GhAccount | "signed-out" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain(stdout).trim());
  } catch {
    return null;
  }
  const hosts = (parsed as { hosts?: unknown })?.hosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return null;
  const entries = (hosts as Record<string, unknown>)["github.com"];
  if (entries === undefined) return "signed-out";
  if (!Array.isArray(entries)) return null;
  const entry = (entries.find((one) => (one as { active?: unknown })?.active === true) ?? entries[0]) as Record<string, unknown> | undefined;
  if (!entry) return "signed-out";
  const error = typeof entry.error === "string" ? entry.error.slice(0, 200) : undefined;
  const refused = (entry.state === "error" && error !== undefined && /\bHTTP 401\b|Bad credentials/u.test(error)) || entry.state === "expired" || entry.state === "refresh_expired";
  const state = entry.state === "success" ? "success" : refused ? "invalid" : "unknown";
  return { state, login: cleanLogin(entry.login), scopes: parseScopes(entry.scopes), ...(error ? { error } : {}) };
}

/** `gh auth status --hostname github.com` as text, for a gh without `--json` (before 2.7x). Older releases print it on
 * stdout with exit 0 even for a refused token, newer ones on stderr with exit 1, so both streams are read together. Its
 * "Failed to log in" reads the same for a refused token and for no network (fixtures/*-offline), so it is unknown. */
export function parseStatusText(output: string): GhAccount | "signed-out" | null {
  const text = plain(output);
  if (/not logged in(?:to any GitHub hosts| to any hosts)/iu.test(text)) return "signed-out";
  const ok = /Logged in to github\.com (?:account|as) (\S+)/u.exec(text);
  const refused = /(?:Token for github\.com account (\S+) [^\n]*has expired|Refresh token for github\.com account (\S+) was rejected)/u.exec(text);
  const unchecked = /(?:Failed|Timeout trying) to log in to github\.com (?:account|as) (\S+)/u.exec(text);
  const scopes = parseScopes(/Token scopes: ([^\n]*)/u.exec(text)?.[1]);
  if (ok) return { state: "success", login: cleanLogin(ok[1]), scopes };
  if (refused) return { state: "invalid", login: cleanLogin(refused[1] ?? refused[2]), scopes, error: "GitHub no longer accepts this sign-in." };
  if (unchecked) return { state: "unknown", login: cleanLogin(unchecked[1]), scopes };
  return null;
}

/** The account gh's own config file names for github.com (`user:` under the host), read without running gh. */
export function hostsFileLogin(text: string): string | null {
  const lines = plain(text).split("\n");
  let inHost = false;
  for (const line of lines) {
    if (/^\S/u.test(line)) inHost = /^github\.com:\s*$/u.test(line);
    else if (inHost) {
      const match = /^ {4}user:\s*(\S+)\s*$/u.exec(line) ?? /^\s+user:\s*(\S+)\s*$/u.exec(line);
      if (match) return cleanLogin(match[1]);
    }
  }
  return null;
}

/** The token gh's config file holds for github.com with `--insecure-storage` (`oauth_token:` under the host), or null. */
export function hostsFileToken(text: string): string | null {
  let inHost = false;
  for (const line of plain(text).split("\n")) {
    if (/^\S/u.test(line)) inHost = /^github\.com:\s*$/u.test(line);
    else if (inHost) {
      const match = /^ {4}oauth_token:\s*(\S+)\s*$/u.exec(line);
      if (match) return tokenFrom(match[1]!);
    }
  }
  return null;
}

/** What `gh auth token` printed, when it looks like a GitHub token and nothing else. */
export function tokenFrom(stdout: string): string | null {
  const token = stdout.trim();
  return /^[A-Za-z0-9_]{20,255}$/u.test(token) ? token : null;
}
