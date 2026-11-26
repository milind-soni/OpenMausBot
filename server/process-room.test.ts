import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnNotStartedError, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener, type SendTurnInput } from "./contracts.ts";
import { engineFailureKind } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import { EngineMemory, FIRST_FRAME_MS, readHostMemory, withEngineMemory, type HostMemory } from "./engine-memory.ts";
import { containerLimited, readCgroupMemory, readPids, readProcessLimits } from "./process-limits.ts";
import { BROWSER_NO_ROOM, BROWSER_TASKS, ENGINE_TASKS, engineTasks, gateHost, linuxTreeUse, margin, ProcessBudget, turnsSetting, turnsUnder, type TreeUse } from "./process-room.ts";
import { outOfProcesses, shortageCode } from "./process-shortage.ts";
import { describeSpawnFailure, linuxGroupOnlyExited } from "./procs.ts";
import { classifyRoutineFailure, recoverRun, ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.ts";
import type { RoutineRun } from "./routines.ts";

const MB = 1024 * 1024, GB = 1024 * MB;
const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

describe("the container's limits, from Linux's own files", () => {
  it("reads the pids limit and the count against it: cgroup v2, a cgroup that is not the mount's root, and v1", () => {
    expect(readPids(files({ "/sys/fs/cgroup/pids.max": "512\n", "/sys/fs/cgroup/pids.current": "31\n" }))).toEqual({ max: 512, current: 31 });
    expect(readPids(files({ "/sys/fs/cgroup/pids.max": "max\n", "/sys/fs/cgroup/pids.current": "31\n" }))).toEqual({ max: "max", current: 31 });
    expect(readPids(files({ "/proc/self/cgroup": "0::/system.slice/omb.service\n", "/sys/fs/cgroup/system.slice/omb.service/pids.max": "4096\n",
      "/sys/fs/cgroup/system.slice/omb.service/pids.current": "40\n", "/sys/fs/cgroup/pids.current": "9000\n" }))).toEqual({ max: 4096, current: 40 });
    expect(readPids(files({ "/proc/self/cgroup": "5:cpu,cpuacct:/\n3:pids:/\n", "/sys/fs/cgroup/pids/pids.max": "1024\n", "/sys/fs/cgroup/pids/pids.current": "77\n" }))).toEqual({ max: 1024, current: 77 });
    expect(readPids(() => null)).toEqual({ max: null, current: null });
  });

  it("reads the memory limit and what counts against it, leaving out file pages the kernel can drop", () => {
    const v2 = files({ "/sys/fs/cgroup/memory.max": "2147483648\n", "/sys/fs/cgroup/memory.current": "1500000000\n", "/sys/fs/cgroup/memory.stat": "anon 900000000\ninactive_file 400000000\n",
      "/sys/fs/cgroup/memory.events": "low 0\noom 3\noom_kill 2\n", "/sys/fs/cgroup/memory.pressure": "some avg10=1.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n" });
    expect(readCgroupMemory(v2)).toEqual({ limitBytes: 2 * GB, usedBytes: 1_100_000_000, oomKills: 2, fullStall10: 0.5 });
    expect(readCgroupMemory(files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": "5\n" }))).toBeNull();
    const v1 = files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824\n", "/sys/fs/cgroup/memory/memory.usage_in_bytes": "600000000\n",
      "/sys/fs/cgroup/memory/memory.stat": "total_inactive_file 100000000\n", "/sys/fs/cgroup/memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n" });
    expect(readCgroupMemory(v1)).toEqual({ limitBytes: GB, usedBytes: 500_000_000, oomKills: 1, fullStall10: null });
    expect(readCgroupMemory(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n", "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1\n" }))).toBeNull();
  });

  it("gives the gate the container's memory, not the machine's: a 2 GB container on a 64 GB host has 2 GB", () => {
    const host = { "/proc/meminfo": "MemTotal:       67108864 kB\nMemAvailable:   60000000 kB\nSwapFree:        8388608 kB\n", "/proc/vmstat": "oom_kill 40\n" };
    const container = { ...host, "/sys/fs/cgroup/memory.max": String(2 * GB), "/sys/fs/cgroup/memory.current": String(1536 * MB), "/sys/fs/cgroup/memory.stat": "inactive_file 0\n", "/sys/fs/cgroup/memory.events": "oom_kill 1\n" };
    const read = (map: Record<string, string>) => (path: string) => { if (path in map) return map[path]!; throw new Error("ENOENT"); };
    expect(readHostMemory(read(container))).toEqual({ totalBytes: 2 * GB, availableBytes: 512 * MB, swapFreeBytes: 0, oomKills: 1, fullStall10: null });
    // No limit below the machine's memory: the machine's numbers, as before.
    expect(readHostMemory(read(host))).toMatchObject({ totalBytes: 67108864 * 1024, swapFreeBytes: 8388608 * 1024, oomKills: 40 });
    expect(readHostMemory(read({ ...host, "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": "1\n" }))).toMatchObject({ totalBytes: 67108864 * 1024 });
  });

  it("says what process 1 is and whether anything collects orphans, and is all unknown where Linux's files are not there", () => {
    const base = { "/sys/fs/cgroup/pids.max": "512\n", "/sys/fs/cgroup/pids.current": "30\n", "/proc/self/limits": "Limit  Soft Limit  Hard Limit  Units\nMax processes             unlimited            unlimited            processes \n" };
    const stat = (pid: number, parent: number) => `${pid} (node) S ${parent} ${pid} ${pid} 0 -1`;
    expect(readProcessLimits({ platform: "linux", pid: 14, shm: () => 64 * MB, read: files({ ...base, "/proc/1/comm": "tini\n" }) }))
      .toEqual({ pidsMax: 512, pidsCurrent: 30, nproc: "unlimited", shmBytes: 64 * MB, pid1: "init", reaper: "yes" });
    expect(readProcessLimits({ platform: "linux", pid: 14, shm: () => null, read: files({ ...base, "/proc/1/comm": "MainThread\n", "/proc/14/comm": "node\n", "/proc/14/stat": stat(14, 1) }) }))
      .toMatchObject({ pid1: "node", reaper: "no", shmBytes: "unknown" });
    // The launcher as process 1 with the image's tini beneath it.
    expect(readProcessLimits({ platform: "linux", pid: 14, shm: () => null, read: files({ ...base, "/proc/1/comm": "node\n", "/proc/14/comm": "node\n", "/proc/14/stat": stat(14, 13), "/proc/13/comm": "tini\n", "/proc/13/stat": stat(13, 1) }) }))
      .toMatchObject({ pid1: "node", reaper: "yes" });
    expect(readProcessLimits({ platform: "linux", pid: 14, shm: () => null, read: files({ "/proc/1/comm": "start.sh\n", "/proc/self/limits": "Max processes             4096                 4096                 processes \n" }) }))
      .toEqual({ pidsMax: "unknown", pidsCurrent: "unknown", nproc: 4096, shmBytes: "unknown", pid1: "other", reaper: "unknown" });
    for (const platform of ["darwin", "win32"] as const) {
      expect(readProcessLimits({ platform, read: () => { throw new Error("nothing is read"); }, shm: () => { throw new Error("nothing is read"); } }))
        .toEqual({ pidsMax: "unknown", pidsCurrent: "unknown", nproc: "unknown", shmBytes: "unknown", pid1: "unknown", reaper: "unknown" });
    }
  });
});

describe("where turns wait for room, and the one setting", () => {
  it("reads OMB_TURNS_MAX_RUNNING as a number, off, or the container's own limits", () => {
    expect(turnsSetting("12")).toBe(12);
    expect(turnsSetting(" off ")).toBe("off");
    expect(turnsSetting("0")).toBe("off");
    for (const value of [undefined, "", "auto", "-3", "2.5", "many"]) expect(turnsSetting(value)).toBe("auto");
  });

  it("is on for a Cloud home and for a self-hosted Linux server in a container with a limit, never for the desktop app, and elsewhere only when asked for", () => {
    const limited = () => true, open = () => false;
    expect(gateHost({}, "linux", limited)).toBe("server");
    expect(gateHost({}, "linux", open)).toBeNull();
    expect(gateHost({ OMB_TURNS_MAX_RUNNING: "auto" }, "linux", open)).toBe("server");
    expect(gateHost({ OMB_TURNS_MAX_RUNNING: "8" }, "linux", open)).toBe("server");
    expect(gateHost({ OMB_CLOUD_ROLE: "home" }, "linux", open)).toBe("cloud");
    expect(gateHost({ OMB_CLOUD_ROLE: "team", OMB_TURNS_MAX_RUNNING: "off" }, "linux", open)).toBe("cloud");
    expect(gateHost({ OMB_DESKTOP_PARENT: "1" }, "linux", limited)).toBeNull();
    expect(gateHost({ OMB_DESKTOP_PARENT: "1", OMB_TURNS_MAX_RUNNING: "4" }, "linux", limited)).toBeNull();
    expect(gateHost({ OMB_TURNS_MAX_RUNNING: "off" }, "linux", limited)).toBeNull();
    for (const platform of ["darwin", "win32"] as const) {
      expect(gateHost({}, platform, () => { throw new Error("nothing is read off Linux"); })).toBeNull();
      expect(gateHost({ OMB_TURNS_MAX_RUNNING: "6" }, platform, open)).toBe("server");
    }
  });

  it("knows a container that was given a limit by the files at its cgroup root, and a machine's own root by their absence", () => {
    expect(containerLimited(files({ "/sys/fs/cgroup/pids.max": "512\n", "/sys/fs/cgroup/memory.max": "max\n" }))).toBe(true);
    expect(containerLimited(files({ "/sys/fs/cgroup/pids.max": "max\n", "/sys/fs/cgroup/memory.max": "4294967296\n" }))).toBe(true);
    expect(containerLimited(files({ "/sys/fs/cgroup/pids/pids.max": "1024\n" }))).toBe(true);
    expect(containerLimited(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648\n" }))).toBe(true);
    expect(containerLimited(files({ "/sys/fs/cgroup/pids.max": "max\n", "/sys/fs/cgroup/memory.max": "max\n" }))).toBe(false);
    expect(containerLimited(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" }))).toBe(false);
    // A server under systemd on a plain machine: its limits sit in its own cgroup's directory, not at the root.
    expect(containerLimited(files({ "/proc/self/cgroup": "0::/system.slice/omb.service\n", "/sys/fs/cgroup/system.slice/omb.service/pids.max": "4915\n" }))).toBe(false);
    expect(containerLimited(() => null)).toBe(false);
  });

  it("fits engines under a pids limit with a tenth of it, and at least 32, kept back", () => {
    expect([margin(100), margin(512), margin(4096)]).toEqual([32, 51, 410]);
    expect([turnsUnder(128), turnsUnder(512), turnsUnder(1024), turnsUnder(2048), turnsUnder(4096)]).toEqual([1, 7, 14, 30, 60]);
  });
});

describe("the pids budget", () => {
  const budget = (state: { max: number | "max" | null; current: number | null }) => {
    let clock = 1_000_000;
    const logs: string[] = [];
    const made = new ProcessBudget({ read: () => state, now: () => clock, log: (line) => logs.push(line) });
    return { made, logs, advance: (ms: number) => { clock += ms; } };
  };

  it("has room while the count, what is promised to engines still starting and one more engine stay under the limit less its margin", () => {
    const state = { max: 512 as number | "max" | null, current: 300 as number | null };
    const { made, advance } = budget(state);
    expect(made.short(ENGINE_TASKS, 0)).toBe(false);
    expect(made.short(ENGINE_TASKS, 60)).toBe(false);
    expect(made.short(ENGINE_TASKS, 120)).toBe(true);
    state.current = 402; advance(1_000);
    expect(made.short(ENGINE_TASKS, 0)).toBe(true);
    expect(made.limit()).toBe(512);
  });

  it("holds nothing back where no limit is set or readable: not Linux, a hidden /sys, pids.max of max", () => {
    for (const state of [{ max: null, current: null }, { max: "max" as const, current: 9_000 }, { max: 512, current: null }]) {
      const { made } = budget(state);
      expect(made.short(ENGINE_TASKS, 10_000)).toBe(false);
    }
    expect(budget({ max: null, current: null }).made.limit()).toBeNull();
  });

  it("learns the limit from the first refused spawn where none is readable (one set on a pod, above the container)", () => {
    const state = { max: "max" as number | "max" | null, current: 1_020 as number | null };
    const { made, logs, advance } = budget(state);
    let woken = 0;
    made.onRefused(() => { woken += 1; });
    made.spawnFailed("EAGAIN");
    expect(made.limit()).toBe(1_020);
    expect(woken).toBe(1);
    expect(logs).toEqual(["a spawn was refused (EAGAIN) with 1020 processes and threads running; new work now waits below that count"]);
    advance(60_000);
    state.current = 500;
    expect(made.short(ENGINE_TASKS, 0)).toBe(false);
    state.current = 900; advance(1_000);
    expect(made.short(ENGINE_TASKS, 0)).toBe(true);
    made.spawnFailed("EAGAIN");
    expect(logs).toHaveLength(1);
    // A limit the container shows is the one in force, whatever a refusal looked like.
    const shown = budget({ max: 4096, current: 300 });
    shown.made.spawnFailed("EAGAIN");
    expect(shown.made.limit()).toBe(4096);
  });

  it("starts nothing for half a minute after a spawn refused for open files or memory, and counts every refusal by its code", () => {
    const { made, advance } = budget({ max: 4096, current: 100 });
    made.spawnFailed("EMFILE");
    expect(made.short(ENGINE_TASKS, 0)).toBe(true);
    advance(31_000);
    expect(made.short(ENGINE_TASKS, 0)).toBe(false);
    made.spawnFailed("ENOENT"); made.spawnFailed(undefined); made.spawnFailed("EACCES"); made.spawnFailed("ENOMEM");
    made.noteForceKilled(); made.noteLateReaped(); made.noteLateReaped();
    expect(made.short(ENGINE_TASKS, 0)).toBe(true);
    expect(made.counts()).toEqual({ limit: 4096, spawnFailed: { EAGAIN: 0, EMFILE: 1, ENFILE: 0, ENOMEM: 1, ENOENT: 1, other: 2 }, forceKilled: 1, lateReaped: 2 });
  });
});

describe("an engine's own size against the pids limit", () => {
  it("counts Grok's runtime threads, a pre-warmed pool of 16 and a worker per CPU, beside every other engine's usual size", () => {
    expect(engineTasks("grokAgent", 4)).toBe(ENGINE_TASKS + 16 + 4);
    expect(engineTasks("grokAgent", 16)).toBe(ENGINE_TASKS + 32);
    expect(engineTasks("codex", 16)).toBe(ENGINE_TASKS);
  });

  it("holds a Grok engine still starting at its own size, so fewer others start beside it", async () => {
    // pids.max 256 keeps 32 back: 26 running, a Grok engine of 80 and one of 60 promised, and a third of 60 would pass 224.
    const grok = server({ pids: 256, turns: 100 });
    expect(await grok.memory.admit("grok", new AbortController().signal, () => {}, "process", undefined, engineTasks("grokAgent", 4))).toBe(true);
    expect(await grok.memory.admit("a", new AbortController().signal, () => {})).toBe(true);
    const stop = new AbortController(), notices: string[] = [];
    const third = grok.memory.admit("b", stop.signal, (text) => notices.push(text));
    await settle();
    expect(notices).toHaveLength(1);
    stop.abort();
    expect(await third).toBe(false);

    const generic = server({ pids: 256, turns: 100 });
    for (const thread of ["first", "a", "b"]) expect(await generic.memory.admit(thread, new AbortController().signal, () => {})).toBe(true);
  });
});

describe("a spawn the system refused is the server's shortage, not the AI's failure", () => {
  const refused = (code: string) => Object.assign(new Error(`spawn /usr/local/bin/claude ${code}`), { code });

  it("says so in one plain line that names no program, for the codes that mean no room", () => {
    for (const code of ["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"]) {
      const failure = describeSpawnFailure(refused(code), "claude", "/data/work");
      expect(failure).toEqual({ message: `There is no room to start another program (${code}), so this task could not run. Nothing was sent to the AI. It starts again by itself when there is room.`,
        setup: false, text: { key: "chat.notice.outOfProcesses", params: { code } } });
      expect(failure.message).not.toContain("claude");
      expect(outOfProcesses(failure.message)).toBe(true);
      expect(shortageCode(refused(code))).toBe(code);
    }
    expect(describeSpawnFailure(refused("ENOENT"), "claude").setup).toBe(true);
    expect(shortageCode(refused("ENOENT"))).toBeNull();
    expect(shortageCode(new Error("EAGAIN in words only"))).toBeNull();
  });

  it("knows Node's own words for it too, and nothing else", () => {
    expect(outOfProcesses("spawn failed: spawn /app/engine EAGAIN")).toBe(true);
    expect(outOfProcesses("spawn git EMFILE")).toBe(true);
    expect(outOfProcesses("Error: spawn ENOMEM")).toBe(true);
    for (const other of ["claude exited 1 before result", "getaddrinfo EAI_AGAIN api.example.test", "Resource temporarily unavailable", "spawn claude ENOENT", ""]) expect(outOfProcesses(other)).toBe(false);
  });

  it("reads only the head of a failure: an engine that crashed with a file watcher's EMFILE in its stderr ran, and may go to a backup", () => {
    for (const crash of [
      "claude exited 1 before result: Error: EMFILE: too many open files, watch '/data/work'\n    at FSWatcher.<computed>",
      "claude exited 1 before result: [warn] watcher\nError: spawn npx EAGAIN",
      "The AI stopped before it answered.\nThere is no room to start another program (EAGAIN), so this task could not run.",
    ]) expect(outOfProcesses(crash)).toBe(false);
  });

  it("is never read as a usage limit, a rate limit or a transient AI error, so nothing is retried on a model or handed to a backup", () => {
    const text = describeSpawnFailure(refused("EAGAIN"), "claude").message;
    expect(classifyError({ text })).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError({ text: "spawn failed: spawn /app/engine EAGAIN" })).toEqual({ transient: false, reason: "unknown" });
    expect(engineFailureKind(text)).toBeFalsy();
  });

  it("makes a routine's run wait and start again, as for a busy bot, instead of failing or using up its one retry", () => {
    expect(classifyRoutineFailure(describeSpawnFailure(refused("EAGAIN"), "claude").message)).toEqual({ kind: "busy" });
    expect(classifyRoutineFailure("spawn failed: spawn /app/engine ENOMEM", { cause: "refused" })).toEqual({ kind: "busy" });
    expect(classifyRoutineFailure("claude exited 1 before result")).toEqual({ kind: "retry", cause: "failed" });
  });
});

describe("a process group that holds only exited processes", () => {
  const stat = (pid: number, state: string, group: number) => `${pid} (sleep one) ${state} 1 ${group} ${group} 0 -1`;
  const table = (rows: Record<number, string>) => [() => [...Object.keys(rows), "self", "cpuinfo"], (pid: number) => { if (rows[pid] === undefined) throw new Error("gone"); return rows[pid]!; }] as const;

  it("counts as gone: nothing collects a zombie where Node is a container's process 1, and kill(-group, 0) succeeds for it for good", () => {
    expect(linuxGroupOnlyExited(500, ...table({ 501: stat(501, "Z", 500), 502: stat(502, "Z", 500), 9: stat(9, "S", 9) }))).toBe(true);
    expect(linuxGroupOnlyExited(500, ...table({ 501: stat(501, "Z", 500), 502: stat(502, "X", 500) }))).toBe(true);
  });

  it("is still there while any member runs, and is not called gone when no member is found or /proc can't be read", () => {
    expect(linuxGroupOnlyExited(500, ...table({ 501: stat(501, "Z", 500), 502: stat(502, "S", 500) }))).toBe(false);
    expect(linuxGroupOnlyExited(500, ...table({ 9: stat(9, "Z", 9) }))).toBe(false);
    expect(linuxGroupOnlyExited(500, () => { throw new Error("EACCES"); })).toBe(false);
  });
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid: number;
  /** A pipe's count of what the process wrote; null: a process with no stdout of its own to watch. */
  readonly stdout: { bytesRead: number } | null;
  constructor(pid: number, piped = true) { super(); this.pid = pid; this.stdout = piped ? { bytesRead: 0 } : null; }
  exit(signal: NodeJS.Signals | null = null) {
    if (signal) this.signalCode = signal; else this.exitCode = 0;
    this.emit("exit", this.exitCode, signal);
  }
}

/** A self-hosted server in a container: `pids` is its pids.max, each engine holds 44 against it, and memory is plentiful
 * unless the test says otherwise. */
function server(options: { pids?: number | "max" | null; turns?: number | "auto"; total?: number; available?: number; perEngine?: number; host?: "server" | "cloud";
  tree?: (pid: number) => TreeUse | null } = {}) {
  let clock = 1_800_000_000_000, nextPid = 1000;
  const children = new Map<number, FakeChild>();
  const signals: string[] = [];
  const perEngine = options.perEngine ?? 300 * MB;
  const state = { base: 26, total: options.total ?? 64 * GB, available: options.available ?? 60 * GB };
  const pids = options.pids === undefined ? 512 : options.pids;
  const budget = new ProcessBudget({ read: () => ({ max: pids, current: pids === null ? null : state.base + children.size * 44 }), now: () => clock, log: () => {} });
  /** Each engine's tree: idle with no child unless the test says otherwise. */
  const trees = new Map<number, TreeUse>();
  const memory = new EngineMemory({
    enabled: true, host: options.host ?? "server", turns: options.turns ?? "auto", processes: budget, tickMs: 5,
    tree: options.tree ?? ((pid) => (children.has(pid) ? trees.get(pid) ?? { cpuMs: 0, children: 0 } : null)),
    read: (): HostMemory => ({ totalBytes: state.total, availableBytes: Math.max(0, state.available - children.size * perEngine), swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }),
    groups: () => new Map([...children.keys()].map((pid) => [pid, perEngine])),
    now: () => clock, log: () => {},
    signal: (pid, signal) => {
      signals.push(`${signal} -${pid}`);
      const child = children.get(pid);
      if (child && child.exitCode === null && child.signalCode === null) queueMicrotask(() => child.exit(signal));
    },
  });
  const spawn = (threadId: string, piped = true) => memory.within(threadId, () => {
    const child = new FakeChild(nextPid++, piped);
    children.set(child.pid, child);
    child.once("exit", () => children.delete(child.pid));
    memory.track(child as unknown as ChildProcess);
    return child;
  });
  /** One turn admitted and its engine started, as the adapter does. */
  const start = async (threadId: string) => {
    const turn = await memory.admit(threadId, new AbortController().signal, () => {}, "turn");
    const engine = memory.hasEngine(threadId) || await memory.admit(threadId, new AbortController().signal, () => {}, "process");
    memory.turnStarted(threadId);
    if (!memory.hasEngine(threadId)) spawn(threadId);
    return turn && engine;
  };
  return { memory, budget, children, signals, state, trees, spawn, start, advance: (ms: number) => { clock += ms; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("a self-hosted server's turns at once", () => {
  it("defaults to what its pids limit and its memory hold at an engine's usual size, whichever is fewer", () => {
    expect(server({ pids: 512 }).memory.most()).toBe(7);
    expect(server({ pids: 4096 }).memory.most()).toBe(60);
    // A 4 GB container: 410 MB kept back, 700 MB an engine.
    expect(server({ pids: 4096, total: 4 * GB, available: 3 * GB }).memory.most()).toBe(5);
    expect(server({ pids: "max", total: 2 * GB, available: 1 * GB }).memory.most()).toBe(2);
    expect(server({ pids: 512, turns: 3 }).memory.most()).toBe(3);
    expect(server({ pids: 512, turns: 40 }).memory.most()).toBe(40);
  });

  it("sets no number on a Cloud home, whose plan and memory decide as before, and reads no pids limit there", async () => {
    const cloud = server({ pids: 128, host: "cloud" });
    expect(cloud.memory.most()).toBeUndefined();
    expect(cloud.memory.limited()).toBe(false);
    for (const thread of ["a", "b", "c", "d", "e", "f"]) {
      expect(await cloud.memory.admit(thread, new AbortController().signal, () => { throw new Error("no wait on a Cloud for pids"); })).toBe(true);
      cloud.memory.turnStarted(thread); cloud.spawn(thread);
    }
    expect(cloud.memory.idleEnginesAllowed()).toBe(Infinity);
  });

  it("queues the turn past the number, saying it waits on this server, and starts it when one ends", async () => {
    const s = server({ pids: 4096, turns: 2 });
    expect(await s.start("a")).toBe(true);
    expect(await s.start("b")).toBe(true);
    const said: Array<{ limit?: number; server?: boolean; ahead: number }> = [];
    s.memory.useWaits({ text: (_thread, wait) => { said.push({ limit: wait.limit, server: wait.server, ahead: wait.ahead }); return "waiting"; }, began: () => {}, changed: () => {} });
    const third = s.memory.admit("c", new AbortController().signal, () => {}, "turn");
    await settle();
    expect(said).toEqual([{ limit: 2, server: true, ahead: 0 }]);
    expect(s.memory.counts()).toMatchObject({ running: 2, queued: 1, most: 2, queuedEver: 1 });
    s.memory.turnEnded("a");
    expect(await third).toBe(true);
    expect(s.memory.counts()).toMatchObject({ queued: 0, queuedEver: 1 });
  });
});

describe("a burst of turns under a limit on turns", () => {
  it("starts the ones that got a place, though the rest queued before their engines were let in, and then the rest in turn", async () => {
    const s = server({ pids: 4096, turns: 2 });
    const order: string[] = [];
    // Every turn asks for its place first; only then do the two that got one ask for room for their engines.
    const places = ["a", "b", "c", "d", "e"].map((thread) => s.memory.admit(thread, new AbortController().signal, () => {}, "turn").then(() => thread));
    await settle();
    expect(s.memory.counts()).toMatchObject({ running: 2, queued: 3 });
    for (const thread of ["a", "b"]) {
      expect(await s.memory.admit(thread, new AbortController().signal, () => { throw new Error(`${thread} holds a place and has room: no wait`); }, "process")).toBe(true);
      s.memory.turnStarted(thread); s.spawn(thread); order.push(thread);
    }
    s.memory.turnEnded("a");
    expect(await Promise.race(places.slice(2))).toBe("c");
    expect(await s.memory.admit("c", new AbortController().signal, () => {}, "process")).toBe(true);
    s.memory.turnStarted("c"); s.spawn("c"); order.push("c");
    for (const thread of ["b", "c"]) s.memory.turnEnded(thread);
    await settle();
    for (const thread of ["d", "e"]) { expect(await s.memory.admit(thread, new AbortController().signal, () => {}, "process")).toBe(true); s.memory.turnStarted(thread); s.spawn(thread); order.push(thread); }
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
    for (const thread of ["d", "e"]) s.memory.turnEnded(thread);
    await Promise.all(places);
  });
});

describe("room under the pids limit", () => {
  it("lets engines start while their processes fit, then stops one nobody is using, oldest first, to fit the next", async () => {
    // 512 allowed, 51 kept back, 26 the server's: engines of 44 fit while 26 + 44n + what is promised + 60 stays within 461.
    const s = server({ pids: 512, turns: 40 });
    for (const thread of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
      expect(await s.start(thread)).toBe(true);
      s.advance(21_000);
    }
    expect(s.signals).toEqual([]);
    expect(s.children.size).toBe(9);
    // 26 + 9 × 44 = 422; a tenth engine's 60 would pass 461. "a" and "b" are done and their engines idle.
    s.memory.turnEnded("a"); s.memory.turnEnded("b");
    expect(await s.start("j")).toBe(true);
    expect(s.signals).toEqual(["SIGTERM -1000"]);
    expect(s.memory.hasEngine("a")).toBe(false);
    expect(s.memory.hasEngine("b")).toBe(true);
  });

  it("makes the turn wait, saying so, when every engine is working, and starts it when one ends", async () => {
    const s = server({ pids: 512, turns: 40 });
    for (const thread of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) { await s.start(thread); s.advance(21_000); }
    const notices: string[] = [];
    const ninth = s.memory.admit("j", new AbortController().signal, (text) => notices.push(text), "process");
    await settle();
    expect(notices).toHaveLength(1);
    expect(s.signals).toEqual([]);
    s.memory.turnEnded("c");
    expect(await ninth).toBe(true);
    expect(s.signals).toEqual(["SIGTERM -1002"]);
  });

  it("counts engines let in but not yet running, so a burst does not all start at once", async () => {
    const s = server({ pids: 512, turns: 40 });
    const admitted: string[] = [];
    const turns = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(async (thread) => {
      if (await s.memory.admit(thread, new AbortController().signal, () => {}, "process")) admitted.push(thread);
    });
    await settle();
    // Nothing has started, so the count still reads 26: seven promised engines of 60 fit under 461, an eighth does not.
    expect(admitted).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    for (const thread of admitted) s.memory.turnEnded(thread);
    await Promise.all(turns);
  });

  it("keeps room for one more browser while starts are pending, not one for each bot that may browse", async () => {
    const s = server({ pids: 512, turns: 40 });
    s.memory.useBrowsers({ starts: () => true, running: () => false, stopped: () => {} });
    const admitted: string[] = [];
    const turns = ["a", "b", "c", "d", "e", "f"].map(async (thread) => {
      if (await s.memory.admit(thread, new AbortController().signal, () => {}, "process")) admitted.push(thread);
    });
    await settle();
    // 26 now, 60 for each engine promised and 170 for one browser: four fit under 461 (one each would have let in one).
    expect(admitted).toEqual(["a", "b", "c", "d"]);
    for (const thread of ["a", "b", "c", "d", "e", "f"]) s.memory.turnEnded(thread);
    await Promise.all(turns);
  });

  it("never holds back the only task, and holds nothing where no pids limit can be read", async () => {
    const full = server({ pids: 64, turns: 40 });
    expect(await full.start("a")).toBe(true);
    const open = server({ pids: null, turns: 40 });
    for (const thread of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) expect(await open.start(thread)).toBe(true);
    expect(open.signals).toEqual([]);
  });

  it("holds new engines back after the kernel refused a spawn, at the count it refused at", async () => {
    const s = server({ pids: "max", turns: 40 });
    for (const thread of ["a", "b", "c", "d", "e"]) { await s.start(thread); s.advance(21_000); }
    // 26 + 5 × 44 = 246 when the sixth engine's spawn is refused: the limit sits above the container, unreadable.
    s.budget.spawnFailed("EAGAIN");
    expect(s.budget.limit()).toBe(246);
    s.advance(31_000);
    const notices: string[] = [];
    const sixth = s.memory.admit("f", new AbortController().signal, (text) => notices.push(text), "process");
    await settle();
    expect(notices).toHaveLength(1);
    // It was full with five: 32 are kept back, so a new engine's 60 fit once three have gone.
    s.memory.turnEnded("a"); s.memory.turnEnded("b");
    await settle();
    expect(s.signals).toEqual(["SIGTERM -1000", "SIGTERM -1001"]);
    s.memory.turnEnded("c");
    expect(await sixth).toBe(true);
    expect(s.signals).toEqual(["SIGTERM -1000", "SIGTERM -1001", "SIGTERM -1002"]);
    // Half an hour with no further refusal and the learned limit is forgotten.
    s.advance(31 * 60_000);
    expect(s.budget.limit()).toBeNull();
  });

  it("keeps no more engines idle than fit beside the ones working", async () => {
    const s = server({ pids: 512 });
    expect(s.memory.idleEnginesAllowed()).toBe(7);
    for (const thread of ["a", "b", "c"]) { await s.start(thread); s.advance(6_000); }
    expect(s.memory.idleEnginesAllowed()).toBe(4);
    for (const thread of ["d", "e", "f", "g"]) { await s.start(thread); s.advance(6_000); }
    expect(s.memory.idleEnginesAllowed()).toBe(1);
  });
});

describe("a new engine that never comes up", () => {
  afterEach(() => { vi.useRealTimers(); });

  function fakeInstance(driverKind = "claudeAgent", capabilities: Record<string, unknown> = {}) {
    const listeners = new Set<RuntimeEventListener>();
    const sent: string[] = [];
    const interrupted: string[] = [];
    const instance = {
      instanceId: "one", driverKind, displayName: "Engine", enabled: true, continuationIdentity: { driverKind, continuationKey: "k" },
      snapshot: { getSnapshot: () => ({}), refresh: async () => ({}) }, models: [],
      adapter: {
        provider: driverKind, capabilities: { sessionModelSwitch: "unsupported", ...capabilities },
        onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        sendTurn: async (input: SendTurnInput) => { sent.push(input.threadId); return { turnId: `turn-${input.threadId}` }; },
        interruptTurn: async (threadId: string) => { interrupted.push(threadId); },
        stopAll: async () => {},
      },
    } as unknown as ProviderInstance;
    const emit = (event: Record<string, unknown>) => { for (const listener of listeners) listener({ eventId: "e", provider: driverKind, createdAt: "", ...event } as RuntimeEvent); };
    return { instance, sent, interrupted, emit };
  }

  /** An adapter whose sendTurn starts its engine, as spawnCli does inside the driver's own sendTurn. */
  function spawning(s: ReturnType<typeof server>, driverKind = "claudeAgent") {
    const fake = fakeInstance(driverKind);
    const send = fake.instance.adapter.sendTurn;
    (fake.instance.adapter as { sendTurn: typeof send }).sendTurn = async (input) => { if (!s.memory.hasEngine(input.threadId)) s.spawn(input.threadId); return send(input); };
    const decorated = withEngineMemory(fake.instance, s.memory);
    const seen: RuntimeEvent[] = [];
    decorated.adapter.onEvent((event) => seen.push(event));
    return { ...fake, decorated, seen, failure: () => (seen.find((event) => event.type === "runtime.error") as (RuntimeEvent & { message: string }) | undefined)?.message };
  }

  const NO_ROOM = "There is no room to start another program (EAGAIN), so this task could not run. Nothing was sent to the AI. It starts again by itself when there is room.";

  it("is stopped after a minute and a half with nothing on its stdout while the pids limit is full, and its turn fails as one the server had no room for", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 512 });
    const turn = spawning(s);
    await turn.decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    // Other work fills the container: 474 of 512, past the 51 kept back.
    s.state.base = 430;
    // The driver's own "turn started" is not the engine speaking.
    turn.emit({ type: "turn.started", threadId: "t1", turnId: "turn-t1" });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS - 1_000);
    expect(s.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.signals).toEqual(["SIGKILL -1000"]);
    expect(s.memory.stoppedForRoom("t1")).toBe(true);
    expect(s.memory.counts().starvedEver).toBe(1);
    // Not a refused spawn: nothing is counted as one, and no limit is learned from it.
    expect(s.budget.counts().spawnFailed.EAGAIN).toBe(0);
    // The driver reports its engine's exit in its own words; the person reads the server's one line instead.
    turn.emit({ type: "runtime.error", threadId: "t1", turnId: "turn-t1", message: "claude exited null before result" });
    turn.emit({ type: "turn.completed", threadId: "t1", turnId: "turn-t1", ok: false, stopReason: "exit_before_result", cost: null });
    expect(turn.failure()).toBe(NO_ROOM);
    expect(outOfProcesses(turn.failure()!)).toBe(true);
    expect(turn.interrupted).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
  });

  it("holds an engine that admits itself (ACP) to the same deadline when a spawn was refused meanwhile, and a start it gives up on names the server's shortage", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 4096 });
    const fake = fakeInstance("geminiAgent", { engineAdmission: true });
    let fail: ((error: Error) => void) | null = null;
    (fake.instance.adapter as { sendTurn: (input: SendTurnInput) => Promise<{ turnId: string }> }).sendTurn = async (input) => {
      await input.engineAdmission?.("process");
      s.spawn(input.threadId);
      // An ACP turn that may go to a backup answers only once the engine's handshake settles.
      return new Promise((_resolve, reject) => { fail = reject; });
    };
    const decorated = withEngineMemory(fake.instance, s.memory);
    decorated.adapter.onEvent(() => {});
    const turn = decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    const caught = turn.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    // The server's own spawn of something else is refused while the engine starts.
    s.memory.spawnRefused("EAGAIN");
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS);
    expect(s.signals).toEqual(["SIGKILL -1000"]);
    fail!(new TurnNotStartedError("turn-t1", "Gemini exited before it answered initialize"));
    const error = await caught;
    expect(error).toBeInstanceOf(TurnNotStartedError);
    expect((error as Error).message).toBe(NO_ROOM);
    expect(outOfProcesses((error as Error).message)).toBe(true);
  });

  it("names memory when memory is what is short", async () => {
    vi.useFakeTimers();
    const s = server({ pids: "max", total: 4 * GB, available: 3 * GB });
    const turn = spawning(s);
    await turn.decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    s.state.available = 500 * MB;
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS + 1_000);
    expect(s.signals).toEqual(["SIGKILL -1000"]);
    turn.emit({ type: "turn.completed", threadId: "t1", turnId: "turn-t1", ok: false, stopReason: "exit_before_result", cost: null });
    expect(turn.failure()).toBe(NO_ROOM.replace("EAGAIN", "ENOMEM"));
    expect(outOfProcesses(turn.failure()!)).toBe(true);
    expect(s.budget.limit()).toBeNull();
  });

  it("is left alone with no sign of a shortage, however long it is silent (a cold npx start, a slow first start): its driver's own timeout decides", async () => {
    vi.useFakeTimers();
    // A container with only a memory limit (pids.max reads "max"), plenty of it free, three engines already running.
    const s = server({ pids: "max", total: 8 * GB, available: 7 * GB });
    const before = s.memory.most();
    for (const thread of ["a", "b", "c"]) { await s.start(thread); s.children.get([...s.children.keys()].at(-1)!)!.stdout!.bytesRead = 100; }
    s.memory.expectFrame("d");
    await s.start("d");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.signals).toEqual([]);
    expect(s.memory.stoppedForRoom("d")).toBe(false);
    expect(s.budget.limit()).toBeNull();
    expect(s.memory.most()).toBe(before);
    expect(s.memory.counts().starvedEver).toBe(0);
  });

  it("is left alone on a Cloud home where nothing is short, an ACP engine that takes minutes to answer initialize among them", async () => {
    vi.useFakeTimers();
    const s = server({ host: "cloud" });
    const fake = fakeInstance("customAcp", { engineAdmission: true });
    (fake.instance.adapter as { sendTurn: (input: SendTurnInput) => Promise<unknown> }).sendTurn = async (input) => {
      await input.engineAdmission?.("process"); s.spawn(input.threadId); return new Promise(() => {});
    };
    const decorated = withEngineMemory(fake.instance, s.memory);
    decorated.adapter.onEvent(() => {});
    void decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(s.signals).toEqual([]);
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
  });

  it("is left alone under a real shortage while its processes still work or a child runs (npx installing), and stopped once they are idle", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 512 });
    const turn = spawning(s);
    await turn.decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    s.state.base = 430;
    // Busy: a second of CPU every few seconds.
    let cpuMs = 0;
    const busy = setInterval(() => { cpuMs += 1_000; s.trees.set(1000, { cpuMs, children: 0 }); }, 2_000);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(s.signals).toEqual([]);
    clearInterval(busy);
    // Idle itself, but its npx child still runs.
    s.trees.set(1000, { cpuMs, children: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.signals).toEqual([]);
    s.trees.set(1000, { cpuMs, children: 0 });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.signals).toEqual(["SIGKILL -1000"]);
  });

  it("is never stopped as silent where its processes can't be read", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 512, tree: () => null });
    const turn = spawning(s);
    await turn.decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    s.state.base = 430;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.signals).toEqual([]);
  });

  it("is left alone once it has written anything, when its thread's engine was already running, for a process with no stdout, and for an engine that keeps no session", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 4096 });
    const fake = fakeInstance();
    const send = fake.instance.adapter.sendTurn;
    (fake.instance.adapter as { sendTurn: typeof send }).sendTurn = async (input) => {
      if (!s.memory.hasEngine(input.threadId)) s.spawn(input.threadId).stdout!.bytesRead = 312;
      return send(input);
    };
    const decorated = withEngineMemory(fake.instance, s.memory);
    decorated.adapter.onEvent(() => {});
    await decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    // A shortage all along: none of these is stopped for it.
    s.memory.spawnRefused("EMFILE");
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS * 3);
    fake.emit({ type: "turn.completed", threadId: "t1", turnId: "turn-t1", ok: true, stopReason: "end_turn", cost: null });
    await vi.advanceTimersByTimeAsync(10);
    // The same thread again: its engine is still up, and a slow model is not a missing engine.
    await decorated.adapter.sendTurn({ threadId: "t1", text: "again" } as SendTurnInput);
    s.memory.spawnRefused("EMFILE");
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS * 3);
    // A process with no stdout to watch, and one started for a turn on an engine that may say nothing until its answer.
    s.memory.expectFrame("t3");
    s.spawn("t3", false);
    const quiet = fakeInstance("piAgent");
    const send2 = quiet.instance.adapter.sendTurn;
    (quiet.instance.adapter as { sendTurn: typeof send2 }).sendTurn = async (input) => { s.spawn(input.threadId); return send2(input); };
    const pi = withEngineMemory(quiet.instance, s.memory);
    pi.adapter.onEvent(() => {});
    await pi.adapter.sendTurn({ threadId: "t4", text: "hi" } as SendTurnInput);
    // Nor another process the same turn starts after its engine.
    await decorated.adapter.sendTurn({ threadId: "t5", text: "hi" } as SendTurnInput);
    s.spawn("t5");
    s.memory.spawnRefused("EMFILE");
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS * 3);
    expect(s.signals).toEqual([]);
    expect(s.memory.counts().starvedEver).toBe(0);
  });

  it("tells a driver its exited engine was stopped for room only for the process this gate stopped, so any other exit may be sent again", async () => {
    vi.useFakeTimers();
    const s = server({ pids: 512 });
    const turn = spawning(s);
    await turn.decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    s.state.base = 430;
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS + 1_000);
    expect(s.memory.stoppedForRoom("t1", 1000)).toBe(true);
    expect(s.memory.stoppedForRoom("t1", 1001)).toBe(false);
    // A memory stop of an earlier turn is not this one's.
    s.memory.turnStarted("t1");
    expect(s.memory.stoppedForRoom("t1", 1000)).toBe(false);
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
  });
  it("admits each engine at its own size: a Grok start waits where an engine of the usual size fits", async () => {
    // Under pids.max 256, 120 and a busy engine's 44 running: one more of the usual 60 reaches the 224 below the margin,
    // Grok's runtime threads pass it.
    const send = async (driverKind: string) => {
      const s = server({ pids: 256, turns: 100 });
      s.state.base = 120;
      expect(await s.start("busy")).toBe(true);
      // Its processes are all there by now, so nothing more is held for it.
      s.advance(6_000);
      const decorated = withEngineMemory(fakeInstance(driverKind).instance, s.memory), notices: string[] = [];
      decorated.adapter.onEvent((event) => { if (event.type === "runtime.notice") notices.push(event.message); });
      return { decorated, notices, turn: decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput) };
    };
    const usual = await send("claudeAgent");
    expect(await usual.turn).toEqual({ turnId: "turn-t1" });
    expect(usual.notices).toEqual([]);
    const grok = await send("grokAgent");
    const caught = grok.turn.catch((error: unknown) => error);
    await settle();
    expect(grok.notices).toHaveLength(1);
    await grok.decorated.adapter.interruptTurn("t1", "turn-t1");
    expect(await caught).toBeInstanceOf(TurnNotStartedError);
  });
});

