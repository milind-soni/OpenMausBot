import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { CLOUD_DIAGNOSE_PATH, createCloudDiagnose, DIAGNOSE_REUSE_MS } from "./cloud-diagnose.ts";
import { createCloudHealth } from "./cloud-health.ts";
import { cloudRequestSignature } from "./cloud-home.ts";
import { diagnoseWalk, YIELD_EVERY, type DiagnoseFs, type DiagnoseStat } from "./perf/diagnose-walk.ts";
import type { StorageReport } from "./perf/disk-usage.ts";
import { createStorageHistory } from "./perf/storage-history.ts";
import { createCloudSignedRoutes } from "./routes/cloud-signed.ts";
import { SessionRegistry } from "./sessions.ts";

const secret = "S".repeat(43);
const T0 = 1_800_000_000_000, DAY = 86_400_000;
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-diagnose-")); folders.push(dir); return dir; };

// Names a customer could have made: an email, a path with spaces, quotes, emoji, a secret-looking string, newlines.
// Windows refuses `"` and control characters in a file name, so there the quoted and the two-line names become ones it allows.
const WINDOWS = process.platform === "win32";
const AWKWARD = ["jane.doe@example.com", "Tax return 2026 (final).pdf", WINDOWS ? "my 'secret' plan; 100% [final].txt" : "my \"secret\" plan.txt", "🦄 notes", "sk-live-ABCDEF1234567890",
  WINDOWS ? "sk-live-QWERTY0987654321 & co, #2 {copy}" : "line\nbreak", "..hidden", "Downloads"];

function homeFixture() {
  const home = tempDir(), data = join(home, ".openmausbot");
  for (const [folder, file] of [["workspaces/bot-abc/Project Jane", AWKWARD[1]!], ["task-workspaces/t1/node_modules/left-pad", "index.js"], ["Downloads", AWKWARD[0]!], [AWKWARD[3]!, AWKWARD[2]!]] as const) {
    const parent = folder.startsWith("workspaces") || folder.startsWith("task-workspaces") ? join(data, folder) : join(home, folder);
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(parent, file), "x".repeat(2048));
  }
  mkdirSync(join(data, "events"), { recursive: true });
  writeFileSync(join(data, "events", AWKWARD[5]!), "{}");
  writeFileSync(join(home, AWKWARD[4]!), "secret");
  utimesSync(join(home, "Downloads", AWKWARD[0]!), new Date(T0 - 3 * DAY), new Date(T0 - 3 * DAY));
  return { home, data };
}

function health(dataDir: string, now: () => number) {
  return createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [{ instanceId: "i1", driverKind: "claude", snapshot: undefined }], dataDir, eventsDir: dataDir, version: "0.1.181", image: undefined,
    connectors: () => null, browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
}

const storageReport = (at: number, bytes: Record<string, number>): StorageReport => ({
  v: 1, at, ageS: 60, tookS: 30, running: false, progress: null, volume: { totalBytes: 100e9, freeBytes: 4e9, usedBytes: 96e9 }, walkedBytes: 90e9, unwalkedBytes: 6e9,
  categories: Object.entries(bytes).map(([name, value]) => ({ name: name as StorageReport["categories"][number]["name"], class: "work" as const, bytes: value, files: 10 })),
  bots: [{ id: "bot-abc", bytes: 1, files: 1 }], botsRest: { bytes: 0, files: 0, count: 0 }, other: null, skipped: null, linksCapped: false, linksUncheckedBytes: 0, resumes: 0, failed: false,
});

