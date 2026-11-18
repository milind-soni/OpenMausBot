// A browser's pid file counts a process as that bot's browser only once the process is checked to be the session's own
// agent-browser daemon: a stale file (the volume outlived an OOM kill or a machine stop) never names init, the supervisor,
// this server or an unrelated program.
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { browserDaemonRuns } from "../browser-processes.ts";
import { attributeRows } from "../perf/bot-footprint.ts";
import { linuxProcessList } from "../perf/process-sampler.ts";
import { createBrowserDaemons } from "./browser-daemons.ts";

const MB = 1_048_576, PAGE = 4096;
const BINARY = "/opt/agent-browser/bin/agent-browser";
const stat = (pid: number, comm: string, ppid: number, { pgid = pid, sid = pid, start = 1000 + pid, rssMB = 10 } = {}) =>
  `${pid} (${comm}) S ${ppid} ${pgid} ${sid} 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000000 ${(rssMB * MB) / PAGE} 18446744073709551615`;

/** A Cloud after a restart: tini (1) runs the supervisor (50), which runs this server (100); postgres (900) runs beside it;
 * the session bot-a's daemon is 500 with its Chrome 501. */
function cloud(overrides: Record<string, string | null> = {}) {
  const files: Record<string, string | null> = {
    "/proc/1/stat": stat(1, "tini", 0, { pgid: 1, sid: 1 }), "/proc/1/cmdline": "tini\0--\0supervisor\0", "/proc/1/environ": "HOME=/data\0",
    "/proc/50/stat": stat(50, "supervisor", 1, { pgid: 1, sid: 1 }), "/proc/50/cmdline": "supervisor\0", "/proc/50/environ": "HOME=/data\0",
    "/proc/100/stat": stat(100, "node", 50, { pgid: 1, sid: 1, rssMB: 300 }), "/proc/100/cmdline": "node\0server/index.ts\0",
    "/proc/100/environ": "HOME=/data\0AGENT_BROWSER_SESSION=bot-a\0",
    "/proc/500/stat": stat(500, "agent-browser", 1), "/proc/500/cmdline": `${BINARY}\0`,
    "/proc/500/environ": "HOME=/data\0AGENT_BROWSER_DAEMON=1\0AGENT_BROWSER_SESSION=bot-a\0",
    "/proc/501/stat": stat(501, "chrome", 500, { pgid: 501, sid: 500, rssMB: 400 }),
    "/proc/900/stat": stat(900, "postgres", 1, { rssMB: 800 }), "/proc/900/cmdline": "postgres\0", "/proc/900/environ": "HOME=/var/lib/postgresql\0",
    ...overrides,
  };
  const read = (path: string) => files[path] ?? null;
  const rows = linuxProcessList(read, () => Object.keys(files).flatMap((path) => /^\/proc\/(\d+)\/stat$/.exec(path)?.[1] ?? [])).rows;
  return { read, rows, daemons: createBrowserDaemons({ platform: "linux", read, self: 100, parent: 50 }) };
}