describe("a spawn refused during a turn", () => {
  const NO_ROOM = "There is no room to start another program (EAGAIN), so this task could not run. Nothing was sent to the AI. It starts again by itself when there is room.";

  it("fails the turn whose own engine's spawn the system refused as the server's shortage, and only that thread's", () => {
    const s = server({ pids: 4096 });
    s.memory.turnStarted("t1"); s.memory.turnStarted("t2"); s.memory.turnStarted("t3");
    s.memory.within("t1", () => s.memory.spawnRefused("EAGAIN", true));
    s.memory.within("t2", () => s.memory.spawnRefused("ENOENT", true));
    // A refusal of some other spawn in a turn (a probe, a helper) is a sign of a shortage, never that turn's failure.
    s.memory.within("t3", () => s.memory.spawnRefused("EAGAIN"));
    s.memory.spawnRefused("EMFILE", true);
    expect([s.memory.stoppedForRoom("t1"), s.memory.stoppedForRoom("t2"), s.memory.stoppedForRoom("t3")]).toEqual([true, false, false]);
    expect(s.memory.stopFailure("t1")?.message).toBe(NO_ROOM);
    s.memory.turnEnded("t1");
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
  });

  it("is forgotten once a later spawn in the same turn works: the turn goes on, and its end is its own", () => {
    const s = server({ pids: 4096 });
    s.memory.turnStarted("t1");
    s.memory.within("t1", () => s.memory.spawnRefused("EAGAIN", true));
    s.spawn("t1");
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
    expect(s.memory.stopFailure("t1", "claude exited 1 before result: Error: boom")).toBeNull();
  });

  it("outside a running turn is never carried into the thread's next one", () => {
    const s = server({ pids: 4096 });
    s.memory.turnStarted("t1");
    s.memory.turnEnded("t1");
    // A spawn from a timer the last turn armed.
    s.memory.within("t1", () => s.memory.spawnRefused("EAGAIN", true));
    s.memory.turnStarted("t1");
    expect(s.memory.stoppedForRoom("t1")).toBe(false);
    expect(s.memory.stopFailure("t1")).toBeNull();
  });

  it("never relabels a failure that names its own cause: a usage limit stays a usage limit, and a routine does not wait on it as busy", () => {
    const s = server({ pids: 4096 });
    s.memory.turnStarted("t1");
    s.memory.within("t1", () => s.memory.spawnRefused("EAGAIN", true));
    const limit = "You've hit your usage limit · resets 5pm";
    expect(s.memory.stopFailure("t1", limit)).toBeNull();
    expect(classifyRoutineFailure(limit)).not.toEqual({ kind: "busy" });
    // A failure in the engine's words of nothing in particular is still the shortage's.
    expect(s.memory.stopFailure("t1", "claude exited null before result")?.message).toBe(NO_ROOM);
  });

  it("keeps a usage-limit refusal of the turn's start what it is", async () => {
    const s = server({ pids: 4096 });
    const instance = {
      instanceId: "one", driverKind: "claudeAgent", displayName: "Engine", enabled: true, continuationIdentity: { driverKind: "claudeAgent", continuationKey: "k" },
      snapshot: { getSnapshot: () => ({}), refresh: async () => ({}) }, models: [],
      adapter: {
        provider: "claudeAgent", capabilities: { sessionModelSwitch: "unsupported" }, onEvent: () => () => {},
        sendTurn: async () => { s.memory.spawnRefused("EAGAIN", true); throw new TurnNotStartedError("turn-t1", "You've hit your usage limit · resets 5pm"); },
        interruptTurn: async () => {}, stopAll: async () => {},
      },
    } as unknown as ProviderInstance;
    const error = await withEngineMemory(instance, s.memory).adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("You've hit your usage limit · resets 5pm");
  });

  it("does not explain a turn the person stopped, nor one after a refusal from before it began", async () => {
    const s = server({ pids: 4096 });
    const listeners = new Set<RuntimeEventListener>();
    const instance = {
      instanceId: "one", driverKind: "claudeAgent", displayName: "Engine", enabled: true, continuationIdentity: { driverKind: "claudeAgent", continuationKey: "k" },
      snapshot: { getSnapshot: () => ({}), refresh: async () => ({}) }, models: [],
      adapter: {
        provider: "claudeAgent", capabilities: { sessionModelSwitch: "unsupported" },
        onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        sendTurn: async (input: SendTurnInput) => ({ turnId: `turn-${input.threadId}` }),
        interruptTurn: async () => {}, stopAll: async () => {},
      },
    } as unknown as ProviderInstance;
    const decorated = withEngineMemory(instance, s.memory);
    const seen: RuntimeEvent[] = [];
    decorated.adapter.onEvent((event) => seen.push(event));
    const stop = (threadId: string) => { for (const listener of listeners) listener({ eventId: "e", provider: "claudeAgent", createdAt: "", type: "turn.completed", threadId, turnId: `turn-${threadId}`, ok: false, stopReason: "interrupted", cost: null } as RuntimeEvent); };
    s.memory.within("t1", () => s.memory.spawnRefused("EAGAIN", true));
    await decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    stop("t1");
    // Refused in the turn, then the person stopped it.
    await decorated.adapter.sendTurn({ threadId: "t2", text: "hi" } as SendTurnInput);
    s.memory.within("t2", () => s.memory.spawnRefused("EAGAIN", true));
    stop("t2");
    expect(seen.filter((event) => event.type === "runtime.error")).toEqual([]);
  });

  it("holds a routine run of checked items that waits for room to the same hour as any other run", () => {
    const now = 1_800_000_000_000;
    const run = () => ({ id: "r1", routineId: "x", target: "bot", botId: "b", status: "running", checkKey: "k", deferredAt: now - ROUTINE_BUSY_WAIT_MS }) as unknown as RoutineRun;
    expect(recoverRun(run(), NO_ROOM, {}, now, [])).toMatchObject({ queued: false });
    // Its bot busy with the person: it waits as long as that takes, as before.
    expect(recoverRun(run(), "busy", { cause: "busy" }, now, [])).toEqual({ queued: true });
  });
});

