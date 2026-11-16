// Synthetic bots and threads only, in a temporary directory. Measures what one whole-file save of bots.json costs and
// how many of them a round of turns causes. Never import config before isolating data.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path"; import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const shapes = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).map((shape) => shape.split("x").map(Number)).filter((shape) => shape.length === 2 && shape.every((n) => n > 0));
const TURNS_TOGETHER = 34;
console.log(JSON.stringify({ benchmark: "bots-save", node: process.version, platform: platform(), arch: arch(),
  scope: "Real Store and bots.json with fsync, synthetic bots and threads. A round is the bookkeeping 34 turns write, one turn per pass of the event loop, batched as the server batches it." }));
for (const [bots, threads] of shapes.length ? shapes : [[34, 200], [100, 200], [200, 200]]) {
  const directory = mkdtempSync(join(tmpdir(), "omb-bots-save-"));
  // Each shape runs in its own process: the store binds its data directory when first imported.
  if (process.env.OMB_BENCH_SHAPE !== `${bots}x${threads}`) {
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), `${bots}x${threads}`],
      { env: { ...process.env, OMB_DATA_DIR: directory, OMB_BENCH_SHAPE: `${bots}x${threads}` }, encoding: "utf8" });
    process.stdout.write(child.stdout.split("\n").filter((line) => line.includes('"bots":')).join("\n") + "\n");
    if (child.status !== 0) process.stderr.write(child.stderr);
    rmSync(directory, { recursive: true, force: true });
    continue;
  }
  const { Store } = await import("../server/store.ts");
  const batch = await import("../server/save-batch.ts") as { batchSaves<T>(run: () => T): T; flushLaterSaves?: () => void };
  const selection = () => ({ instanceId: "claude", model: "synthetic" });
  const seed = new Store(selection);
  const first = seed.createBot({ name: "Bench 0" }, { seedMessages: false });
  const file = join(process.env.OMB_DATA_DIR!, "bots.json");
  const template = JSON.parse(JSON.stringify(seed.bot(first.id)));
  const rows = Array.from({ length: bots }, (_, b) => ({ ...template, id: randomUUID(), threadId: `thread-${b}-0`, name: `Bench ${b}`,
    tasks: Array.from({ length: threads }, (_, t) => ({ ...template.tasks[0], id: randomUUID(), threadId: `thread-${b}-${t}`,
      title: `Synthetic thread ${t} with a title of ordinary length`, resumeCursors: { claude: { sessionId: randomUUID() } },
      usage: { input: 120_000 + t, output: 4_000 + t, cachedInput: 90_000, costUsd: null, turns: 12, lastTurn: { input: 900, output: 80, costUsd: null } } })) }));
  writeFileSync(file, JSON.stringify(rows));
  const store = new Store(selection);
  const bytes = statSync(file).size;

  const saves: number[] = [];
  for (let i = 0; i < 9; i++) {
    const at = performance.now();
    store.patchBot(rows[0]!.id, { title: `Durable change ${i}` });
    saves.push(performance.now() - at);
  }
  const oneSaveMs = Number(saves.sort((a, b) => a - b)[4]!.toFixed(1));

  let writes = 0, inode = statSync(file).ino;
  const counted = () => { const now = statSync(file).ino; if (now !== inode) { writes += 1; inode = now; } };
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  await delay(20);
  lag.reset();
  const start = performance.now();
  let busyMs = 0;
  for (let turn = 0; turn < TURNS_TOGETHER; turn++) {
    const botId = rows[turn % bots]!.id, threadId = `thread-${turn % bots}-1`;
    const at = performance.now();
    // As the server does: a turn's start is one batch, and the event that settles it another.
    batch.batchSaves(() => { store.setTaskAskedAt(botId, threadId, Date.now()); store.patchTask(botId, threadId, { unread: false }); }); counted();
    batch.batchSaves(() => {
      store.setResumeCursor(botId, "claude", { sessionId: `session-${turn % bots}` }, threadId);
      store.addTaskUsage(botId, threadId, { input: 900, output: 80, costUsd: null });
      store.patchTask(botId, threadId, { unread: true });
    }); counted();
    busyMs += performance.now() - at;
    await new Promise((resolve) => setImmediate(resolve));
    counted();
  }
  const roundMs = performance.now() - start;
  await delay(1_200);
  counted();
  lag.disable();
  batch.flushLaterSaves?.();
  console.log(JSON.stringify({ bots, threads, botsJsonMb: Number((bytes / 1e6).toFixed(1)), oneSaveMs, turns: TURNS_TOGETHER, wholeFileWrites: writes,
    roundBlockedMs: Math.round(busyMs), roundMs: Math.round(roundMs), eventLoopMaxMs: Number((lag.max / 1e6).toFixed(1)) }));
}
