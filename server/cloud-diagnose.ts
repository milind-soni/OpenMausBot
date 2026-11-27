// The Admin's diagnose read of a Cloud home (`GET /api/cloud/diagnose`, signed like the health read; routes/cloud-signed.ts):
// what fills the disk and what grew, what runs and how much memory and CPU it takes, how the event loop and the machine are
// coping, and the last turn failures, for an operator who cannot open a shell on the Cloud. Read-only.
//
// Cost: the storage figures are the last storage pass (perf/disk-usage.ts, never a new pass here); the only walk is
// perf/diagnose-walk.ts under its own hard budget, which returns partial figures marked `incomplete` rather than run long.
// A read within DIAGNOSE_REUSE_MS of the last one is answered with that one (`reused`), so a burst of reads walks once.
//
// Privacy invariant: category and bucket names from fixed lists, process kinds (server, engine:<kind>, browser, ...) never their
// arguments, failure codes from the health ledger, numbers and times. Never a file name, a path, a bot's name, a title, content
// or an engine's account.
import { uptime as machineUptime } from "node:os";
import { dirname } from "node:path";

import type { CloudHealth } from "./cloud-health.ts";
import { diagnoseWalk, type DiagnoseFs, type DiagnoseWalkResult } from "./perf/diagnose-walk.ts";
import type { StorageReport } from "./perf/disk-usage.ts";
import { DIAGNOSE_GROWTH_WINDOWS, type Growth, type StorageHistory } from "./perf/storage-history.ts";

export const CLOUD_DIAGNOSE_PATH = "/api/cloud/diagnose";
export const DIAGNOSE_VERSION = 1;
/** A read this soon after the last is answered with the last one. */
export const DIAGNOSE_REUSE_MS = 3 * 60_000;
/** The newest turn failures listed, by code. */
export const DIAGNOSE_FAILURES = 20;
const CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;

export interface DiagnoseDeps {
  health: Pick<CloudHealth, "report" | "ledger">;
  /** The last storage pass, untrimmed; null where none is measured. */
  storage?: () => StorageReport | null;
  history?: StorageHistory | null;
  dataDir: string;
  /** The volume's root (HOME on a Cloud home, /data); defaults to the data folder's parent. */
  home?: string;
  fs?: DiagnoseFs;
  walk?: { maxEntries?: number; maxMs?: number; maxDepth?: number; yieldNow?: () => Promise<void> };
  uptimeS?: () => { process: number; machine: number };
  now?: () => number;
}

const code = (value: string | null | undefined) => (typeof value === "string" && CODE.test(value) ? value : null);
const growthOf = (growth: Growth | null | undefined) => (growth ? { since: growth.since, rows: growth.rows.slice(0, 10) } : null);

