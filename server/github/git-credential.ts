// GitHub for an unboxed bot's git on This computer: no broker there, so each bot spawn gets a credential helper for
// github.com (git-env.ts unboxedGitEnv) that asks this server's loopback for the token with a secret minted for that
// spawn, which dies with the process. It is appended after the person's own helpers, so their own working credentials
// still win, and it is never written to any git config file. Only off Clouds and off a team (a Cloud's loopback is every
// bot's shell, and a boxed bot gets the broker's github grant instead). An unboxed bot runs as the person and can read
// what their own gh holds anyway; here it could ask the helper's address for the token too.
import { randomBytes, timingSafeEqual } from "node:crypto";

import { GIT_CREDENTIAL_HEADER, GIT_CREDENTIAL_PATH, unboxedGitEnv } from "./git-env.ts";
import { githubSignedIn, githubToken } from "./token.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

/** A secret lives this long at most; its process's exit ends it sooner. */
export const GIT_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;
const MAX_SECRETS = 2_000;

let served: { port: number; enabled(): boolean; now(): number } | null = null;
const secrets = new Map<string, number>();

/** Test seam: forget every secret and the route's settings. */
export function resetGitCredentials(): void {
  secrets.clear();
  served = null;
}

/** An unboxed bot spawn's env with the helper added, and what to call when it exits; null leaves the spawn as it is
 * (the route is not served here, it is a Cloud or a team, or there is no GitHub sign-in). */
export function unboxedGitCredential(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; release(): void } | null {
  if (!served || !served.enabled() || !githubSignedIn("owner")) return null;
  const at = served.now();
  for (const [secret, expires] of secrets) if (expires <= at) secrets.delete(secret);
  if (secrets.size >= MAX_SECRETS) secrets.delete(secrets.keys().next().value!);
  const secret = randomBytes(24).toString("base64url");
  secrets.set(secret, at + GIT_CREDENTIAL_TTL_MS);
  return { env: { ...env, ...unboxedGitEnv({ port: served.port, secret, existing: env.GIT_CONFIG_PARAMETERS }) }, release: () => { secrets.delete(secret); } };
}

const known = (presented: string, now: number): boolean => {
  const given = Buffer.from(presented);
  for (const [secret, expires] of secrets) {
    const held = Buffer.from(secret);
    if (expires > now && held.length === given.length && timingSafeEqual(held, given)) return true;
  }
  return false;
};

/** The route git's helper asks: the owner-trust loopback only (never a shared server's bot shells), with a live spawn's secret; the answer is git's credential lines. */
export function createGitCredentialRoutes(deps: { port: number; enabled(): boolean; now?(): number }): RouteHandler {
  const now = deps.now ?? Date.now;
  served = { port: deps.port, enabled: deps.enabled, now };
  return async ({ req, res, path, method, auth }) => {
    if (path !== GIT_CREDENTIAL_PATH) return PASS;
    res.setHeader("cache-control", "no-store");
    const presented = req.headers[GIT_CREDENTIAL_HEADER];
    if (method !== "GET" || auth.kind !== "loopback" || auth.trust === "service" || !deps.enabled() || typeof presented !== "string" || !known(presented, now())) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n");
      return;
    }
    const token = await githubToken("owner");
    if (!token) { res.writeHead(204).end(); return; }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`username=x-access-token\npassword=${token}\n`);
  };
}
