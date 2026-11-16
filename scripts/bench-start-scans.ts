// Synthetic local data only. Never import config before isolating data.
//   node --experimental-strip-types scripts/bench-start-scans.ts [baseline-ref=main] [messages=200000]
// Times the start-up reads of messages.db and one capture of an engine's process tree, at the baseline ref and at
// this checkout, on the same data, and fails when the two disagree.
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ref = process.argv[2] ?? "main";
const total = Number(process.argv[3] ?? 200_000);
const directory = mkdtempSync(join(tmpdir(), "omb-start-scans-bench-"));
process.env.HOME = directory;
process.env.USERPROFILE = directory;
process.env.OMB_DATA_DIR = join(directory, "data");

const baselineFiles = ["message-db", "procs"].map((name) => ({ name, path: join(ROOT, "server", `${name}.bench-baseline.ts`) }));
for (const { name, path } of baselineFiles) writeFileSync(path, execFileSync("git", ["show", `${ref}:server/${name}.ts`], { cwd: ROOT }));

type MessageDb = typeof import("../server/message-db.ts");
type Procs = typeof import("../server/procs.ts");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const round = (value: number) => Number(value.toFixed(2));

/** Wall and CPU time of `runs` calls; CPU is what the server's one thread spends, whatever else the machine runs. */
function measure<T>(run: () => T, runs: number): { result: T; wallMs: number; cpuMs: number } {
  const wall: number[] = [], cpu: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const startCpu = process.cpuUsage(), start = performance.now();
    result = run();
    wall.push(performance.now() - start);
    const used = process.cpuUsage(startCpu);
    cpu.push((used.user + used.system) / 1000);
  }
  return { result, wallMs: round(median(wall)), cpuMs: round(median(cpu)) };
}

try {
  const baselineDb = await import(join(ROOT, "server", "message-db.bench-baseline.ts")) as MessageDb;
  const tools = ["your_computer", "computer_ask", "ask_peer"];
  const filler = (n: number) => "Synthetic history for start-up measurement. ".repeat(Math.ceil(n / 45)).slice(0, n);
  const threads: string[] = [];
  const at0 = Date.now() - 30 * 86_400_000;
  let seeded = 0;
  for (let thread = 0; seeded < total; thread++) {
    const threadId = `thread-${thread}`;
    threads.push(threadId);
    const rows: Array<Record<string, unknown>> = [];
    for (let turn = 0; rows.length < 1_000 && seeded + rows.length < total; turn++) {
      const at = at0 + (thread * 1_000 + turn) * 60_000, turnId = `${threadId}-turn-${turn}`;
      rows.push({ id: `${turnId}-ask`, role: "user", kind: "text", text: `Handle item ${turn}. ${filler(160)}`, at, sendId: `${turnId}-send` });
      for (let call = 0; call < 3; call++) {
        rows.push({ id: `${turnId}-call-${call}`, role: "bot", kind: "activity", at: at + 1_000 * (call + 1), turnId,
          tool: { name: call ? "Bash" : "Read", ok: true, input: JSON.stringify({ command: filler(400) }), output: filler(1_500) } });
      }
      if (turn % 40 === 0) {
        rows.push({ id: `${turnId}-card`, role: "bot", kind: "options", at: at + 4_500, turnId,
          card: { title: "Allow?", subtitle: "", options: ["Yes", "No"], requestType: "question", tool: tools[turn % tools.length], requestId: `${turnId}-request` } });
      }
      rows.push({ id: `${turnId}-reply`, role: "bot", kind: "text", text: `Done. ${filler(600)}`, at: at + 5_000, turnId, turnTerminal: true, turnCompletedAt: at + 5_500 });
      rows.push({ id: `${turnId}-digest`, role: "bot", kind: "digest", text: filler(200), at: at + 6_000, turnId, turnSucceeded: true });
    }
    let parentId: string | null = null;
    for (const row of rows) { row.parentId = parentId; parentId = row.id as string; }
    baselineDb.importThread(threadId, rows as never, parentId);
    seeded += rows.length;
  }
  baselineDb.closeMessageDb();

  const reads = (db: MessageDb) => ({
    optionCards: () => [db.optionCardsForTools(["your_computer"]), db.optionCardsForTools(["computer_ask"]), db.optionCardsForTools(["ask_peer"])],
    threadStamps: () => [db.latestMessageAts(threads), db.latestMessageAts(threads, true)].map((stamps) => [...stamps].sort(([a], [b]) => a.localeCompare(b))),
  });
  const before = reads(baselineDb);
  const baselineRuns = { optionCards: measure(before.optionCards, 7), threadStamps: measure(before.threadStamps, 7) };
  baselineDb.closeMessageDb();

  const currentDb = await import("../server/message-db.ts");
  const firstOpen = measure(() => currentDb.latestMessageAts([threads[0]!]), 1);
  const after = reads(currentDb);
  const currentRuns = { optionCards: measure(after.optionCards, 7), threadStamps: measure(after.threadStamps, 7) };
  currentDb.closeMessageDb();
  for (const read of ["optionCards", "threadStamps"] as const) {
    deepStrictEqual(currentRuns[read].result, baselineRuns[read].result);
    console.log(JSON.stringify({ read, messages: seeded, threads: threads.length,
      before: { wallMs: baselineRuns[read].wallMs, cpuMs: baselineRuns[read].cpuMs },
      after: { wallMs: currentRuns[read].wallMs, cpuMs: currentRuns[read].cpuMs } }));
  }
  console.log(JSON.stringify({ read: "first open after the upgrade (index build, once)", wallMs: firstOpen.wallMs, cpuMs: firstOpen.cpuMs }));

  if (process.platform === "linux") {
    const processes = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).length;
    const capture = async (procs: Procs) => {
      const child = procs.spawnCli("sh", ["-c", "sleep 60 & sleep 60 & wait"], { stdio: "pipe" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const timed = measure(() => procs.captureCliTree(child), 25);
      await procs.killCliTree(child, 1_000);
      return timed;
    };
    const baselineProcs = await import(join(ROOT, "server", "procs.bench-baseline.ts")) as Procs;
    const captureBefore = await capture(baselineProcs);
    const captureAfter = await capture(await import("../server/procs.ts"));
    console.log(JSON.stringify({ read: "engine process tree capture", processesOnMachine: processes,
      before: { wallMs: captureBefore.wallMs, cpuMs: captureBefore.cpuMs }, after: { wallMs: captureAfter.wallMs, cpuMs: captureAfter.cpuMs } }));
  }
} finally {
  for (const { path } of baselineFiles) rmSync(path, { force: true });
  rmSync(directory, { recursive: true, force: true });
}
