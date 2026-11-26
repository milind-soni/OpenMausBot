import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ENGINE_RUNS_DIR, ENGINE_TAG_ENV, engineRunTag, leftBehind, markEngineRunClean, resetEngineRecordsForTest, startEngineRecords, type Listed } from "./engine-records.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const folders: string[] = [];
const started: ChildProcess[] = [];
const strays: number[] = [];

afterEach(async () => {
  resetEngineRecordsForTest();
  for (const child of started.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-engine-records-"));
  folders.push(dir);
  return dir;
}

const startOf = (pid: number) => process.platform === "linux"
  ? (() => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; })()
  : execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const running = (pid: number) => {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return false; }
};
/** The test process plays both servers, so the next one may not skip what started after it (startEngineRecords' cutoff). */
const sweep = (dir: string) => startEngineRecords(dir, () => {}, null);

/** An engine of an earlier server run: a session leader whose child outlives it in the background, as an MCP server does.
 * Both are node: macOS shows no environment of its own system programs (/bin/sleep), as it does of an engine's. */
async function leftover(dir: string, tag: string, server: { pid: number; start: string | null; boot?: string }, env: NodeJS.ProcessEnv = { [ENGINE_TAG_ENV]: tag }) {
  const pids = join(dir, `pids-${tag}`);
  const wait = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
  const engine = spawn("/bin/sh", ["-c", `${wait} & echo $! > "$0"; exec ${wait}`, pids], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, ...env } });
  started.push(engine);
  await vi.waitFor(() => expect(existsSync(pids) && readFileSync(pids, "utf8").trim()).toBeTruthy());
  const run = join(dir, ENGINE_RUNS_DIR, tag);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "server.json"), JSON.stringify(server));
  writeFileSync(join(run, `${engine.pid}.json`), JSON.stringify({ pid: engine.pid, start: startOf(engine.pid!) }));
  return { engine: engine.pid!, child: Number(readFileSync(pids, "utf8").trim()), run };
}

const DEAD_SERVER = { pid: 999_999_999, start: "gone" };

describe.skipIf(!posix)("engines an earlier server of this data folder left", () => {
  it("stops them and what they started, then forgets that run", async () => {
    const dir = dataDir();
    const left = await leftover(dir, "a".repeat(32), DEAD_SERVER);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await startEngineRecords(dir, console.info, null);
    info.mockRestore();
    expect(running(left.engine)).toBe(false);
    expect(running(left.child)).toBe(false);
    expect(existsSync(left.run)).toBe(false);
  });

  it("stops a recorded engine by its start time even when its environment cannot be read", async () => {
    const dir = dataDir();
    const left = await leftover(dir, "b".repeat(32), DEAD_SERVER, {});
    await sweep(dir);
    expect(running(left.engine)).toBe(false);
    // Its child carries no tag: it is left alone.
    expect(running(left.child)).toBe(true);
  });

  it("leaves alone a run whose server still runs, a process that only took a recorded number, and a run it cannot judge", async () => {
    const dir = dataDir();
    const server = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    started.push(server);
    const live = await leftover(dir, "c".repeat(32), { pid: server.pid!, start: startOf(server.pid!) });
    const stranger = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    started.push(stranger);
    const run = join(dir, ENGINE_RUNS_DIR, "d".repeat(32));
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "server.json"), JSON.stringify(DEAD_SERVER));
    writeFileSync(join(run, `${stranger.pid}.json`), JSON.stringify({ pid: stranger.pid, start: "an earlier process" }));
    const unjudged = join(dir, ENGINE_RUNS_DIR, "e".repeat(32));
    mkdirSync(unjudged, { recursive: true });
    await sweep(dir);
    expect(running(live.engine)).toBe(true);
    expect(running(live.child)).toBe(true);
    expect(running(stranger.pid!)).toBe(true);
    expect(existsSync(live.run)).toBe(true);
    expect(existsSync(unjudged)).toBe(true);
  });

  it("stops nothing of a run from another boot (a pid and start tick mean nothing across a reboot) and forgets it", async () => {
    const dir = dataDir();
    const left = await leftover(dir, "f".repeat(32), { ...DEAD_SERVER, boot: "an-earlier-boot" });
    await sweep(dir);
    expect(running(left.engine)).toBe(true);
    expect(running(left.child)).toBe(true);
    expect(existsSync(left.run)).toBe(false);
  });

  it("tags and records what this server starts, and forgets a record once its whole tree is stopped", async () => {
    const dir = dataDir();
    await sweep(dir);
    const tag = engineRunTag()!;
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    const child = spawnCli("/bin/sh", ["-c", `echo "$${ENGINE_TAG_ENV}"; exec sleep 60`], { stdio: ["pipe", "pipe", "pipe"] });
    started.push(child);
    let said = "";
    child.stdout.on("data", (chunk) => { said += chunk; });
    await vi.waitFor(() => expect(said.trim()).toBe(tag));
    const records = join(dir, ENGINE_RUNS_DIR, tag);
    expect(readdirSync(records)).toContain(`${child.pid}.json`);
    expect(await killCliTree(child, 500)).toBe(true);
    await vi.waitFor(() => expect(readdirSync(records)).not.toContain(`${child.pid}.json`));
  });
});

/** An engine this server starts with spawnCli: a background child in its own group (as an MCP server), and a daemon that
 * leaves for a session of its own (as an adb server, tmux or a dev server a bot starts on purpose). Both inherit the tag.
 * The daemon detaches as daemons do: a starter puts it in a new session and exits, so it is no longer below the engine.
 * (On Linux killCliTree stops every process still below the engine, whatever its session: sandbox helpers leave the
 * engine's group, procs.ts captureCliTree.) */
