// Each bot's footprint: the processes, threads, resident memory and CPU time of its engine processes and its browser, from
// the process sampler's own list (no read or spawn of its own). A process is a bot's when it is, or descends from, or
// (once its parent has gone) still runs in the process group or session of, an engine or browser process that only that
// bot uses. An engine or browser that
// serves several bots (a shared ACP process, a browser profile several bots use) is "shared" and never counted against
// any one of them; nothing is ever attributed by a process's name. Privacy invariant: bot ids and numbers only.
import { ID } from "./turn-record.ts";
import type { ProcessRow } from "./process-buckets.ts";

/** A process the server started for bots: an engine (spawnCli) or a browser's daemon (its session's pid file). */
export interface FootprintOwner {
  pid: number;
  /** The start the process list shows for it, where known: a pid the system gave to another process since is not it. */
  start?: string | null;
  /** The bots it serves now. One: that bot's. More, none, or one that is not a bot id: shared. */
  botIds: readonly string[];
  kind: "engine" | "browser";
  /** It has exited: its pid may be another process's now, but its group and session still name what it left. */
  exited?: boolean;
  /** An engine's conversations now (for the memory cap: which are running a turn). */
  threads?: readonly string[];
  /** An engine process other conversations may join (a shared ACP process): the memory cap never stops one. */
  shareable?: boolean;
  /** A browser's session. */
  session?: string;
}

/** What one owner record brought a bot: the record's pid and its processes now. */
export interface FootprintUnit {
  root: number;
  kind: FootprintOwner["kind"];
  /** The root itself has exited: what is left ran on in its group or session. */
  exited: boolean;
  shareable: boolean;
  threads: string[];
  session?: string;
  pids: number[];
}

export interface BotTally {
  procs: number;
  /** Null where the process list carries no thread counts (macOS's `ps`). */
  threads: number | null;
  rssBytes: number;
  /** CPU time so far of its processes running now, ms. */
  cpuMs: number;
  /** CPU used since the previous sample by its processes, ms. */
  cpuDeltaMs: number;
  engines: number;
  browsers: number;
  pids: number[];
  /** Those of `pids` that belong to it through a browser (its daemon and Chrome), not an engine. */
  browserPids: number[];
  /** Its processes by the record they count through, by that record's pid. */
  units: Map<number, FootprintUnit>;
}

export interface Attribution {
  /** By bot id: its processes. */
  bots: Map<string, BotTally>;
  shared: BotTally;
}

const emptyTally = (): BotTally => ({ procs: 0, threads: 0, rssBytes: 0, cpuMs: 0, cpuDeltaMs: 0, engines: 0, browsers: 0, pids: [], browserPids: [], units: new Map() });

/** Whose each row is: a bot's id, SHARED, or undefined for none (the server, its own helpers, anything else). */
export const SHARED = "\0shared";

