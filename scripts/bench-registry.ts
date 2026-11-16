// What one registry save costs as bots and threads grow: bots.json and groups.json rewritten whole, with fsync, by the
// real Store. Synthetic data in a throwaway folder per cell; never the person's own. Opt-in only (pnpm bench:registry),
// never part of the test suite.
//   pnpm bench:registry               the default matrix
//   pnpm bench:registry 34x200 1x5    only these cells (bots x threads per bot)
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const DEFAULT_CELLS = ["1x5", "5x50", "34x200", "100x200", "200x200"];
const CELL = /^(\d+)x(\d+)$/;

type Result = {
  bots: number; threadsPerBot: number; rooms: number; threadsPerRoom: number;
  botsJsonKb: number; groupsJsonKb: number; loadMs: number; heapMb: number;
  serializeP50Ms: number;
  saveP50Ms: number; saveP95Ms: number; saveMaxMs: number;
  bookkeepingP50Ms: number; bookkeepingP95Ms: number;
  roomSaveP50Ms: number;
  samples: number;
};

const round = (value: number) => Number(value.toFixed(2));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
};
const timed = (samples: number, run: (i: number) => void): number[] => {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const at = performance.now();
    run(i);
    out.push(performance.now() - at);
  }
  return out;
};

/** One cell, in a child whose OMB_DATA_DIR is already a fresh folder: config reads it at import. */
async function runCell(bots: number, threadsPerBot: number): Promise<Result> {
  const dataDir = process.env.OMB_DATA_DIR!;
  const { Store } = await import("../server/store.ts");
  const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

  // Template records written by the Store itself, so the clones carry today's fields.
  const seed = new Store(selection);
  const bot = seed.createBot({ name: "Template", title: "Researcher", description: "Synthetic bot for the registry bench" });
  const thread = seed.createTask(bot.id, "Synthetic thread title of a usual length", false)!;
  seed.setResumeCursor(bot.id, "claude", randomUUID(), thread.threadId);
  seed.markTaskDispatched(bot.id, thread.threadId, "claude");
  seed.setTaskAskedAt(bot.id, thread.threadId, Date.now());
  const room = seed.createGroup("Template room", [bot.id], false, undefined, { bulletin: "Synthetic bulletin." });
  const botTemplate = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))[0];
  const roomTemplate = JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8")).find((r: { id: string }) => r.id === room.id);
  const taskTemplate = botTemplate.tasks.find((t: { threadId: string }) => t.threadId === thread.threadId);
  const roomTaskTemplate = roomTemplate.tasks[0];

  const rooms = Math.ceil(bots / 10);
  const threadsPerRoom = Math.min(threadsPerBot, 20);
  const now = Date.now();
  const botRecords = Array.from({ length: bots }, (_, b) => {
    const tasks = Array.from({ length: threadsPerBot }, (_, t) => ({
      ...structuredClone(taskTemplate), threadId: randomUUID(), title: `Thread ${t} of bot ${b}`,
      createdAt: now - t * 60_000, updatedAt: now - t * 60_000, resumeCursors: { claude: randomUUID() },
    }));
    return { ...structuredClone(botTemplate), id: randomUUID(), name: `Bot ${b}`, threadId: tasks[0]!.threadId, tasks };
  });
  const roomRecords = Array.from({ length: rooms }, (_, r) => {
    const tasks = Array.from({ length: threadsPerRoom }, (_, t) => ({
      ...structuredClone(roomTaskTemplate), threadId: randomUUID(), title: `Room thread ${t}`, createdAt: now - t * 60_000, updatedAt: now - t * 60_000,
    }));
    return { ...structuredClone(roomTemplate), id: randomUUID(), name: `Room ${r}`, threadId: tasks[0]!.threadId,
      memberIds: botRecords.slice(0, 5).map((record) => record.id), tasks };
  });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(botRecords), { mode: 0o600 });
  writeFileSync(join(dataDir, "groups.json"), JSON.stringify(roomRecords), { mode: 0o600 });

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  let at = performance.now();
  const store = new Store(selection);
  const loadMs = performance.now() - at;
  gc?.();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

  const samples = bots * threadsPerBot >= 20_000 ? 20 : 40;
  const pick = (i: number) => {
    const owner = store.bots[(i * 7919) % store.bots.length]!;
    const tasks = owner.tasks!;
    return { botId: owner.id, threadId: tasks[(i * 104_729) % tasks.length]!.threadId };
  };
  for (let i = 0; i < 3; i++) store.renameTask(pick(i).botId, pick(i).threadId, `Warm-up ${i}`);
  const serialize = timed(samples, () => { JSON.stringify(store.bots); });
  // A durable change: the thread's title, saved at once with fsync.
  const save = timed(samples, (i) => { const { botId, threadId } = pick(i); store.renameTask(botId, threadId, `Renamed ${i}`); });
  // Bookkeeping a turn leaves: the engine session id. Outside a batched pass it saves at once too.
  const bookkeeping = timed(samples, (i) => { const { botId, threadId } = pick(i); store.setResumeCursor(botId, "claude", `cursor-${i}`, threadId); });
  const groupSamples = Math.min(samples, 20);
  const roomSave = timed(groupSamples, (i) => {
    const group = store.groups[i % store.groups.length]!;
    store.patchGroupTask(group.id, group.tasks![i % group.tasks!.length]!.threadId, { title: `Room renamed ${i}` });
  });
  return {
    bots, threadsPerBot, rooms, threadsPerRoom,
    botsJsonKb: Math.round(statSync(join(dataDir, "bots.json")).size / 1024),
    groupsJsonKb: Math.round(statSync(join(dataDir, "groups.json")).size / 1024),
    loadMs: round(loadMs), heapMb: round(heapMb),
    serializeP50Ms: percentile(serialize, 0.5),
    saveP50Ms: percentile(save, 0.5), saveP95Ms: percentile(save, 0.95), saveMaxMs: percentile(save, 1),
    bookkeepingP50Ms: percentile(bookkeeping, 0.5), bookkeepingP95Ms: percentile(bookkeeping, 0.95),
    roomSaveP50Ms: percentile(roomSave, 0.5),
    samples,
  };
}

