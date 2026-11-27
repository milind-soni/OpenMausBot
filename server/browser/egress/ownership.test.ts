import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { botEngineSessions, killCliTree, spawnCli } from "../../procs.ts";
import { ListenerOwnership, parseProcNetTcp, procLocalAddress, sessionOfStat, type ProcFiles } from "./ownership.ts";

// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/PortScanner.test.ts, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE).
// /proc/net/tcp: 127.0.0.1:8765 and 0.0.0.0:22 listening, an established connection, a non-loopback listener and
// 127.0.0.1:3000; /proc/net/tcp6 adds [::]:3001 and [::1]:3000.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:223D 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 20 4 30 10 -1
   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5005 1 0000000000000000 100 0 0 10 0
   4: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6001 1 0000000000000000 100 0 0 10 0
`;
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6002 1 0000000000000000 100 0 0 10 0
`;

const stat = (pid: number, session: number, comm = "node") => `${pid} (${comm}) S 1 ${session} ${session} 0 -1 4194560 0 0 0 0`;

function fakeProc(files: Record<string, string>, fds: Record<string, Record<string, string>>): ProcFiles & { walks: string[] } {
  const walks: string[] = [];
  const missing = (path: string) => Promise.reject(Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }));
  return {
    walks,
    readFile: (path) => (path in files ? Promise.resolve(files[path]!) : missing(path)),
    readdir: (path) => {
      if (path === "/proc") return Promise.resolve(["self", ...Object.keys(fds)]);
      const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
      if (!pid || !fds[pid]) return missing(path);
      walks.push(pid);
      return Promise.resolve(Object.keys(fds[pid]!));
    },
    readlink: (path) => {
      const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
      const target = pid && fd ? fds[pid]?.[fd] : undefined;
      return target === undefined ? missing(path) : Promise.resolve(target);
    },
  };
}

describe("Linux listener parsing", () => {
  it("reads loopback and wildcard listeners with their socket inodes", () => {
    expect(parseProcNetTcp(PROC_NET_TCP)).toEqual([
      { port: 8765, inode: "5001" }, { port: 22, inode: "5002" }, { port: 3000, inode: "6001" },
    ]);
    expect(parseProcNetTcp(PROC_NET_TCP6)).toEqual([{ port: 3001, inode: "5004" }, { port: 3000, inode: "6002" }]);
    expect(procLocalAddress("0100007F")).toBe(true);
    expect(procLocalAddress("0A00000F")).toBe(false);
    expect(procLocalAddress(`${"0".repeat(16)}FFFF00000100007F`)).toBe(true);
    expect(procLocalAddress(`${"0".repeat(16)}FFFF00000A00000F`)).toBe(false);
  });

  it("reads the session id after a command name that holds spaces and parentheses", () => {
    expect(sessionOfStat(stat(42, 4242))).toBe(4242);
    expect(sessionOfStat(stat(42, 4242, "npm run (dev) x"))).toBe(4242);
    expect(sessionOfStat("garbage")).toBeNull();
  });
});