describe("a browser's daemon, checked before it counts", () => {
  it("counts the session's own daemon with its start, and so its Chrome", () => {
    const { daemons, rows } = cloud();
    const owner = daemons.owner(BINARY, "bot-a", 500);
    expect(owner).toEqual({ pid: 500, start: "1500" });
    expect(attributeRows(rows, [{ ...owner!, botIds: ["bot_a"], kind: "browser" }]).bots.get("bot_a")?.pids).toEqual([500, 501]);
  });

  it("never counts a stale pid file naming init, the supervisor, this server or an unrelated program", () => {
    const { daemons, rows } = cloud();
    for (const pid of [1, 50, 100, 900, 4242, 0, -1, Number.NaN]) expect(daemons.owner(BINARY, "bot-a", pid)).toBeNull();
    // Had the supervisor counted, everything under it (this server among it) would be bot A's.
    const owners = [50, 100, 900].flatMap((pid) => { const owner = daemons.owner(BINARY, "bot-a", pid); return owner ? [{ ...owner, botIds: ["bot_a"], kind: "browser" as const }] : []; });
    expect(attributeRows(rows, owners).bots.size).toBe(0);
  });

  it("refuses another session's daemon, another program at the daemon's pid, and a daemon whose environment can't be read", () => {
    expect(cloud().daemons.owner(BINARY, "bot-b", 500)).toBeNull();
    expect(cloud().daemons.owner("/usr/bin/other", "bot-a", 500)).toBeNull();
    expect(cloud({ "/proc/500/environ": null }).daemons.owner(BINARY, "bot-a", 500)).toBeNull();
    expect(cloud({ "/proc/500/cmdline": null }).daemons.owner(BINARY, "bot-a", 500)).toBeNull();
  });

  it("keeps a check with the pid's start: the pid given to another program since is checked again and refused", () => {
    const files: Record<string, string | null> = {};
    const base = cloud();
    let reads = 0;
    const read = (path: string) => { if (path.endsWith("/environ")) reads += 1; return path in files ? files[path]! : base.read(path); };
    const daemons = createBrowserDaemons({ platform: "linux", read, self: 100, parent: 50 });
    expect(daemons.owner(BINARY, "bot-a", 500)).toEqual({ pid: 500, start: "1500" });
    expect(daemons.owner(BINARY, "bot-a", 500)).toEqual({ pid: 500, start: "1500" });
    // Read once: a sample (or the memory watchdog every few seconds) reads only the pid's stat line after that.
    expect(reads).toBe(1);
    Object.assign(files, { "/proc/500/stat": stat(500, "postgres", 1, { start: 99_999 }), "/proc/500/cmdline": "postgres\0", "/proc/500/environ": "HOME=/x\0" });
    expect(daemons.owner(BINARY, "bot-a", 500)).toBeNull();
    expect(reads).toBe(2);
  });
});

describe("a browser's daemon, checked on real processes", () => {
  const started: ChildProcess[] = [];
  afterEach(() => { for (const child of started.splice(0)) child.kill("SIGKILL"); });
  const run = (env: Record<string, string>) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, ...env }, stdio: "ignore" });
    started.push(child);
    return child;
  };
  /** Asks until an answer other than null comes or the deadline passes: off Linux the check runs in the background. */
  async function settled(ask: () => unknown, ms = 10_000): Promise<unknown> {
    let answer = ask();
    for (const end = Date.now() + ms; answer === null && Date.now() < end; answer = ask()) await new Promise((resolve) => setTimeout(resolve, 100));
    return answer;
  }

  it.runIf(process.platform !== "win32")("counts a real daemon of the session and not a stale pid file naming another program or this process", async () => {
    const daemon = run({ AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_SESSION: "bot-real" });
    const unrelated = run({});
    const checked: number[] = [];
    const daemons = createBrowserDaemons({ check: async (binary, pid, session) => { try { return await browserDaemonRuns(binary, pid, session); } finally { checked.push(pid); } } });
    expect(await settled(() => daemons.owner(process.execPath, "bot-real", daemon.pid!))).toMatchObject({ pid: daemon.pid });
    // A stale file naming a running program that is no daemon: once checked (in the background off Linux), refused.
    expect(daemons.owner(process.execPath, "stale", unrelated.pid!)).toBeNull();
    if (process.platform !== "linux") await settled(() => (checked.includes(unrelated.pid!) ? true : null));
    expect(daemons.owner(process.execPath, "stale", unrelated.pid!)).toBeNull();
    // This server and its parent are never asked about at all.
    expect(daemons.owner(process.execPath, "self", process.pid)).toBeNull();
    expect(daemons.owner(process.execPath, "parent", process.ppid)).toBeNull();
    expect(checked).not.toContain(process.pid);
  }, 30_000);
});
