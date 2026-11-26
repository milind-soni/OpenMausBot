// GET /api/diagnostics/performance: the performance recorder's plain lines for the desktop's diagnostics export.
// GET /api/diagnostics/bots: every bot's processes, threads, memory and CPU at the last sample (perf/bot-footprint.ts), bot
// ids and numbers only. GET /api/diagnostics/storage: what fills a Cloud home's volume (perf/disk-usage.ts), null elsewhere, with the
// volume as it is now and when the owner may ask for a pass; POST /api/diagnostics/storage/measure asks for one. POST /api/diagnostics/launch: the desktop app's main process and its page each hand in their part
// of the launch record (perf/launch-timings.ts), which keeps only checked numbers and fixed codes. All admin scope (request-auth's default), so on a Cloud home a bot's shell, a service-trust
// loopback caller, never reaches them.
import type { BotFootprintReport } from "../perf/bot-footprint.ts";
import type { StorageReport, VolumeBytes } from "../perf/disk-usage.ts";
import type { MeasureAnswer } from "../perf/storage-measure.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PERF_DIAGNOSTICS_PATH = "/api/diagnostics/performance";
export const BOT_FOOTPRINT_PATH = "/api/diagnostics/bots";
export const STORAGE_PATH = "/api/diagnostics/storage";
export const STORAGE_MEASURE_PATH = "/api/diagnostics/storage/measure";

export const LAUNCH_PATH = "/api/diagnostics/launch";
const LAUNCH_BODY_MAX = 16 * 1024;

export interface StorageViewDeps {
  /** This server's environment id (already public at /.well-known/openmausbot/environment): the app keys what it remembers
   * of a storage answer by it, so two Clouds never share a "seen" mark or numbers. */
  serverId?: string;
  storageNow?(): Promise<VolumeBytes | null>;
  storageMeasureInS?(): number | null;
  measureStorage?(): MeasureAnswer | null;
}

export function createPerfDiagnosticsRoutes(deps: { text(): string; bots?(): BotFootprintReport | null; storage?(): StorageReport | null; launch?(part: unknown): { ok: boolean; complete: boolean } | null } & StorageViewDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "POST" && path === STORAGE_MEASURE_PATH) {
      res.setHeader("cache-control", "no-store");
      const answer = deps.measureStorage?.() ?? null;
      return json(res, answer ? 200 : 404, answer ?? { started: false, running: false, inS: 0 });
    }
    if (method === "POST" && path === LAUNCH_PATH) {
      res.setHeader("cache-control", "no-store");
      const noted = deps.launch ? deps.launch(await readBody(req, LAUNCH_BODY_MAX).catch(() => null)) : null;
      return json(res, noted ? 200 : 404, noted ?? { ok: false, complete: false });
    }
    if (method !== "GET" || (path !== PERF_DIAGNOSTICS_PATH && path !== BOT_FOOTPRINT_PATH && path !== STORAGE_PATH)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === BOT_FOOTPRINT_PATH) return json(res, 200, { bots: deps.bots?.() ?? null });
    if (path === STORAGE_PATH) return json(res, 200, await storageBody(deps));
    return json(res, 200, { text: deps.text() });
  };
}

async function storageBody(deps: { storage?(): StorageReport | null } & StorageViewDeps) {
  const storage = deps.storage?.() ?? null;
  if (!storage || !deps.storageNow) return { storage };
  return { storage, now: await deps.storageNow().catch(() => null), measureInS: deps.storageMeasureInS?.() ?? null, ...(deps.serverId ? { server: deps.serverId } : {}) };
}
