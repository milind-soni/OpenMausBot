// An OMB Cloud home is personal: only the owner's devices connect, each with an admin session. Every other stored session
// is revoked at every boot, its key recorded first, so no crash can ever make it the owner's. Earlier keys settle once
// (and after a restore): `adopted` keys keep who opened a conversation, its level and folder; only `proven` keys (a still
// paired admin session, or one that answered a card) feed lending, memory and recall. Routines are the owner's only with proof.
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const CLOUD_PERSONAL_REFUSAL = "My Cloud is personal: only your own devices can connect.";

const KEY = /^p_[\w-]{22}$/;
const keys = z.array(z.string().regex(KEY)).max(100_000);
const recordFile = z.object({
  version: z.literal(2),
  machineId: z.string().max(128),
  /** Revoked here, ever: never anyone's but nobody's. */
  revokedKeys: keys,
  adoptedKeys: keys,
  provenKeys: keys,
  settled: z.boolean(),
  pendingRestore: z.string().max(128).optional(),
  settledRestore: z.string().max(128).optional(),
  /** When anyone but the owner was first found to have used this Cloud; never cleared. */
  sharedSince: z.number().int().nonnegative().optional(),
  /** This machine's records were searched once for anyone but the owner, and none was found then. */
  peopleChecked: z.literal(true).optional(),
}).strict();
type OwnershipRecord = z.infer<typeof recordFile>;

export interface PeopleRecord {
  people(): Iterable<string>;
  reassign(move: (person: string) => boolean, to: string): string[];
}

export interface CloudOwnershipOptions {
  /** 0600, and never in a backup. */
  file: string;
  machineId: string;
  ownerKey: string;
  nobodyKey: string;
  /** Marks what came in from outside (a webhook): never a person. */
  outsideKey?: string;
  sessions: {
    list(): readonly { id: string; email?: string; scopes: readonly string[] }[];
    revoke(id: string): boolean;
  };
  personKey(session: { id: string; email?: string }): string;
  starters: PeopleRecord;
  writers: PeopleRecord;
  routines: {
    ids(): Iterable<string>; writer(id: string): string | undefined; fingerprinted(id: string): boolean; resultsOpener(id: string): string | undefined;
    shape(id: string): string | undefined;
    name(id: string, person: string): void; pause(ids: readonly string[]): void;
  };
  unpin(threadIds: readonly string[]): void;
  lines(): { senders: Iterable<string>; answerers: Iterable<string>; approvals: Iterable<[routineId: string, person: string, shape: string]> };
  /** The id of a restore applied at this boot: what it brought is the owner's. */
  restoredNow?: string;
  lastRestore?: string;
  log(line: string): void;
}

export interface CloudOwnership {
  /** Earlier keys that opened, wrote or answered: the owner's for who opened a conversation, its level and its folder. */
  adopted: ReadonlySet<string>;
  /** Earlier keys proven the owner's: also for lending and memory. */
  proven: ReadonlySet<string>;
  /** Every non-owner session's key this machine ever revoked. */
  revoked: ReadonlySet<string>;
  sharedSince?: number;
  /** A start before this one searched the records and found only the owner. */
  soloBefore: boolean;
  /** The record could not be read: nothing can show the Cloud was only ever the owner's. */
  unreadable: boolean;
  restoring: boolean;
}

type Settling = Pick<CloudOwnership, "soloBefore" | "unreadable" | "restoring">;