export function createCloudDiagnose(deps: DiagnoseDeps) {
  const now = deps.now ?? Date.now;
  let last: { at: number; report: DiagnoseReport } | null = null, running: Promise<DiagnoseReport> | null = null;

  const build = async (): Promise<DiagnoseReport> => {
    const started = now();
    const health = deps.health.report(null);
    let storage: StorageReport | null = null;
    try { storage = deps.storage?.() ?? null; } catch { storage = null; }
    try { deps.history?.note(storage); } catch { /* history is best effort */ }
    const home = deps.home ?? dirname(deps.dataDir);
    let walk: DiagnoseWalkResult | null = null;
    try {
      walk = await diagnoseWalk([{ path: home, scope: "home" }, { path: deps.dataDir, scope: "data" }], { ...deps.walk, ...(deps.fs ? { fs: deps.fs } : {}), now });
    } catch { walk = null; }
    const failures = [...deps.health.ledger.read(null).incidents].sort((a, b) => b.lastAt - a.lastAt).slice(0, DIAGNOSE_FAILURES)
      .flatMap((row) => (code(row.code) ? [{ kind: row.kind, code: row.code, engine: code(row.engine), count: row.count, firstAt: row.firstAt, lastAt: row.lastAt }] : []));
    const perf = health.perf;
    const uptime = deps.uptimeS?.() ?? { process: Math.round(process.uptime()), machine: Math.round(machineUptime()) };
    const report: DiagnoseReport = {
      v: DIAGNOSE_VERSION, at: now(), version: health.version, bootedAt: health.bootedAt, uptimeS: uptime,
      incomplete: Boolean(walk?.incomplete) || walk === null || Boolean(storage?.running && storage.at === null), tookMs: 0, reused: false,
      disk: {
        volume: health.system.disk,
        pass: storage ? { at: storage.at, ageS: storage.ageS, tookS: storage.tookS, running: storage.running, failed: storage.failed, progress: storage.progress } : null,
        categories: storage?.categories ?? [],
        unwalkedBytes: storage?.unwalkedBytes ?? null,
        bots: storage ? { shown: storage.bots.slice(0, 5), rest: storage.botsRest, gone: storage.botsGone ?? null } : null,
        caches: storage?.caches ?? null,
        growth: { h24: growthOf(deps.history?.growth(DIAGNOSE_GROWTH_WINDOWS.h24)), d7: growthOf(deps.history?.growth(DIAGNOSE_GROWTH_WINDOWS.d7)) },
        detail: walk,
      },
      processes: perf?.process ? { at: perf.process.at, scope: perf.process.scope, browsers: perf.process.browsers, unseen60mS: perf.process.unseen60mS, loop: perf.process.loop,
        kinds: perf.process.buckets.map((bucket) => ({ kind: bucket.bucket, procs: bucket.procs, rssMB: bucket.rssMB, cpu5mS: bucket.cpu5mS, cpu60mS: bucket.cpu60mS, peakPct: bucket.peakPct })) } : null,
      limits: perf?.processes ?? null,
      memory: { totalBytes: health.system.totalBytes, availableBytes: health.system.availableBytes, serverRssBytes: health.system.rssBytes, load1: health.system.load1, cpus: health.system.cpus,
        psi: health.speed.psi, steal: health.speed.steal, room: health.room },
      stalls: perf?.stalls ?? null,
      speed: { bootMs: health.speed.bootMs, wakeMs: health.speed.wakeMs },
      turns: health.turns,
      failures,
      engines: health.engines,
      browser: health.browser,
      box: health.box,
      doctor: health.doctor,
    };
    report.tookMs = Math.max(0, now() - started);
    return report;
  };

  return {
    /** The report, or the last one when it is younger than DIAGNOSE_REUSE_MS; concurrent reads share one build. */
    async read(): Promise<DiagnoseReport> {
      if (last && now() - last.at < DIAGNOSE_REUSE_MS) return { ...last.report, reused: true };
      if (running) return running;
      running = build().then((report) => { last = { at: now(), report }; return report; }).finally(() => { running = null; });
      return running;
    },
  };
}
export type CloudDiagnose = ReturnType<typeof createCloudDiagnose>;

type Health = ReturnType<CloudHealth["report"]>;
export interface DiagnoseReport {
  v: typeof DIAGNOSE_VERSION;
  at: number;
  version: string;
  bootedAt: number;
  uptimeS: { process: number; machine: number };
  /** Some part could not be read in full within its budget: the figures are partial. */
  incomplete: boolean;
  tookMs: number;
  /** The last read's report, answered again (DIAGNOSE_REUSE_MS). */
  reused: boolean;
  disk: {
    volume: Health["system"]["disk"];
    pass: { at: number | null; ageS: number | null; tookS: number | null; running: boolean; failed: boolean; progress: StorageReport["progress"] } | null;
    categories: StorageReport["categories"];
    unwalkedBytes: number | null;
    bots: { shown: StorageReport["bots"]; rest: StorageReport["botsRest"]; gone: StorageReport["botsGone"] | null } | null;
    caches: StorageReport["caches"] | null;
    growth: { h24: Growth | null; d7: Growth | null };
    detail: DiagnoseWalkResult | null;
  };
  processes: { at: number | null; scope: string; browsers: number; unseen60mS: number | null; loop: unknown; kinds: Array<{ kind: string; procs: number; rssMB: number; cpu5mS: number; cpu60mS: number; peakPct: number }> } | null;
  limits: unknown;
  memory: { totalBytes: number; availableBytes: number; serverRssBytes: number; load1: number; cpus: number; psi: Health["speed"]["psi"]; steal: number | null; room: Health["room"] };
  stalls: unknown;
  speed: { bootMs: number | null; wakeMs: number | null };
  turns: Health["turns"];
  failures: Array<{ kind: string; code: string; engine: string | null; count: number; firstAt: number; lastAt: number }>;
  engines: Health["engines"];
  browser: Health["browser"];
  box: Health["box"];
  doctor: Health["doctor"];
}
