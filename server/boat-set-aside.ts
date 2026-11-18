// A bot's cloud computer that stopped answering is never deleted by itself: it is set aside. It is stopped (the provider
// keeps its disk), renamed so it is no longer the bot's, and a new computer is made for the bot. The old one is kept for
// DEAD_COMPUTER.setAsideKeepMs, listed in Settings → Desktops & browser → Desktops, and only then deleted
// (deleteExpiredSetAside). If the new computer cannot be made (the plan has no room for one more, say), the old one gets
// its name back and stays the bot's: nothing is lost either way.
//
// The Admin counts a stopped computer against the plan's computers at once until it is deleted, so on a plan that
// includes one computer the new one is refused (`at_once`) and the old one is put back.
import * as boat from "./boat.ts";
import { forgetSetAsideBoatCreate } from "./boat-create-idempotency.ts";
import { cloudFailureOf } from "./boat-limit.ts";
import type { AppConfig } from "./config.ts";

/** `-set-aside-YYYY-MM-DD` after the bot's own computer name (boat.SET_ASIDE_BOAT_NAME): only characters every computer
 * name already has, and a name Settings lists as this installation's, owned by no bot. */
export async function setAsideBoatName(owner: string, at: number): Promise<string> {
  return `${await boat.boatNameFor(owner)}-set-aside-${new Date(at).toISOString().slice(0, 10)}`;
}

/** `set-aside`: the old computer is stopped and renamed, and the bot has `newBoxId`. `stop-refused`: nothing was changed.
 * `rename-failed`: the old computer was stopped but keeps its name, so it is still the bot's and wakes on its next use.
 * `no-room`: the plan has no room for a new computer; `create-failed`: the new one could not be made. In both, the old one
 * got its name back (`restored`), or, when even that failed, it is still set aside and the bot has no computer. */
export type SetAsideOutcome =
  | { kind: "set-aside"; newBoxId: string; name: string }
  | { kind: "stop-refused" | "rename-failed" }
  | { kind: "no-room" | "create-failed"; restored: boolean; reason: string };

export interface SetAsideDeps {
  log(line: string): void;
  /** Makes the bot's new computer; boat.provisionBoat unless a test plays it. */
  provision?(cfg: AppConfig, owner: string): Promise<{ boxId: string }>;
}

/** How long a stop is waited for before the rename: the provider may refuse a change to a computer still archiving. */
const STOP_WAIT_MS = 60_000;
const POLL_MS = 2_500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rename = async (cfg: AppConfig, boxId: string, name: string): Promise<boolean> => {
  try {
    const renamed = await boat.boatFetch(cfg, `/sandboxes/${boxId}`, { method: "PATCH", body: JSON.stringify({ name }), signal: AbortSignal.timeout(30_000) });
    await renamed.body?.cancel().catch(() => undefined);
    return renamed.ok;
  } catch {
    return false;
  }
};

/** Stop, rename, then make the new computer. Never sends a DELETE for `target`. */
export async function setAsideBoat(cfg: AppConfig, owner: string, target: { boxId: string; name: string }, setAsideName: string, deps: SetAsideDeps): Promise<SetAsideOutcome> {
  const provision = deps.provision ?? (async (config: AppConfig, bot: string) => ({ boxId: String((await boat.provisionBoat(config, bot, "")).boxId) }));
  try {
    const stopped = await boat.boatFetch(cfg, `/sandboxes/${target.boxId}/stop`, { method: "POST", signal: AbortSignal.timeout(30_000) });
    await stopped.body?.cancel().catch(() => undefined);
    // 409: already stopping or stopped.
    if (!stopped.ok && stopped.status !== 409) return { kind: "stop-refused" };
  } catch {
    return { kind: "stop-refused" };
  }
  // The create receipt goes first: were it kept, the next create would find this computer again and name it back. A
  // computer that keeps its name needs no receipt to be found.
  for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline;) {
    const seen = await boat.inspectBoatIdentity(cfg, target.boxId);
    if (seen.available && seen.identity?.state !== "archiving") break;
    await pause(POLL_MS);
  }
  forgetSetAsideBoatCreate(target.boxId);
  if (!(await rename(cfg, target.boxId, setAsideName))) return { kind: "rename-failed" };
  boat.forgetBoatId(target.boxId);
  try {
    const made = await provision(cfg, owner);
    return { kind: "set-aside", newBoxId: made.boxId, name: setAsideName };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Tried a few times: a set-aside computer whose name cannot be given back leaves the bot with none.
    let restored = false;
    for (let attempt = 0; attempt < 3 && !restored; attempt++) {
      if (attempt) await pause(POLL_MS);
      restored = await rename(cfg, target.boxId, target.name);
    }
    if (!restored) deps.log(`cloud computer ${owner}: ${target.boxId} was set aside as ${setAsideName}, but no new computer could be made and its name could not be given back: ${reason}`);
    return { kind: cloudFailureOf(error).limit?.reason === "at_once" ? "no-room" : "create-failed", restored, reason };
  }
}

/** Deletes a set-aside computer whose time is up: only while it is still there under the name it was set aside with (a
 * person who renamed it took it back). `kept`: it could not be read, so it is tried again later. */
export async function deleteExpiredSetAside(cfg: AppConfig, record: { boxId: string; name: string }): Promise<"deleted" | "gone" | "renamed" | "kept"> {
  const seen = await boat.inspectBoatIdentity(cfg, record.boxId);
  if (!seen.available) return "kept";
  if (!seen.identity) return "gone";
  if (seen.identity.name !== record.name || !boat.SET_ASIDE_BOAT_NAME.test(seen.identity.name)) return "renamed";
  // No owner: the deletion of a set-aside computer never holds up its bot's new one.
  await boat.requestRecordedBoatDeletion(cfg, { boxId: record.boxId, name: record.name, ownerBotId: null });
  return "deleted";
}