function parent(cells: string[]) {
  for (const cell of cells) if (!CELL.test(cell)) throw new Error(`not a cell: ${cell} (want BOTSxTHREADS, e.g. 34x200)`);
  const cpu = cpus()[0]?.model ?? "unknown";
  console.log(JSON.stringify({ benchmark: "registry-save", node: process.version, platform: platform(), arch: arch(), cpu,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    scope: "Real Store, synthetic bots and threads cloned from records the Store wrote; one room per ten bots. Not a full turn." }));
  const results: Result[] = [];
  for (const cell of cells) {
    const home = mkdtempSync(join(tmpdir(), "omb-registry-bench-home-"));
    const data = mkdtempSync(join(tmpdir(), "omb-registry-bench-data-"));
    try {
      const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--expose-gc", fileURLToPath(import.meta.url), "--cell", cell], {
        env: { ...process.env, HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, OMB_DISABLE_ANNOUNCEMENTS: "1", OMB_DISABLE_MODEL_MANIFEST_FETCH: "1" },
        encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      const line = run.stdout.split("\n").find((text) => text.startsWith("{\"bots\""));
      if (run.status !== 0 || !line) throw new Error(`cell ${cell} failed (${run.status}):\n${run.stderr}`);
      console.log(line);
      results.push(JSON.parse(line));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  }
  console.log("\n| bots × threads | bots.json | load | heap after load | save p50 / p95 / max | bookkeeping p50 / p95 | serialize p50 | room save p50 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.bots} × ${r.threadsPerBot} | ${r.botsJsonKb} KB | ${r.loadMs} ms | ${r.heapMb} MB | ${r.saveP50Ms} / ${r.saveP95Ms} / ${r.saveMaxMs} ms | `
      + `${r.bookkeepingP50Ms} / ${r.bookkeepingP95Ms} ms | ${r.serializeP50Ms} ms | ${r.roomSaveP50Ms} ms |`);
  }
}

const cellFlag = process.argv.indexOf("--cell");
if (cellFlag !== -1) {
  const [, bots, threads] = CELL.exec(process.argv[cellFlag + 1] ?? "") ?? [];
  if (!bots || !threads || !process.env.OMB_DATA_DIR) throw new Error("--cell needs BOTSxTHREADS and OMB_DATA_DIR");
  console.log(JSON.stringify(await runCell(Number(bots), Number(threads))));
} else {
  const asked = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  parent(asked.length ? asked : DEFAULT_CELLS);
}
