import { describe, expect, it } from "vitest";
import { SPEED_MIN_WINDOW_MS, TURN_START_BUCKETS_MS, createCloudSpeed, parseCpuStat, parsePressureTotal } from "./cloud-speed.ts";

const START = 1_800_000_000_000;

/** /proc/stat as a Fly machine with 2 shared CPUs shows it: user nice system idle iowait irq softirq steal guest guest_nice. */
const stat = (busy: number, idle: number, steal: number) => [
  `cpu  ${busy} 0 0 ${idle} 0 0 0 ${steal} 0 0`,
  `cpu0 ${busy / 2} 0 0 ${idle / 2} 0 0 0 ${steal / 2} 0 0`,
  `cpu1 ${busy / 2} 0 0 ${idle / 2} 0 0 0 ${steal / 2} 0 0`,
  "intr 123456 0 0", "ctxt 987654", "btime 1799990000", "processes 4242", "procs_running 1", "procs_blocked 0", "",
].join("\n");
/** A pressure file; `full` is absent from the cpu file on kernels before 5.13. */
const pressure = (someTotal: number) => `some avg10=1.00 avg60=0.50 avg300=0.25 total=${someTotal}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

/** A machine whose /proc files the test sets, and the clocks the speed reads. */
function machine(files: Record<string, string>, uptimes: { machine: number; process: number } = { machine: 30, process: 4.2 }) {
  let wall = START, mono = 0;
  const speed = createCloudSpeed({ read: (path) => files[path] ?? null, now: () => wall, monotonic: () => mono,
    machineUptime: () => uptimes.machine, processUptime: () => uptimes.process });
  return { speed, files, pass: (ms: number) => { wall += ms; mono += ms; }, now: () => wall };
}

describe("reading /proc", () => {
  it("takes all CPU time and the stolen part from the first line, and nothing from a line it can't read", () => {
    expect(parseCpuStat(stat(600, 300, 100))).toEqual({ total: 1000, steal: 100 });
    // Guest time is counted inside user time already, so it never adds to the total.
    expect(parseCpuStat("cpu  100 0 50 800 0 0 0 50 40 0\n")).toEqual({ total: 1000, steal: 50 });
    // A kernel too old to count steal still gives the total.
    expect(parseCpuStat("cpu  100 0 50 850\n")).toEqual({ total: 1000, steal: null });
    expect(parseCpuStat("")).toBeNull();
    expect(parseCpuStat("cpu  a b c d\n")).toBeNull();
  });

  it("takes the pressure file's cumulative \"some\" stall, in microseconds", () => {
    expect(parsePressureTotal(pressure(123_456))).toBe(123_456);
    expect(parsePressureTotal("full avg10=0.00 avg60=0.00 avg300=0.00 total=9\n")).toBeNull();
    expect(parsePressureTotal("")).toBeNull();
  });
});

describe("CPU steal and pressure", () => {
  it("is the share of CPU time stolen and of wall time stalled since the last read, a minute or more ago", () => {
    const m = machine({ "/proc/stat": stat(1000, 8000, 0), "/proc/pressure/cpu": pressure(0), "/proc/pressure/memory": pressure(0), "/proc/pressure/io": pressure(0) });
    m.pass(300_000);
    m.files["/proc/stat"] = stat(1000 + 3000, 8000 + 1000, 1000);
    m.files["/proc/pressure/cpu"] = pressure(45_000_000);
    m.files["/proc/pressure/memory"] = pressure(3_000_000);
    m.files["/proc/pressure/io"] = pressure(0);
    expect(m.speed.report()).toMatchObject({ windowS: 300, steal: 20, psi: { cpu: 15, memory: 1, io: 0 } });
    // A read a few seconds later (a paged answer) keeps those figures and leaves the window where it was.
    m.pass(5_000);
    m.files["/proc/stat"] = stat(4000, 9000, 1100);
    expect(m.speed.report()).toMatchObject({ windowS: 300, steal: 20 });
    // The next window starts where the last full one ended, so the steal seen in between counts in it.
    m.pass(SPEED_MIN_WINDOW_MS);
    m.files["/proc/stat"] = stat(4900, 9900, 1200);
    expect(m.speed.report()).toMatchObject({ windowS: 65, steal: 10 });
  });

  it("reads a container's own cgroup pressure before the whole machine's", () => {
    const m = machine({ "/proc/stat": stat(1000, 1000, 0), "/sys/fs/cgroup/cpu.pressure": pressure(0), "/proc/pressure/cpu": pressure(0) });
    m.pass(100_000);
    m.files["/sys/fs/cgroup/cpu.pressure"] = pressure(50_000_000);
    m.files["/proc/pressure/cpu"] = pressure(1_000_000);
    expect(m.speed.report().psi.cpu).toBe(50);
  });

  it("says null for pressure the kernel doesn't expose, and for steal without /proc/stat (not Linux)", () => {
    const m = machine({ "/proc/stat": stat(1000, 1000, 0) });
    m.pass(100_000);
    m.files["/proc/stat"] = stat(2000, 1500, 500);
    expect(m.speed.report()).toMatchObject({ steal: 25, psi: { cpu: null, memory: null, io: null } });
    const bare = machine({});
    bare.pass(100_000);
    expect(bare.speed.report()).toMatchObject({ windowS: 100, steal: null, psi: { cpu: null, memory: null, io: null } });
  });

  it("says nothing for a window whose counters went down (wrapped or reset), then counts again from there", () => {
    const m = machine({ "/proc/stat": stat(9_000, 9_000, 900), "/proc/pressure/cpu": pressure(80_000_000) });
    m.pass(100_000);
    m.files["/proc/stat"] = stat(100, 100, 10);
    m.files["/proc/pressure/cpu"] = pressure(1_000);
    expect(m.speed.report()).toMatchObject({ steal: null, psi: { cpu: null } });
    m.pass(100_000);
    m.files["/proc/stat"] = stat(1_100, 1_000, 110);
    m.files["/proc/pressure/cpu"] = pressure(10_001_000);
    expect(m.speed.report()).toMatchObject({ steal: 5, psi: { cpu: 10 } });
  });
});

describe("boot and wake", () => {
  it("is null until the server listens, then this process's start to listening", () => {
    const m = machine({});
    expect(m.speed.report()).toMatchObject({ bootMs: null, wakeMs: null });
    m.speed.ready();
    expect(m.speed.report()).toMatchObject({ bootMs: 4200, wakeMs: null });
  });

  it("times a wake from the machine's start when the process started with it, to the waiting request reaching the server", () => {
    const m = machine({}, { machine: 9.5, process: 4.2 });
    m.speed.ready();
    m.pass(300);
    m.speed.wakeRequest(m.now());
    expect(m.speed.report().wakeMs).toBe(9_800);
    m.pass(1_000);
    m.speed.wakeRequest(m.now());
    expect(m.speed.report().wakeMs).toBe(9_800);
  });

  it("times it from the process's start in a container on a server up for days", () => {
    const m = machine({}, { machine: 400_000, process: 6 });
    m.speed.ready();
    m.speed.wakeRequest(m.now() + 100);
    expect(m.speed.report().wakeMs).toBe(6_100);
  });

  it("is no wake when the first request came long after the boot (the Admin woke it with nothing waiting)", () => {
    const m = machine({}, { machine: 9.5, process: 4.2 });
    m.speed.ready();
    m.pass(60_000);
    m.speed.wakeRequest(m.now());
    expect(m.speed.report().wakeMs).toBeNull();
  });
});

describe("turn starts", () => {
  const person = { role: "user" as const, kind: "text" as const };
  const started = (threadId: string) => ({ type: "turn.started" as const, threadId });
  const completed = (threadId: string) => ({ type: "turn.completed" as const, threadId });
  const buckets = (counts: Record<number, number>) => Array.from({ length: TURN_START_BUCKETS_MS.length + 1 }, (_, index) => counts[index] ?? 0);

  it("counts how long a person's message waited for its engine's turn to start, in fixed buckets", () => {
    const m = machine({});
    for (const [thread, waited] of [["a", 120], ["b", 900], ["c", 4_000], ["d", 40_000]] as const) {
      m.speed.noteMessage(thread, { ...person, at: m.now() });
      m.pass(waited);
      m.speed.noteEvent(started(thread));
    }
    expect(m.speed.report().turnStarts).toEqual(buckets({ 0: 1, 1: 1, 3: 1, 5: 1 }));
  });

  it("leaves out a message sent while its thread runs a turn, a bot's, a peer's, a routine's and a steer, and counts the thread again once it is idle", () => {
    const m = machine({});
    m.speed.noteEvent(started("a"));
    m.speed.noteMessage("a", { ...person, at: m.now() });
    m.speed.noteMessage("b", { role: "bot", kind: "text", at: m.now() });
    m.speed.noteMessage("c", { ...person, at: m.now(), from: { botId: "peer" } as never });
    m.speed.noteMessage("d", { ...person, at: m.now(), steered: true });
    m.speed.noteMessage("e", { ...person, at: m.now(), automation: {} as never });
    m.pass(30_000);
    for (const thread of ["b", "c", "d", "e"]) m.speed.noteEvent(started(thread));
    m.speed.noteEvent(completed("a"));
    m.speed.noteEvent(started("a"));
    expect(m.speed.report().turnStarts).toEqual(buckets({}));
    m.speed.noteEvent(completed("a"));
    m.speed.noteMessage("a", { ...person, at: m.now() });
    m.pass(1_500);
    m.speed.noteEvent(started("a"));
    expect(m.speed.report().turnStarts).toEqual(buckets({ 2: 1 }));
  });

  it("drops a message whose turn never started", () => {
    const m = machine({});
    m.speed.noteMessage("a", { ...person, at: m.now() });
    m.pass(31 * 60_000);
    m.speed.noteEvent(started("a"));
    expect(m.speed.report().turnStarts).toEqual(buckets({}));
  });
});