describe("browsers under the pids limit", () => {
  afterEach(() => { vi.useRealTimers(); });

  function room(current: { value: number }, measured: { value: number | null }, running: Set<string>) {
    const budget = new ProcessBudget({ read: () => ({ max: 1024, current: current.value }), browserTasks: () => measured.value, log: () => {}, pollMs: 100 });
    return { budget, room: budget.browserRoom((session) => running.has(session)) };
  }

  it("opens one only where its processes fit, waits a while for room, then says why it cannot", async () => {
    vi.useFakeTimers();
    // 1,024 allowed, 102 kept back: 922 to work in.
    const current = { value: 700 }, measured = { value: 0 }, running = new Set<string>();
    const { room: browsers } = room(current, measured, running);
    expect(await browsers.enter("bot-a")).toBeNull();
    // bot-a's browser counts at its full size though the count does not show it yet: 700 + 170 + 170 > 922.
    const second = browsers.enter("bot-b");
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await second).toBe(BROWSER_NO_ROOM);
    // Once it runs and the count shows it, it is counted once.
    running.add("bot-a");
    current.value = 700 + BROWSER_TASKS; measured.value = BROWSER_TASKS;
    expect(await browsers.enter("bot-a")).toBeNull();
    current.value = 400 + BROWSER_TASKS;
    expect(await browsers.enter("bot-b")).toBeNull();
  });

  it("holds each running browser's room against new engines for as long as it runs, and frees it when it closes", async () => {
    vi.useFakeTimers();
    const current = { value: 500 }, measured = { value: 40 }, running = new Set<string>(["bot-a"]);
    const { budget, room: browsers } = room(current, measured, running);
    expect(await browsers.enter("bot-a")).toBeNull();
    // 500 now, of which the browser shows 40 while it starts: 130 more are held for it, and an engine's 60 still fit (690 of 922).
    expect(budget.short(ENGINE_TASKS, 0)).toBe(false);
    current.value = 750;
    expect(budget.short(ENGINE_TASKS, 0)).toBe(true);
    // Long after it started, still running at 40 threads: still held at its full size.
    vi.advanceTimersByTime(10 * 60_000);
    expect(budget.short(ENGINE_TASKS, 0)).toBe(true);
    running.delete("bot-a"); measured.value = 0; current.value = 710;
    vi.advanceTimersByTime(2_000);
    expect(budget.short(ENGINE_TASKS, 0)).toBe(false);
  });

  it("reads each browser and engine tree from /proc's own rows", () => {
    const row = (pid: number, ppid: number, name: string, cpuMs: number, state = "S", threads = 1) => ({ pid, ppid, name, cpuMs, rssBytes: 0, start: "1", threads, state });
    const rows = [row(10, 1, "claude", 500), row(11, 10, "npm exec", 2_000), row(12, 11, "node", 300), row(13, 10, "sh", 0, "Z"), row(20, 1, "node", 9_000)];
    expect(linuxTreeUse(10, () => rows, () => 100)).toEqual({ cpuMs: 2_900, children: 2 });
    expect(linuxTreeUse(99, () => rows, () => 0)).toBeNull();
  });
});