const ENGINE = `
const { spawn } = require("node:child_process");
const wait = ["-e", "setTimeout(() => {}, 60000)"];
const child = spawn(process.execPath, wait, { stdio: "ignore" });
const daemonize = "const d = require('node:child_process').spawn(process.execPath, " + JSON.stringify(wait) + ", { stdio: 'ignore', detached: true }); d.unref(); console.log(d.pid);";
const starter = spawn(process.execPath, ["-e", daemonize], { stdio: ["ignore", "pipe", "ignore"] });
let said = "";
starter.stdout.on("data", (chunk) => { said += chunk; });
starter.on("close", () => require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ child: child.pid, daemon: Number(said.trim()) })));
setInterval(() => {}, 60000);
`;

describe.skipIf(!posix)("a daemon an engine started in a session of its own", () => {
  async function serverWithEngine(dir: string) {
    await sweep(dir);
    const tag = engineRunTag()!;
    const script = join(dir, "engine.cjs");
    const pids = join(dir, `engine-${tag}.json`);
    writeFileSync(script, ENGINE);
    const engine = spawnCli("/bin/sh", ["-c", `exec "${process.execPath}" "$0" "$1"`, script, pids], { stdio: ["pipe", "pipe", "pipe"] });
    started.push(engine);
    await vi.waitFor(() => expect(existsSync(pids)).toBe(true));
    const { child, daemon } = JSON.parse(readFileSync(pids, "utf8")) as { child: number; daemon: number };
    strays.push(child, daemon);
    const run = join(dir, ENGINE_RUNS_DIR, tag);
    return { tag, engine, child, daemon, run };
  }
  /** The server is gone: its process no longer runs (the test process keeps running, so its record says so). */
  const serverDied = (run: string) => {
    const server = JSON.parse(readFileSync(join(run, "server.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(run, "server.json"), JSON.stringify({ ...server, pid: 999_999_999 }));
    resetEngineRecordsForTest();
  };

  it("survives a clean restart: the server stopped its engine itself and the next start sweeps nothing", async () => {
    const dir = dataDir();
    const first = await serverWithEngine(dir);
    // As dispose does at shutdown: the engine's whole group, not what left it.
    expect(await killCliTree(first.engine, 1_000)).toBe(true);
    expect(running(first.child)).toBe(false);
    expect(markEngineRunClean()).toBe(true);
    serverDied(first.run);
    await sweep(dir);
    expect(running(first.daemon)).toBe(true);
    expect(existsSync(first.run)).toBe(false);
  });

  it("is not marked clean while an engine of the run still runs", async () => {
    const dir = dataDir();
    const first = await serverWithEngine(dir);
    expect(markEngineRunClean()).toBe(false);
    expect(existsSync(join(first.run, "clean"))).toBe(false);
  });

  it("survives an unclean one, while the engine and the child still in its group are stopped", async () => {
    const dir = dataDir();
    const first = await serverWithEngine(dir);
    serverDied(first.run);
    await sweep(dir);
    expect(running(first.engine.pid!)).toBe(false);
    expect(running(first.child)).toBe(false);
    expect(running(first.daemon)).toBe(true);
    expect(existsSync(first.run)).toBe(false);
  });
});

describe("what of an earlier run is still running", () => {
  const tag = "a".repeat(32);
  /** A start as the system shows it: the start tick on Linux, ps's lstart elsewhere. */
  const at = (second: number) => process.platform === "linux" ? String(second) : new Date(2026, 10, 16, 10, 0, second).toString();
  const env = (value = tag) => new Map([[ENGINE_TAG_ENV, value]]);
  const row = (pid: number, extra: Partial<Listed> = {}): Listed => ({ pid, start: at(1), zombie: false, pgid: pid, sid: pid, env: env(), ...extra });
  const self = { pid: 1_000, tag: "b".repeat(32), start: at(30) };
  const leaders = new Map([[10, { start: at(1), at: null }]]);

  it("takes a recorded leader and the tagged processes in its group or session, and nothing in a session of its own", () => {
    const table = [
      row(10),
      row(11, { pgid: 10, sid: 10 }),
      row(12, { pgid: 12, sid: 10 }),
      row(13),
      row(14, { pgid: 10, sid: 10, env: env("c".repeat(32)) }),
      row(15, { pgid: 10, sid: 10, env: null }),
    ];
    expect(leftBehind(table, tag, leaders, self).sort()).toEqual([10, 11, 12]);
  });

  it("still takes a gone leader's group, but not the group of another process that now has that number", () => {
    expect(leftBehind([row(11, { pgid: 10, sid: 10 })], tag, leaders, self)).toEqual([11]);
    expect(leftBehind([row(10, { start: at(3), env: null }), row(11, { pgid: 10, sid: 10, start: at(4) })], tag, leaders, self)).toEqual([]);
  });

  it("never takes what started after this server, nor what carries this server's own tag", () => {
    expect(leftBehind([row(10, { start: at(40) }), row(11, { pgid: 10, sid: 10, start: at(41) })], tag, new Map([[10, { start: at(40), at: null }]]), self)).toEqual([]);
    expect(leftBehind([row(11, { pgid: 10, sid: 10, env: env(self.tag) })], tag, leaders, self)).toEqual([]);
  });
});
