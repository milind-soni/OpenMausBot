// The memory cap on real processes (Linux): stand-in engines started as spawnCli starts them, each leading its own
// session with two tool-server children and a child its shell left behind (adopted by init, still in the engine's
// session); the watchdog reads /proc as the server does: stat lines, proportional set sizes, start ticks, real signals.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { BotMemoryWatchdog, pssBytes } from "./bot-memory-cap.ts";
import { parseProcStat } from "./perf/process-buckets.ts";
import { linuxProcessList } from "./perf/process-sampler.ts";

const MB = 1024 * 1024;
const started: ChildProcess[] = [];
afterEach(() => { for (const child of started.splice(0)) try { process.kill(-child.pid!, "SIGKILL"); } catch {} });

/** An engine that holds `holdMb` of its own pages, with two tool servers and a background `sleep` its shell left. */
function engine(holdMb: number): ChildProcess {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    for (let i = 0; i < 2; i++) spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    spawn("/bin/sh", ["-c", "sleep 600 & exit 0"], { stdio: "ignore" });
    const keep = []; for (let i = 0; i < ${holdMb}; i++) { const b = Buffer.alloc(${MB}); b.fill(1 + (i % 250)); keep.push(b); }
    setInterval(() => keep.length, 1000);
    process.stdout.write("ready\\n");
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  started.push(child);
  return child;
}
const ready = (child: ChildProcess) => new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startOf = (pid: number) => { try { return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null; } catch { return null; } };
/** Polls until `done` holds or the deadline passes. */
async function until(done: () => boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (done()) return true;
  return done();
}
/** The processes in `sid`'s session. */
const session = (sid: number) => linuxProcessList().rows.filter((row) => row.sid === sid && row.state !== "Z").map((row) => row.pid);

describe("the memory cap on real processes", () => {
  it.runIf(process.platform === "linux")("stops only the bot over its cap, the child its shell left included, and leaves the other bot running", async () => {
    const big = engine(300), small = engine(10);
    await Promise.all([ready(big), ready(small)]);
    // Both sessions are whole: the engine, two tool servers and the left-behind sleep.
    expect(await until(() => session(big.pid!).length === 4 && session(small.pid!).length === 4)).toBe(true);
    const smallPids = session(small.pid!);
    const signals: string[] = [];
    const dog = new BotMemoryWatchdog({
      cap: () => 200 * MB, list: () => linuxProcessList().rows, pss: (pid) => pssBytes(pid), startOf, graceMs: 2_000,
      owners: () => [{ pid: big.pid!, botIds: ["bot_big"], kind: "engine" }, { pid: small.pid!, botIds: ["bot_small"], kind: "engine" }],
      signal: (pid, value) => { signals.push(`${value} ${pid}`); process.kill(pid, value); }, log: () => {},
    });
    let stops = await dog.check();
    // 300 MB of its own pages against 200 MB is past one and a half times the cap: one look is enough. Allow a second
    // where the share read below that the first time.
    if (!stops.length) stops = await dog.check();
    expect(stops.map((stop) => stop.botId)).toEqual(["bot_big"]);
    expect(stops[0]!.usedBytes).toBeGreaterThan(300 * MB);
    expect(stops[0]!.pids.length).toBeGreaterThanOrEqual(4);
    expect(await until(() => session(big.pid!).length === 0)).toBe(true);
    expect(signals.some((line) => smallPids.includes(Number(line.split(" ")[1])))).toBe(false);
    expect(smallPids.every(alive)).toBe(true);
    expect(await dog.check()).toEqual([]);
  }, 60_000);
});