export function attributeRows(rows: readonly ProcessRow[], owners: readonly FootprintOwner[], previous?: ReadonlyMap<number, { start: string; cpuMs: number }>): Attribution {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  // A leader the list shows with another start is another process now; one the list no longer shows (an engine that
  // exited) still names its group and session: the system gives no new process a number that still names one.
  type Root = { label: string; kind: FootprintOwner["kind"]; pid: number; exited: boolean; shareable: boolean; threads: string[]; session?: string };
  const roots = new Map<number, Root>();
  /** Leaders still running as themselves: only these name the process with their pid; the others name groups and sessions. */
  const live = new Set<number>();
  for (const owner of owners) {
    const row = byPid.get(owner.pid);
    if (row && owner.start && row.start !== owner.start) continue;
    const ids = [...new Set(owner.botIds)];
    const label = ids.length === 1 && ID.test(ids[0]!) ? ids[0]! : SHARED;
    const known = roots.get(owner.pid);
    // Two records of one pid disagreeing about its bot: shared, never either bot's.
    roots.set(owner.pid, { label: known && known.label !== label ? SHARED : label, kind: owner.kind, pid: owner.pid, exited: (known?.exited ?? true) && owner.exited === true,
      shareable: known?.shareable === true || owner.shareable === true, threads: [...new Set([...known?.threads ?? [], ...owner.threads ?? []])], session: known?.session ?? owner.session });
    if (!owner.exited) live.add(owner.pid);
  }
  type Label = Root | null;
  const labels = new Map<number, Label>();
  const labelOf = (row: ProcessRow, depth: number): Label => {
    const known = labels.get(row.pid);
    if (known !== undefined) return known;
    labels.set(row.pid, null);
    // Its own record first, then the nearest recorded ancestor, then (for what outlived its parent and was adopted by an
    // init) the session and group it still runs in.
    let label: Label = live.has(row.pid) ? roots.get(row.pid) ?? null : null;
    if (label === null && row.ppid !== row.pid && depth < 64) {
      const parent = byPid.get(row.ppid);
      if (parent) label = labelOf(parent, depth + 1);
    }
    if (label === null && row.sid !== undefined && row.sid !== row.pid) label = roots.get(row.sid) ?? null;
    if (label === null && row.pgid !== undefined && row.pgid !== row.pid) label = roots.get(row.pgid) ?? null;
    labels.set(row.pid, label);
    return label;
  };
  const out: Attribution = { bots: new Map(), shared: emptyTally() };
  for (const row of rows) {
    const found = labelOf(row, 0);
    if (found === null) continue;
    const label = found.label;
    const tally = label === SHARED ? out.shared : out.bots.get(label) ?? out.bots.set(label, emptyTally()).get(label)!;
    if (found.kind === "browser") tally.browserPids.push(row.pid);
    const unit = tally.units.get(found.pid) ?? tally.units.set(found.pid, { root: found.pid, kind: found.kind, exited: found.exited, shareable: found.shareable, threads: found.threads,
      ...(found.session === undefined ? {} : { session: found.session }), pids: [] }).get(found.pid)!;
    unit.pids.push(row.pid);
    tally.procs += 1;
    tally.threads = tally.threads === null || row.threads === undefined ? null : tally.threads + row.threads;
    tally.rssBytes += row.rssBytes;
    tally.cpuMs += row.cpuMs;
    const before = previous?.get(row.pid);
    if (previous) tally.cpuDeltaMs += before && before.start === row.start && row.cpuMs >= before.cpuMs ? row.cpuMs - before.cpuMs : row.cpuMs;
    tally.pids.push(row.pid);
    const root = live.has(row.pid) ? roots.get(row.pid) : undefined;
    if (root?.kind === "engine") tally.engines += 1;
    else if (root?.kind === "browser") tally.browsers += 1;
  }
  return out;
}

export interface BotFootprintRow {
  id: string;
  procs: number;
  threads: number | null;
  rssMB: number;
  /** The most resident memory seen for this bot since the server started. */
  peakMB: number;
  cpuS: number;
  /** Of one core, over the time since the previous sample. */
  cpuPct: number;
  engines: number;
  browsers: number;
}

export interface BotCapReport {
  mb: number | null; mode: "log" | "enforce" | null; rung: string; stops: number; flagged: number;
  events: ReadonlyArray<{ at: number; botId: string; usedMB: number; measured: string; capMB: number; engines: number; room: number; freeMB: number | null; pressure: boolean; action: string }>;
}

export interface BotFootprintReport {
  at: number | null;
  /** Bots with any process running at the last sample. */
  bots: number;
  /** The bots using the most memory first. */
  shown: BotFootprintRow[];
  shared: Omit<BotFootprintRow, "id" | "peakMB">;
  /** The memory one bot may use per engine it runs (bot-memory-cap.ts): MB or null for none; "log" (watch only, the
   * default) or "enforce" (a set number); how; steps taken and bots written down as over since start; the latest events. */
  cap?: BotCapReport;
}

const MB = 1_048_576;
/** Peaks of bots no longer seen are kept for this many bots at most, the least recently seen dropped first. */
const MAX_PEAKS = 1_000;

export interface BotFootprintsOptions {
  owners: () => readonly FootprintOwner[];
  /** After each sample, with its list: records of exited engines that list no longer needs can go (engine-owners.ts). */
  prune?: (rows: readonly ProcessRow[]) => void;
  now?: () => number;
}

