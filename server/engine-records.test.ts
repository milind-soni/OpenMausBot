import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ENGINE_TAG_ENV, engineRunTag, resetEngineRecordsForTest, startEngineRecords } from "./engine-records.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const folders: string[] = [];
const started: ChildProcess[] = [];

afterEach(async () => {
  resetEngineRecordsForTest();
  for (const child of started.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
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

/** An engine of an earlier server run: a session leader whose child outlives it in the background, as an MCP server does.
 * Both are node: macOS shows no environment of its own system programs (/bin/sleep), as it does of an engine's. */
async function leftover(dir: string, tag: string, server: { pid: number; start: string | null }, env: NodeJS.ProcessEnv = { [ENGINE_TAG_ENV]: tag }) {
  const pids = join(dir, `pids-${tag}`);
  const wait = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
  const engine = spawn("/bin/sh", ["-c", `${wait} & echo $! > "$0"; exec ${wait}`, pids], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, ...env } });
  started.push(engine);
  await vi.waitFor(() => expect(existsSync(pids) && readFileSync(pids, "utf8").trim()).toBeTruthy());
  const run = join(dir, "engine-runs", tag);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "server.json"), JSON.stringify(server));
  writeFileSync(join(run, `${engine.pid}.json`), JSON.stringify({ pid: engine.pid, start: startOf(engine.pid!) }));
  return { engine: engine.pid!, child: Number(readFileSync(pids, "utf8").trim()), run };
}

describe.skipIf(!posix)("engines an earlier server of this data folder left", () => {
  it("stops them and what they started, then forgets that run", async () => {
    const dir = dataDir();
    const left = await leftover(dir, "a".repeat(32), { pid: 999_999_999, start: "gone" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await startEngineRecords(dir);
    info.mockRestore();
    expect(running(left.engine)).toBe(false);
    expect(running(left.child)).toBe(false);
    expect(existsSync(left.run)).toBe(false);
  });

  it("stops a recorded engine by its start time even when its environment cannot be read", async () => {
    const dir = dataDir();
    const left = await leftover(dir, "b".repeat(32), { pid: 999_999_999, start: "gone" }, {});
    await startEngineRecords(dir, () => {});
    expect(running(left.engine)).toBe(false);
    // Its child carries no tag and was never recorded: it is left alone.
    expect(running(left.child)).toBe(true);
  });

  it("leaves alone a run whose server still runs, and a process that only took a recorded number", async () => {
    const dir = dataDir();
    const server = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    started.push(server);
    const live = await leftover(dir, "c".repeat(32), { pid: server.pid!, start: startOf(server.pid!) });
    const stranger = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    started.push(stranger);
    const run = join(dir, "engine-runs", "d".repeat(32));
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, `${stranger.pid}.json`), JSON.stringify({ pid: stranger.pid, start: "an earlier process" }));
    await startEngineRecords(dir, () => {});
    expect(running(live.engine)).toBe(true);
    expect(running(live.child)).toBe(true);
    expect(running(stranger.pid!)).toBe(true);
  });

  it("tags and records what this server starts, and forgets a record once its whole tree is stopped", async () => {
    const dir = dataDir();
    await startEngineRecords(dir, () => {});
    const tag = engineRunTag()!;
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    const child = spawnCli("/bin/sh", ["-c", `echo "$${ENGINE_TAG_ENV}"; exec sleep 60`], { stdio: ["pipe", "pipe", "pipe"] });
    started.push(child);
    let said = "";
    child.stdout.on("data", (chunk) => { said += chunk; });
    await vi.waitFor(() => expect(said.trim()).toBe(tag));
    const records = join(dir, "engine-runs", tag);
    expect(readdirSync(records)).toContain(`${child.pid}.json`);
    expect(await killCliTree(child, 500)).toBe(true);
    await vi.waitFor(() => expect(readdirSync(records)).not.toContain(`${child.pid}.json`));
  });
});