describe("the diagnose read", () => {
  it("carries no name from the customer's folders: categories, fixed buckets, counts, sizes and ages only", async () => {
    const { home, data } = homeFixture();
    let clock = T0;
    const now = () => clock;
    const diagnose = createCloudDiagnose({ health: health(data, now), storage: () => storageReport(T0 - 1000, { bot_files: 5e9, other: 1e9 }), history: createStorageHistory({ file: null }),
      dataDir: data, home, now, uptimeS: () => ({ process: 10, machine: 20 }) });
    const report = await diagnose.read();
    const text = JSON.stringify(report);
    for (const name of [...AWKWARD.filter((name) => name !== "Downloads"), "Project Jane", "left-pad", "index.js", home]) expect(text).not.toContain(JSON.stringify(name).slice(1, -1));
    const buckets = Object.fromEntries(report.disk.detail!.buckets.map((row) => [row.name, row]));
    expect(buckets.downloads).toMatchObject({ files: 1, oldestAt: T0 - 3 * DAY });
    expect(buckets.node_modules?.files).toBe(1);
    expect(buckets.bot_files?.files).toBe(1);
    expect(buckets.conversations?.files).toBe(1);
    expect(report.disk.detail!.incomplete).toBe(false);
    expect(report.disk.categories.map((row) => row.name)).toEqual(["bot_files", "other"]);
    expect(report.uptimeS).toEqual({ process: 10, machine: 20 });
    expect(report.engines).toEqual([{ kind: "claude", used: false, available: null, authenticated: null, version: null }]);
    clock += 1000;
    expect((await diagnose.read()).reused).toBe(true);
    clock += DIAGNOSE_REUSE_MS;
    expect((await diagnose.read()).reused).toBe(false);
  });

  it("says what grew in the last day and week once the history reaches back that far, and unknown before", () => {
    const history = createStorageHistory({ file: null });
    history.note(storageReport(T0, { bot_files: 1e9, logs: 1e8 }));
    expect(history.growth(DAY)).toBeNull();
    history.note(storageReport(T0 + DAY, { bot_files: 3e9, logs: 1e8, temp: 5e8 }));
    history.note(storageReport(T0 + DAY, { bot_files: 9e9 }));
    expect(history.growth(DAY)).toEqual({ since: T0, rows: [{ name: "bot_files", bytes: 2e9 }, { name: "temp", bytes: 5e8 }] });
    expect(history.growth(7 * DAY)).toBeNull();
    history.note({ ...storageReport(T0 + 2 * DAY, { bot_files: 1 }), failed: true });
    expect(history.points()).toHaveLength(2);
  });
});

describe("the diagnose walk's budget", () => {
  // A fake tree of 10 folders of 100,000 files each: far more than the budget allows. Depth is counted on either separator,
  // since the walk joins names with the platform's own (backslashes on Windows).
  const huge = (): { fs: DiagnoseFs; calls: () => number } => {
    let calls = 0;
    const stat = (directory: boolean): DiagnoseStat => ({ dev: 1, size: 4096, mtimeMs: T0, isDirectory: () => directory, isSymbolicLink: () => false });
    const fs: DiagnoseFs = {
      lstat: async (path) => { calls++; return stat(!/f\d+$/.test(path)); },
      opendir: async (path) => {
        calls++;
        const depth = path.split(/[\\/]/).length, names = depth <= 3 ? Array.from({ length: 10 }, (_, i) => `d${i}`) : Array.from({ length: 100_000 }, (_, i) => `f${i}`);
        let index = 0;
        return { read: async () => (index < names.length ? { name: names[index++]! } : null), close: async () => {} };
      },
    };
    return { fs, calls: () => calls };
  };

  it("stops at its entry budget and says the figures are partial", async () => {
    const tree = huge();
    let yields = 0;
    const result = await diagnoseWalk([{ path: "/data", scope: "home" }], { fs: tree.fs, maxEntries: 5_000, yieldNow: async () => { yields++; } });
    expect(result).toMatchObject({ incomplete: true, stoppedBy: "entries", entries: 5_000 });
    expect(yields).toBe(Math.floor(4_999 / YIELD_EVERY));
    expect(tree.calls()).toBeLessThan(5_100);
  });

  it("stops at its time budget, checked at each yield, on its own clock", async () => {
    const tree = huge();
    let clock = 0;
    const result = await diagnoseWalk([{ path: "/data", scope: "home" }], { fs: tree.fs, now: () => clock, maxMs: 1_000, yieldNow: async () => { clock += 100; } });
    expect(result).toMatchObject({ incomplete: true, stoppedBy: "time", entries: 10 * YIELD_EVERY, tookMs: 1_000 });
  });

  it("never goes deeper than its depth limit", async () => {
    let opened = 0;
    const fs: DiagnoseFs = {
      lstat: async () => ({ dev: 1, size: 1, mtimeMs: T0, isDirectory: () => true, isSymbolicLink: () => false }),
      opendir: async () => { opened++; let given = false; return { read: async () => (given ? null : (given = true, { name: "deeper" })), close: async () => {} }; },
    };
    const result = await diagnoseWalk([{ path: "/data", scope: "home" }], { fs, maxDepth: 6 });
    expect(result).toMatchObject({ incomplete: false, tooDeep: 1 });
    expect(opened).toBe(6);
  });
});

