// Settings → Storage and the sidebar's quiet storage line read one answer: GET /api/diagnostics/storage, the Cloud home's
// storage report beside the volume as it is now. Display only; nothing here deletes or clears anything.
import { activeLocale } from "@/lib/i18n";

export type StorageClass = "precious" | "work" | "rebuildable";
interface Tally { bytes: number; files: number }
interface Volume { totalBytes: number; freeBytes: number; usedBytes: number }

/** The fields of the server's storage report this view reads. */
export interface StorageReportWire {
  at: number | null;
  ageS: number | null;
  running: boolean;
  volume: Volume | null;
  walkedBytes: number | null;
  unwalkedBytes: number | null;
  categories: Array<{ name: string; class: string; bytes: number; files: number }>;
  bots: Array<{ id: string } & Tally>;
  botsRest: Tally & { count: number };
  botsGone?: Tally & { count: number };
  linksUncheckedBytes?: number;
  failed: boolean;
}

export interface StorageAnswer {
  storage: StorageReportWire | null;
  now?: Volume | null;
  measureInS?: number | null;
  /** The server's environment id: what the app remembers of this answer is kept under it. */
  server?: string;
}

/** Whose answer this is: the server's own id, or (an older server without one) this page's origin. What the app remembers
 * of a storage answer (the "seen" mark) is kept per scope, so switching Clouds never hides another Cloud's line. */
export function storageScope(answer: Pick<StorageAnswer, "server"> | null | undefined): string {
  const server = typeof answer?.server === "string" ? answer.server.trim() : "";
  if (server) return `server:${server}`;
  try { return `origin:${globalThis.location?.origin ?? ""}`; } catch { return "origin:"; }
}

export type StorageGroupKey = "work" | "precious" | "rebuildable" | "other" | "unmeasured";
/** The bar's order: what people made, what they said and set, what comes back by itself, the rest. */
export const STORAGE_GROUPS: readonly StorageGroupKey[] = ["work", "precious", "rebuildable", "other", "unmeasured"];

export interface StorageSummary {
  usedBytes: number;
  /** Used plus what is still free to write: what a percentage of "full" is of. */
  sizeBytes: number;
  percent: number;
  groups: Array<{ key: StorageGroupKey; bytes: number }>;
  /** The measured files add up to this much more than the volume says it uses (hard links, a pass that resumed). */
  overcountBytes: number;
}

const GROUP_OF: Readonly<Record<string, Exclude<StorageGroupKey, "other" | "unmeasured">>> = { work: "work", precious: "precious", rebuildable: "rebuildable" };

/** The volume's fullness, as `df` puts it (used of used plus available), from the freshest reading there is. */
export function storageFullness(answer: StorageAnswer | null): { usedBytes: number; sizeBytes: number; percent: number } | null {
  const volume = answer?.now ?? answer?.storage?.volume ?? null;
  if (!volume) return null;
  const sizeBytes = volume.usedBytes + volume.freeBytes;
  if (sizeBytes <= 0) return null;
  return { usedBytes: volume.usedBytes, sizeBytes, percent: Math.min(100, Math.max(0, Math.round((volume.usedBytes / sizeBytes) * 100))) };
}

/** The bar: each category in its plain group by the class the server gave it, `other` (and any class this app doesn't know)
 * under Other, and what the pass couldn't see as the unmeasured rest. When the measured files add up to more than the
 * volume uses, the groups are scaled down to it and the difference is said instead. */
export function storageSummary(answer: StorageAnswer | null): StorageSummary | null {
  const report = answer?.storage;
  const full = storageFullness(answer);
  if (!report || !full || report.at === null || !report.volume) return null;
  const sums: Record<StorageGroupKey, number> = { work: 0, precious: 0, rebuildable: 0, other: 0, unmeasured: 0 };
  for (const row of report.categories) sums[row.name === "other" ? "other" : GROUP_OF[row.class] ?? "other"] += Math.max(0, row.bytes);
  const measured = sums.work + sums.precious + sums.rebuildable + sums.other;
  const usedAtPass = report.volume.usedBytes;
  const overcountBytes = Math.max(0, measured - usedAtPass);
  const scale = measured > 0 && overcountBytes > 0 ? usedAtPass / measured : 1;
  // The groups are the last pass's. What was written since counts as unmeasured; if the volume shrank since, they shrink with it.
  const shrink = usedAtPass > 0 ? Math.min(1, full.usedBytes / usedAtPass) : 1;
  const groups: Array<{ key: StorageGroupKey; bytes: number }> = STORAGE_GROUPS.filter((key) => key !== "unmeasured").map((key) => ({ key, bytes: Math.round(sums[key] * scale * shrink) }));
  const shown = groups.reduce((sum, group) => sum + group.bytes, 0);
  groups.push({ key: "unmeasured", bytes: Math.max(0, full.usedBytes - shown) });
  return { ...full, groups: groups.filter((group) => group.bytes > 0), overcountBytes };
}

