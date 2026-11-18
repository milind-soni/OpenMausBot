// A stand-in for Bitwarden's `bw` command line tool, answering as `bw` 2026.10 does for the calls the Vault makes
// (status, config server, login --apikey, unlock --passwordenv, sync, list items, get item, logout), with its own
// messages for the failures. No network: it holds one account and its items in memory. Every call is recorded, and
// whether any secret ever reached an argument is too.
import { randomUUID } from "node:crypto";

import type { BwResult, BwRun } from "../host/bitwarden-cli.ts";

export interface FakeBwItem {
  id: string; name: string; type: 1 | 2; notes?: string | null; collectionIds?: string[];
  fields?: Array<{ name: string; value: string; type: 0 | 1 | 2 }>;
  login?: { uris?: Array<{ uri: string }>; username?: string | null; password?: string | null; totp?: string | null };
}

export interface FakeBwAccount { clientId: string; clientSecret: string; password: string; email: string; items: FakeBwItem[] }

export function fakeBw(account: FakeBwAccount) {
  const state = { server: null as string | null, signedIn: null as string | null, sessions: new Set<string>(), unreachable: false, slow: false, limited: false };
  const calls: string[] = [];
  const secretsInArgs: string[] = [];
  const ok = (stdout: string): BwResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const fail = (stderr: string): BwResult => ({ code: 1, stdout: "", stderr, timedOut: false });
  const run: BwRun = async (args, env = {}) => {
    calls.push(`${args.join(" ")}${env.BW_SESSION ? " [session]" : ""}`);
    for (const secret of [account.clientSecret, account.password]) if (args.some((arg) => arg.includes(secret))) secretsInArgs.push(args.join(" "));
    if (state.slow) return { code: 1, stdout: "", stderr: "", timedOut: true };
    const [command] = args;
    if (command === "status") {
      const status = !state.signedIn ? "unauthenticated" : env.BW_SESSION && state.sessions.has(env.BW_SESSION) ? "unlocked" : "locked";
      return ok(JSON.stringify({ serverUrl: state.server, lastSync: null, userEmail: state.signedIn ? account.email : null, userId: state.signedIn ? "u1" : null, status }));
    }
    if (command === "config") {
      if (state.signedIn) return fail("Logout required before server config update.");
      state.server = args[2] ?? null;
      return ok("Saved setting `config`.");
    }
    if (command === "logout") {
      if (!state.signedIn) return fail("You are not logged in.");
      state.signedIn = null;
      state.sessions.clear();
      return ok("You have logged out.");
    }
    if (command === "login") {
      if (state.unreachable) return fail("request to https://identity.bitwarden.com/connect/token failed, reason: getaddrinfo ENOTFOUND identity.bitwarden.com");
      if (state.limited) return fail("Too many requests. Try again later.");
      if (env.BW_CLIENTID !== account.clientId || env.BW_CLIENTSECRET !== account.clientSecret) return fail("client_id or client_secret is incorrect. Try again.");
      state.signedIn = env.BW_CLIENTID;
      return ok("You are logged in!\n\nTo unlock your vault, use the `unlock` command.");
    }
    if (command === "unlock") {
      if (!state.signedIn) return fail("You are not logged in.");
      if (env.BW_PASSWORD !== account.password) return fail("Invalid master password.");
      const key = `fake-session-${randomUUID()}`;
      state.sessions.add(key);
      return ok(key);
    }
    if (!state.signedIn) return fail("You are not logged in.");
    if (!env.BW_SESSION || !state.sessions.has(env.BW_SESSION)) return fail("Vault is locked.");
    if (command === "sync") return state.unreachable ? fail("fetch failed: connect ECONNREFUSED 203.0.113.7:443") : ok("Syncing complete.");
    if (command === "list" && args[1] === "items") return ok(JSON.stringify(account.items.map((item) => ({ object: "item", ...item }))));
    if (command === "get" && args[1] === "item") {
      const item = account.items.find((one) => one.id === args[2]);
      return item ? ok(JSON.stringify({ object: "item", ...item })) : fail("Not found.");
    }
    return fail(`Invalid command: ${command}`);
  };
  return { run, state, calls, secretsInArgs, expire: () => state.sessions.clear() };
}