describe("whose listener a port is", () => {
  const BOT_ENGINE = 900;
  const ENDED_ENGINE = 901;
  const files = (extra: Record<string, string> = {}) => ({
    "/proc/net/tcp": PROC_NET_TCP,
    "/proc/net/tcp6": PROC_NET_TCP6,
    // A bot's dev server, left running after its shell exited, still carries the engine's session.
    "/proc/4242/stat": stat(4242, BOT_ENGINE),
    "/proc/5151/stat": stat(5151, ENDED_ENGINE),
    "/proc/77/stat": stat(77, 77, "agent-browser"),
    ...extra,
  });
  const fds = {
    "77": { "5": "socket:[5001]" },
    "4242": { "0": "/dev/null", "3": "socket:[6001]", "4": "socket:[6002]" },
    "5151": { "9": "socket:[5004]" },
  };
  const sessions = { live: new Set([BOT_ENGINE]), ended: new Set([ENDED_ENGINE]) };

  it("is a bot's when every listener on it belongs to a bot engine's session", async () => {
    const proc = fakeProc(files(), fds);
    const ownership = new ListenerOwnership({ sessions: () => sessions, proc, platform: "linux" });
    expect(await ownership.botOwned(3000)).toBe(true);
    // agent-browser and Chrome start sessions of their own.
    expect(await ownership.botOwned(8765)).toBe(false);
    // No readable owner.
    expect(await ownership.botOwned(22)).toBe(false);
    expect(await ownership.botOwned(4444)).toBe(false);
  });

  it("keeps an ended engine's session only while its pid is not reused", async () => {
    const free = new ListenerOwnership({ sessions: () => sessions, proc: fakeProc(files(), fds), platform: "linux" });
    expect(await free.botOwned(3001)).toBe(true);
    const reused = new ListenerOwnership({ sessions: () => sessions, proc: fakeProc(files({ [`/proc/${ENDED_ENGINE}/stat`]: stat(ENDED_ENGINE, ENDED_ENGINE, "chrome") }), fds), platform: "linux" });
    expect(await reused.botOwned(3001)).toBe(false);
  });

  it("is not a bot's when another process also listens on it", async () => {
    const shared = { ...fds, "4242": { "3": "socket:[6001]" }, "88": { "1": "socket:[6002]" } };
    const ownership = new ListenerOwnership({ sessions: () => sessions, proc: fakeProc({ ...files(), "/proc/88/stat": stat(88, 88) }, shared), platform: "linux" });
    expect(await ownership.botOwned(3000)).toBe(false);
  });

  it("walks /proc for an owner only once, and looks again soon for a port it has not seen", async () => {
    let now = 0;
    const tables = files();
    const proc = fakeProc(tables, fds);
    const ownership = new ListenerOwnership({ sessions: () => sessions, proc, platform: "linux", now: () => now });
    expect(await ownership.botOwned(3000)).toBe(true);
    const walks = proc.walks.length;
    expect(await ownership.botOwned(3000)).toBe(true);
    expect(proc.walks.length).toBe(walks);
    // A server the bot just started: listed in the table only after the first read.
    tables["/proc/net/tcp"] = `${PROC_NET_TCP}   5: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7001 1 0000000000000000 100 0 0 10 0\n`;
    const fresh = { ...fds, "4242": { ...fds["4242"], "8": "socket:[7001]" } };
    Object.assign(fds, fresh);
    expect(await ownership.botOwned(8000)).toBe(false);
    now = 1_500;
    expect(await ownership.botOwned(8000)).toBe(true);
  });

  it("answers no on other platforms", async () => {
    const ownership = new ListenerOwnership({ sessions: () => sessions, proc: fakeProc(files(), fds), platform: "darwin" });
    expect(await ownership.botOwned(3000)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("finds a real server a bot engine's process opened, and not this process's own", async () => {
    const own = createServer();
    await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
    const engine = spawnCli(process.execPath, ["-e", "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ["pipe", "pipe", "pipe"] }, "bot");
    const service = spawnCli(process.execPath, ["-e", "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ["pipe", "pipe", "pipe"] });
    const portOf = (child: typeof engine) => new Promise<number>((resolve) => child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    try {
      const [enginePort, servicePort] = await Promise.all([portOf(engine), portOf(service)]);
      expect(botEngineSessions().live.has(engine.pid!)).toBe(true);
      const ownership = new ListenerOwnership({ sessions: botEngineSessions });
      expect(await ownership.botOwned(enginePort)).toBe(true);
      expect(await ownership.botOwned(servicePort)).toBe(false);
      expect(await ownership.botOwned((own.address() as AddressInfo).port)).toBe(false);
    } finally {
      await Promise.all([killCliTree(engine), killCliTree(service)]);
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  });
});
