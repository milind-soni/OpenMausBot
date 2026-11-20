import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DATA_DIR } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";

/** Explicit box grants bypass audience filtering: never grant the shared sessions root. */
export function piSessionDir(turn: Pick<SendTurnInput, "threadId" | "botId">, instanceId: string): string {
  const audience = engineHomes.scope();
  if (engineHomes.active() && audience === null) throw new Error("Pi session requires an audience context");
  const key = createHash("sha256").update(JSON.stringify([instanceId, turn.botId ?? null, turn.threadId])).digest("hex");
  return join(DATA_DIR, "pi-sessions", audience ?? "local", key);
}

export function piTurnArgs(dir: string): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ["--mode", "rpc", "--session-dir", dir];
}

/** Never resume another audience's or conversation's session, even with a stale cursor. Such a cursor (an older one, or
 * one from a conversation moved to another computer) starts a new session rather than failing every turn of the
 * conversation. */
export function piSessionPath(turn: Pick<SendTurnInput, "resumeCursor" | "sessionReset">, dir: string): string | null {
  if (turn.sessionReset || typeof turn.resumeCursor !== "string") return null;
  if (dirname(resolve(turn.resumeCursor)) !== resolve(dir)) return null;
  return turn.resumeCursor;
}