describe("GET /api/cloud/diagnose", () => {
  function routes(clock?: Parameters<typeof createCloudSignedRoutes>[0]["clock"]) {
    const { home, data } = homeFixture();
    let counter = 0;
    const now = () => T0;
    const diagnose = createCloudDiagnose({ health: health(data, now), storage: () => null, dataDir: data, home, now, uptimeS: () => ({ process: 1, machine: 2 }) });
    const handle = createCloudSignedRoutes({ secret, sessions: new SessionRegistry({ file: join(data, "sessions.json"), now }), health: health(data, now), diagnose, now, ...(clock ? { clock } : {}) });
    const sign = (method = "GET", key = secret, at = now()) => {
      const timestamp = String(Math.floor(at / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
      return { "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, method, CLOUD_DIAGNOSE_PATH, "")}` };
    };
    const send = async (method: string, headers: Record<string, string>) => {
      const req = Object.assign(new PassThrough(), { method, url: CLOUD_DIAGNOSE_PATH, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
      let status = 0, text = "";
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { text = body; } } as unknown as ServerResponse;
      const url = new URL(CLOUD_DIAGNOSE_PATH, "http://localhost");
      const answered = handle({ req, res, url, path: url.pathname, method });
      (req as unknown as PassThrough).end("");
      return { answered: await answered, status, body: text ? JSON.parse(text) : null };
    };
    return { sign, send };
  }

  it("answers only the Admin's signed GET", async () => {
    const { sign, send } = routes();
    const ok = await send("GET", sign());
    expect(ok).toMatchObject({ answered: true, status: 200 });
    expect(ok.body).toMatchObject({ v: 1, version: "0.1.181", disk: { pass: null } });
    expect((await send("GET", sign("GET", "W".repeat(43)))).status).toBe(401);
    expect((await send("GET", {})).status).toBe(401);
    expect((await send("POST", sign("POST"))).status).toBe(405);
  });

  it("answers the Admin while a resume left this clock behind: judged by the measured time, as health and power reads are", async () => {
    // The home measured itself 40 minutes behind (server/cloud-clock.ts); the Admin signs with the true time.
    const BEHIND = 40 * 60_000;
    const clock = { noteSigned() {}, fits: (timestampS: number) => Math.abs(timestampS * 1000 - (T0 + BEHIND)) <= 300_000, report: () => ({ v: 1 as const, errorMs: BEHIND, measuredAt: T0 + BEHIND }) };
    const { sign, send } = routes(clock);
    expect(await send("GET", sign("GET", secret, T0 + BEHIND))).toMatchObject({ answered: true, status: 200 });
    // One signed for the wrong clock is refused now that the true time is known, and says by how much.
    expect(await send("GET", sign("GET", secret, T0))).toMatchObject({ status: 401, body: { error: "stale_request", clockErrorMs: BEHIND } });
  });

  it("is not a route on a server with no diagnose", async () => {
    const data = tempDir();
    const handle = createCloudSignedRoutes({ secret, sessions: new SessionRegistry({ file: join(data, "sessions.json") }), health: health(data, Date.now) });
    const req = Object.assign(new PassThrough(), { method: "GET", url: CLOUD_DIAGNOSE_PATH, headers: {}, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    const url = new URL(CLOUD_DIAGNOSE_PATH, "http://localhost");
    expect(await handle({ req, res: {} as ServerResponse, url, path: url.pathname, method: "GET" })).toBe(false);
  });
});