export function createBotFootprints(options: BotFootprintsOptions) {
  const now = options.now ?? Date.now;
  const peaks = new Map<string, number>();
  let previous: { at: number; rows: Map<number, { start: string; cpuMs: number }> } | null = null;
  let latest: { at: number; windowMs: number | null; attribution: Attribution } | null = null;

  return {
    /** One process list from the sampler. */
    sample(rows: readonly ProcessRow[]): Attribution {
      const at = now();
      const attribution = attributeRows(rows, options.owners(), previous?.rows);
      for (const [id, tally] of attribution.bots) {
        const peak = Math.max(peaks.get(id) ?? 0, tally.rssBytes);
        // Moved to the end: the least recently seen bots' peaks go first.
        peaks.delete(id);
        peaks.set(id, peak);
      }
      while (peaks.size > MAX_PEAKS) peaks.delete(peaks.keys().next().value!);
      latest = { at, windowMs: previous ? Math.max(1, at - previous.at) : null, attribution };
      previous = { at, rows: new Map(rows.map((row) => [row.pid, { start: row.start, cpuMs: row.cpuMs }])) };
      options.prune?.(rows);
      return attribution;
    },
    /** The last sample's tallies. */
    latest: () => latest?.attribution ?? null,
    /** `limit`: how many bots to show, the ones using the most memory first; every bot when omitted. */
    report(limit?: number): BotFootprintReport {
      const windowMs = latest?.windowMs ?? null;
      const row = (tally: BotTally) => ({
        procs: tally.procs, threads: tally.threads, rssMB: Math.round(tally.rssBytes / MB), cpuS: Math.round(tally.cpuMs / 100) / 10,
        cpuPct: windowMs === null ? 0 : Math.round((tally.cpuDeltaMs / windowMs) * 100), engines: tally.engines, browsers: tally.browsers,
      });
      const bots = [...latest?.attribution.bots ?? []].sort(([, a], [, b]) => b.rssBytes - a.rssBytes || b.procs - a.procs);
      return {
        at: latest?.at ?? null,
        bots: bots.length,
        shown: bots.slice(0, limit ?? bots.length).map(([id, tally]) => ({ id, ...row(tally), peakMB: Math.round(Math.max(peaks.get(id) ?? 0, tally.rssBytes) / MB) })),
        shared: row(latest?.attribution.shared ?? emptyTally()),
      };
    },
  };
}
export type BotFootprints = ReturnType<typeof createBotFootprints>;

function capLine(cap: BotCapReport): string {
  if (cap.mb === null) return "  Memory one bot may use: no limit";
  const last = cap.events.at(-1);
  return `  Memory one bot may use: ${cap.mb} MB per engine (${cap.mode === "enforce" ? "enforced when memory runs short" : "watch only"}, ${cap.rung}); `
    + `steps taken since start: ${cap.stops}, over with nothing stopped: ${cap.flagged}`
    + (last ? `; latest: bot ${last.botId} ${last.usedMB} MB (${last.measured}) of ${last.capMB} MB, ${last.engines} engines, room ${last.room}, ${last.action}` : "");
}

/** The plain line for people: a @devs report and the desktop's diagnostics. */
export function botFootprintLines(report: BotFootprintReport): string[] {
  if (report.at === null) return ["Per bot: not sampled yet"];
  const threads = (count: number | null) => (count === null ? "" : `, ${count} threads`);
  const one = (row: BotFootprintRow) => `bot ${row.id} ${row.procs} processes${threads(row.threads)}, ${row.rssMB} MB (most ${row.peakMB} MB), ${row.cpuS}s CPU, ${row.cpuPct}% now`
    + `${row.engines ? `, ${row.engines} engine${row.engines === 1 ? "" : "s"}` : ""}${row.browsers ? ", browser" : ""}`;
  const shared = report.shared;
  return [
    `Per bot (${report.bots} with processes running; most memory first): ${report.shown.length ? report.shown.map(one).join("; ") : "none"}`,
    ...(report.cap ? [capLine(report.cap)] : []),
    `  Shared by several bots: ${shared.procs} processes${threads(shared.threads)}, ${shared.rssMB} MB, ${shared.engines} engines, ${shared.browsers} browsers`,
  ];
}
