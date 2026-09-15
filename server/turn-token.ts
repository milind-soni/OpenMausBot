// Per-turn tokens delivered through files, not environments.
//
// Every integration the harness mounts into an engine (peer tools, browser,
// connectors, hooks) gets a bearer minted for the exact turn generation and
// revoked at settle. That is the right security boundary — and it is why
// the Claude driver relaunched its CLI on every turn: the token sat in the
// MCP server's environment, the environment is part of the spawn contract,
// and a fresh token made a healthy idle process look changed. A proxy that
// lives across turns would also keep presenting its first, revoked token.
//
// The fix is one small indirection: the harness writes the token to a file
// whose path is STABLE per (kind, bot, thread) and 0600, the proxy's
// environment names the file, and the proxy reads it on every request. The
// spawn contract sees the path (unchanged turn to turn); the request sees
// the current token. The hook helper already worked this way; this makes it
// the one way for everything.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export const TURN_TOKENS_DIR = join(DATA_DIR, "turn-tokens");

/** Stable, private path for this integration's token on this thread. */
export function turnTokenPath(kind: string, botId: string, threadId: string): string {
  const digest = createHash("sha256").update(`${kind}\0${botId}\0${threadId}`).digest("hex").slice(0, 24);
  return join(TURN_TOKENS_DIR, `${kind}-${digest}.token`);
}

/** Write (or rewrite) the token and return the path to put in the env. */
export function writeTurnToken(kind: string, botId: string, threadId: string, token: string): string {
  const path = turnTokenPath(kind, botId, threadId);
  mkdirSync(TURN_TOKENS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return path;
}

export { readTurnToken } from "./turn-token-read.ts";