export type StorageBand = "ok" | "near" | "full";
export const NEAR_PERCENT = 80, FULL_PERCENT = 90;
/** How far under a line usage has to fall before crossing it again counts as new: a volume that grows by itself as it
 * fills sits near a line for a while, and each grow is not a new crossing. */
export const REARM_POINTS = 5;

export const storageBand = (percent: number): StorageBand => (percent >= FULL_PERCENT ? "full" : percent >= NEAR_PERCENT ? "near" : "ok");
const RANK: Record<StorageBand, number> = { ok: 0, near: 1, full: 2 };

/** What has been seen, once usage moved: a band seen stays seen until usage falls REARM_POINTS under its line. */
export function settleSeen(seen: StorageBand | null, percent: number): StorageBand | null {
  let settled = seen === "ok" ? null : seen;
  if (settled === "full" && percent < FULL_PERCENT - REARM_POINTS) settled = "near";
  if (settled === "near" && percent < NEAR_PERCENT - REARM_POINTS) settled = null;
  return settled;
}

/** The band the sidebar's line shows, or null: under 80%, or this band (or a fuller one) already seen. */
export function storageNotice(percent: number | null, seen: StorageBand | null): Exclude<StorageBand, "ok"> | null {
  if (percent === null) return null;
  const band = storageBand(percent);
  if (band === "ok") return null;
  return RANK[band] > RANK[settleSeen(seen, percent) ?? "ok"] ? band : null;
}

const SEEN_KEY = "openmausbot.storageNotice.seen.v1";
/** The "seen" mark of one Cloud (storageScope). */
export const storageSeenKey = (scope: string): string => `${SEEN_KEY}:${scope}`;
export function readStorageSeen(scope: string): StorageBand | null {
  try {
    const value = globalThis.localStorage?.getItem(storageSeenKey(scope));
    return value === "near" || value === "full" ? value : null;
  } catch { return null; }
}
export function writeStorageSeen(scope: string, seen: StorageBand | null): void {
  try {
    if (seen === null || seen === "ok") globalThis.localStorage?.removeItem(storageSeenKey(scope));
    else globalThis.localStorage?.setItem(storageSeenKey(scope), seen);
  } catch { /* storage may be blocked: the line shows again next launch */ }
}

const GIB = 1024 ** 3, MIB = 1024 ** 2, KIB = 1024;
/** A size in the person's own number format, in binary units as the plans count them. */
export function storageSize(bytes: number, locale = activeLocale()): string {
  const [value, unit] = bytes >= GIB ? [bytes / GIB, "gigabyte"] : bytes >= MIB ? [bytes / MIB, "megabyte"] : [Math.ceil(Math.max(0, bytes) / KIB), "kilobyte"];
  const digits = value >= 100 || unit === "kilobyte" ? 0 : 1;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits }).format(value);
}

export const BOTS_SHOWN = 5;
/** `private`: on a Team Cloud, a bot this person is not shown (a teammate's own MausBot): counted, never named. */
export interface StorageBotRow { key: string; name: string | null; bytes: number; kind: "bot" | "private" | "gone" | "rest" }

/** The names Storage may show: on a Team Cloud never another person's own MausBot (the server keeps it from an admin too;
 * this holds should one still reach the list), which then reads as a private bot. While who this person is isn't known yet
 * (`me` null) the server's list is taken as it is, so their own MausBot never reads as private. */
export function storageBotNames(bots: ReadonlyArray<{ id: string; name: string; defaultBot?: { person?: string } }>, team: { me: string | null } | null): Map<string, string> {
  const me = team?.me?.trim().toLowerCase() ?? "";
  return new Map(bots.filter((bot) => {
    const person = bot.defaultBot?.person?.trim().toLowerCase();
    return !team || !person || !me || person === me;
  }).map((bot) => [bot.id, bot.name]));
}

/** The largest bots first, named by the app (null when it has no name for the id; on a Team Cloud such a bot is a private
 * one, someone else's), then deleted bots' leftovers and any other bot folders together. */
export function storageBots(report: StorageReportWire, nameOf: (id: string) => string | null | undefined, shown = BOTS_SHOWN, team = false): StorageBotRow[] {
  const listed = report.bots.filter((bot) => bot.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const rows: StorageBotRow[] = listed.slice(0, shown).map((bot) => {
    const name = nameOf(bot.id)?.trim() || null;
    return { key: bot.id, name, bytes: bot.bytes, kind: team && name === null ? "private" : "bot" };
  });
  const gone = report.botsGone?.bytes ?? 0;
  const folded = listed.slice(shown).reduce((sum, bot) => sum + bot.bytes, 0);
  const rest = Math.max(0, report.botsRest.bytes - gone) + folded;
  if (gone > 0) rows.push({ key: "gone", name: null, bytes: gone, kind: "gone" });
  if (rest > 0) rows.push({ key: "rest", name: null, bytes: rest, kind: "rest" });
  return rows;
}