function readRecord(options: Pick<CloudOwnershipOptions, "file" | "machineId" | "log">): OwnershipRecord & { fresh?: true; unreadable?: true } {
  const fresh: OwnershipRecord & { fresh?: true } = { version: 2, machineId: options.machineId, revokedKeys: [], adoptedKeys: [], provenKeys: [], settled: false, fresh: true };
  let stat;
  try { stat = lstatSync(options.file, { throwIfNoEntry: false }); } catch { stat = null; }
  if (stat === undefined) return fresh;
  try {
    if (!stat || !stat.isFile() || stat.size > 16_000_000) throw new Error("not a file");
    const record = recordFile.parse(JSON.parse(readFileSync(options.file, "utf8")));
    // Another machine's (never carried by a backup): nothing in it is ours.
    if (record.machineId !== options.machineId) {
      options.log(`cloud home: ${options.file} is another machine's; settling this one's own`);
      return fresh;
    }
    return record;
  } catch {
    // Settled before and unreadable now: settling again could make a revoked key the owner's.
    options.log(`cloud home: ${options.file} is unreadable, so nothing from before is treated as the owner's`);
    return { ...fresh, settled: true, unreadable: true };
  }
}

function save(options: Pick<CloudOwnershipOptions, "file" | "log">, record: OwnershipRecord): boolean {
  try {
    writeFileAtomic(options.file, JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch (error) {
    options.log(`cloud home: could not record who is the owner (${error instanceof Error ? error.message : String(error)}); trying again at the next start`);
    return false;
  }
}

/** A failed step is logged and never stops the server starting; every step is safe to redo at the next start. */
function attempt<T>(options: CloudOwnershipOptions, what: string, step: () => T, fallback: T, failed?: () => void): T {
  try { return step(); } catch (error) {
    options.log(`cloud home: could not ${what} (${error instanceof Error ? error.message : String(error)})`);
    failed?.();
    return fallback;
  }
}

function settledSets(record: OwnershipRecord, settling: Settling): CloudOwnership {
  const revoked = new Set(record.revokedKeys);
  return { adopted: new Set(record.adoptedKeys.filter((key) => !revoked.has(key))), proven: new Set(record.provenKeys.filter((key) => !revoked.has(key))),
    revoked, ...(record.sharedSince !== undefined ? { sharedSince: record.sharedSince } : {}), ...settling };
}

/** Records that someone but the owner used this Cloud (kept forever), or that a search found nobody else. */
export function recordCloudSharing(options: Pick<CloudOwnershipOptions, "file" | "machineId" | "log">, found: { sharedSince: number } | { peopleChecked: true }): boolean {
  const { fresh: _fresh, unreadable: _unreadable, ...record } = readRecord(options);
  if ("sharedSince" in found) return save(options, { ...record, sharedSince: record.sharedSince ?? found.sharedSince });
  return record.sharedSince === undefined ? save(options, { ...record, peopleChecked: true }) : true;
}

/** Every step is recorded before it is taken, so a crash or a failed save only ever leaves a key less trusted. */
export function settleCloudOwnership(options: CloudOwnershipOptions): CloudOwnership {
  const { fresh, unreadable, ...read } = readRecord(options);
  let record: OwnershipRecord = read;
  const others = options.sessions.list().filter((session) => !session.scopes.includes("admin"));
  const revoked = new Set([...record.revokedKeys, ...others.map((session) => options.personKey(session))]);
  const restore = options.restoredNow ??
    (!fresh && options.lastRestore && options.lastRestore !== record.settledRestore && options.lastRestore !== record.pendingRestore ? options.lastRestore : undefined);
  record = { ...record, revokedKeys: [...revoked], ...(restore ? { pendingRestore: restore } : {}),
    ...(fresh && !options.restoredNow && options.lastRestore ? { settledRestore: options.lastRestore } : {}) };
  const settling: Settling = { soloBefore: !fresh && !unreadable && read.peopleChecked === true && read.sharedSince === undefined,
    unreadable: unreadable === true, restoring: record.pendingRestore !== undefined };
  // 1. The keys about to be revoked are recorded first.
  if (!save(options, record)) return settledSets(record, settling);
  let count = 0;
  for (const session of others) if (attempt(options, "revoke a session", () => options.sessions.revoke(session.id), false)) count += 1;
  options.log(`cloud home: revoked ${count} session${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not the owner's own device${count === 1 ? "" : "s"}`);
  // 3. What any revoked key opened or wrote is nobody's: its conversations lose their folder, its routines stop.
  const orphans = attempt(options, "mark conversations as nobody's", () => options.starters.reassign((person) => revoked.has(person), options.nobodyKey), []);
  if (orphans.length) attempt(options, "unpin their folders", () => options.unpin(orphans), undefined);
  const stopped = attempt(options, "mark routines as nobody's", () => options.writers.reassign((person) => revoked.has(person), options.nobodyKey), []);
  if (stopped.length) attempt(options, "pause their routines", () => options.routines.pause(stopped), undefined);
  if (fresh) {
    options.log("cloud home: only your own devices can connect now. Review Settings → Remote access → Paired devices, and sign out any device that isn't yours.");
  }
  const restoring = settling.restoring;
  if (record.settled && !restoring) return settledSets(record, settling);
  // 4. The earlier keys, recorded before anything is rewritten.
  const eligible = (person: string) => KEY.test(person) && person !== options.ownerKey && person !== options.nobodyKey && person !== options.outsideKey && !revoked.has(person);
  // Settled only once every step below is done; else the next start does it again.
  let complete = true;
  const incomplete = () => { complete = false; };
  const lines = attempt(options, "read who wrote in each conversation", () => options.lines(), { senders: [], answerers: [], approvals: [] }, incomplete);
  const admins = options.sessions.list().filter((session) => session.scopes.includes("admin")).map((session) => options.personKey(session));
  const proven = new Set([...record.provenKeys, ...admins, ...lines.answerers].filter(eligible));
  const adopted = new Set([...record.adoptedKeys, ...proven, ...options.starters.people(), ...lines.senders].filter(eligible));
  record = { ...record, adoptedKeys: [...adopted], provenKeys: [...proven] };
  if (!save(options, record)) return settledSets(record, settling);
  const moved = attempt(options, "name the owner on their conversations", () => options.starters.reassign((person) => proven.has(person), options.ownerKey), [], incomplete).length;
  const ownersKey = (person: string | undefined) => person !== undefined && (person === options.ownerKey || proven.has(person));
  // A card the owner allowed proves only while the routine still runs exactly what it showed (instructions, bot, schedule, place, no attachment).
  const approved = new Set<string>();
  for (const [id, person, shape] of lines.approvals) {
    if (ownersKey(person) && options.routines.shape(id) === shape) approved.add(id);
  }
  let owners = 0, nobodys = 0;
  attempt(options, "name each routine's writer", () => {
    for (const id of options.routines.ids()) {
      const writer = options.routines.writer(id);
      // A restore proves only a routine reporting into a conversation that names nobody yet or the owner: a backup can hold a guest's.
      const opener = options.routines.resultsOpener(id);
      const owner = writer === options.ownerKey || options.routines.fingerprinted(id) || approved.has(id) ||
        (restoring && writer !== options.nobodyKey && !(writer !== undefined && revoked.has(writer)) && (opener === undefined || ownersKey(opener)));
      if (writer !== (owner ? options.ownerKey : options.nobodyKey)) options.routines.name(id, owner ? options.ownerKey : options.nobodyKey);
      if (owner) owners += 1; else nobodys += 1;
    }
  }, undefined, incomplete);
  if (!complete) return settledSets(record, settling);
  const { pendingRestore: done, ...rest } = record;
  record = { ...rest, settled: true, ...(done ? { settledRestore: done } : {}) };
  save(options, record);
  options.log(`cloud home: settled what came before${restoring ? " (a restore)" : ""}: ${adopted.size} earlier device key${adopted.size === 1 ? "" : "s"} (${proven.size} proven), ${moved} conversation${moved === 1 ? "" : "s"} named the owner's, ${owners} routine${owners === 1 ? "" : "s"} the owner's and ${nobodys} nobody's`);
  return settledSets(record, settling);
}
