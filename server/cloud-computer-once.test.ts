// The claim and stop scripts only ever run on the cloud computer, which is Linux. Where this machine has a POSIX sh they
// are run for real, in a throwaway folder; everywhere, Windows included, the app's side (the script it writes, what it
// does with each answer, when it sends again) is tested against a model of the computer that the real shell is checked
// against.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onceCommand, RESEND, retryRead, runOnce, stopCommand, type OnceDeps } from "./cloud-computer-once.ts";
import { createCloudComputerCounters } from "./cloud-computer-counters.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;
const BOX = "bx_23456789";
const KEY = "0123456789abcdef";
/** Git Bash on a Windows runner is not the shell these scripts are written for: paths, `mkdir`, signals and process ids differ. */
const POSIX_SH = process.platform !== "win32";
const ONLY_POSIX = "(POSIX sh only: the script runs on the cloud computer, which is Linux)";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A computer: one folder for its disk, and a log each run of the user's command appends to. */
function computer() {
  const root = mkdtempSync(join(tmpdir(), "omb-once-"));
  dirs.push(root);
  const log = join(root, "ran.log");
  const claims = { disk: join(root, "disk", "omb-once"), memory: join(root, "shm", "omb-once") };
  const sh = (script: string) => {
    try {
      return { exitCode: 0, stdout: execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "" };
    }
  };
  return {
    root, claims, log, sh,
    command: `echo ran >> '${log}'; echo done`,
    runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0),
  };
}

type Answer = { exitCode: number; stdout: string };
const TAKEN = (key: string): Answer => ({ exitCode: 75, stdout: `omb-once:${key}:taken\n` });
const UNCLAIMED = (key: string): Answer => ({ exitCode: 76, stdout: `omb-once:${key}:unclaimed\n` });

/** What the claim script does on the computer, in memory: who may run, by key, by whether a claim can be made, and by
 * whether this copy is a first send or a resend. `claimable: false` is a disk and a /dev/shm that both refuse. */
function modelComputer(options: { claimable?: boolean; exitCode?: number } = {}) {
  const claimed = new Set<string>();
  let runs = 0;
  return {
    runs: () => runs,
    sh(script: string): Answer {
      const key = /^k=([0-9a-f]{16});/.exec(script)?.[1];
      if (!key) throw new Error("not a claim script");
      const resend = script.includes(`echo omb-once:${key}:unclaimed; exit 76`);
      if (claimed.has(key)) return TAKEN(key);
      if (options.claimable === false) { if (resend) return UNCLAIMED(key); } else claimed.add(key);
      runs += 1;
      return { exitCode: options.exitCode ?? 0, stdout: "done\n" };
    },
  };
}

describe("the script a call is sent as", () => {
  const lines = (script: string) => script.split("\n");

  it("claims the call's key on the disk, then in memory, before the command, which comes last and unchanged", () => {
    const script = lines(onceCommand(KEY, 1, "exec make all"));
    expect(script[0]).toBe(`k=${KEY}; a="\${HOME:-/tmp}/.cache/omb-once"; b="/dev/shm/omb-once"`);
    expect(script.at(-1)).toBe("exec make all");
    const claimDisk = script.indexOf('if ! mkdir "$a/$k" 2>/dev/null; then'), claimMemory = script.indexOf('  if ! mkdir "$b/$k" 2>/dev/null; then');
    expect(claimDisk).toBeGreaterThan(0);
    expect(claimMemory).toBeGreaterThan(claimDisk);
    expect(claimMemory).toBeLessThan(script.length - 1);
  });

  it("stops with its own mark and exit code 75 wherever it finds the key already claimed", () => {
    const script = onceCommand(KEY, 1, "true");
    expect(script).toContain(`taken() { echo omb-once:${KEY}:taken; exit 75; }`);
    expect(script).toContain('if [ -d "$a/$k" ] || [ -d "$b/$k" ]; then taken; fi');
    expect(script).toContain('  if [ -d "$a/$k" ]; then taken; fi');
    expect(script).toContain('    if [ -d "$b/$k" ]; then taken; fi');
  });

  it("lets a first send run with no claim, and makes a resend that cannot claim stop with exit code 76", () => {
    expect(onceCommand(KEY, 1, "true")).not.toContain("exit 76");
    for (const attempt of [2, 3, 4]) expect(onceCommand(KEY, attempt, "true")).toContain(`    echo omb-once:${KEY}:unclaimed; exit 76`);
  });

  it("records the shell's process id beside the claim, and the stop script signals only that process and what it started", () => {
    expect(onceCommand(KEY, 1, "true")).toContain('echo $$ > "$a/$k/pid" 2>/dev/null || echo $$ > "$b/$k/pid" 2>/dev/null');
    const stop = stopCommand(KEY);
    expect(stop).toContain(`k=${KEY}; p=; for d in "\${HOME:-/tmp}/.cache/omb-once" "/dev/shm/omb-once"; do if [ -f "$d/$k/pid" ]`);
    expect(stop).toContain('stop() { for c in $(pgrep -P "$1" 2>/dev/null); do stop "$c"; done; kill -TERM "$1" 2>/dev/null; }');
    expect(stop).not.toMatch(/kill[^\n]* -- -|kill -9|pkill/);
  });

  it("clears claims older than a day now and then, never on every call", () => {
    expect(onceCommand("0123456789abcde0", 1, "true")).toContain("-mmin +1440 -exec rmdir {} +");
    expect(onceCommand(KEY, 1, "true")).not.toContain("rmdir");
  });

  it("refuses a key that is not its own kind, since the key is written into the shell", () => {
    expect(() => onceCommand("$(reboot)", 1, "true")).toThrow(RangeError);
    expect(() => stopCommand("$(reboot)")).toThrow(RangeError);
  });
});

describe("who may run, by the claim", () => {
  it.each<[string, { claimable?: boolean }, number[], number[], number]>([
    ["a first send, then a late copy and a resend", {}, [1, 1, 2], [0, 75, 75], 1],
    ["a resend that arrives first, then the hung first send", {}, [2, 1], [0, 75], 1],
    ["nowhere to claim: a first send runs as it always did", { claimable: false }, [1], [0], 1],
    ["nowhere to claim: a resend never runs", { claimable: false }, [2, 3], [76, 76], 0],
  ])("%s", (_name, options, attempts, exitCodes, runs) => {
    const pc = modelComputer(options);
    expect(attempts.map((attempt) => pc.sh(onceCommand(KEY, attempt, "true")).exitCode)).toEqual(exitCodes);
    expect(pc.runs()).toBe(runs);
  });

  it("gives each call its own claim", () => {
    const pc = modelComputer();
    pc.sh(onceCommand(KEY, 1, "true"));
    expect(pc.sh(onceCommand("fedcba9876543210", 1, "true")).exitCode).toBe(0);
    expect(pc.runs()).toBe(2);
  });
});

describe.skipIf(!POSIX_SH)(`a call's claim on the computer ${ONLY_POSIX}`, () => {
  it("decides who may run exactly as the model the other tests use", () => {
    const table: Array<[{ claimable?: boolean }, number[]]> = [[{}, [1, 1, 2]], [{}, [2, 1]], [{ claimable: false }, [1]], [{ claimable: false }, [2, 3]]];
    for (const [options, attempts] of table) {
      const pc = computer(), model = modelComputer(options);
      if (options.claimable === false) { writeFileSync(join(pc.root, "disk"), ""); writeFileSync(join(pc.root, "shm"), ""); }
      const real = attempts.map((attempt) => pc.sh(onceCommand(KEY, attempt, pc.command, pc.claims)));
      expect(real).toEqual(attempts.map((attempt) => model.sh(onceCommand(KEY, attempt, "true"))));
      expect(pc.runs()).toBe(model.runs());
    }
  });

  it("lets the first copy of a call run and stops every later copy before the command", () => {
    const pc = computer();
    const first = pc.sh(onceCommand(KEY, 1, pc.command, pc.claims));
    expect(first).toEqual({ exitCode: 0, stdout: "done\n" });
    const late = pc.sh(onceCommand(KEY, 1, pc.command, pc.claims));
    const resent = pc.sh(onceCommand(KEY, 2, pc.command, pc.claims));
    expect(late).toEqual({ exitCode: 75, stdout: `omb-once:${KEY}:taken\n` });
    expect(resent).toEqual(late);
    expect(pc.runs()).toBe(1);
  });

  it("gives each call its own claim", () => {
    const pc = computer();
    pc.sh(onceCommand(KEY, 1, pc.command, pc.claims));
    expect(pc.sh(onceCommand("fedcba9876543210", 1, pc.command, pc.claims)).exitCode).toBe(0);
    expect(pc.runs()).toBe(2);
  });

  it("claims in memory when the disk refuses, and a later copy still finds that claim", () => {
    const pc = computer();
    writeFileSync(join(pc.root, "disk"), "a file where the folder would go");
    expect(pc.sh(onceCommand(KEY, 2, pc.command, pc.claims)).exitCode).toBe(0);
    expect(pc.sh(onceCommand(KEY, 2, pc.command, pc.claims)).exitCode).toBe(75);
    expect(pc.runs()).toBe(1);
  });

  it("with nowhere to claim, runs a first send as it always did and never runs a resend", () => {
    const pc = computer();
    writeFileSync(join(pc.root, "disk"), "");
    writeFileSync(join(pc.root, "shm"), "");
    expect(pc.sh(onceCommand(KEY, 2, pc.command, pc.claims))).toEqual({ exitCode: 76, stdout: `omb-once:${KEY}:unclaimed\n` });
    expect(pc.runs()).toBe(0);
    expect(pc.sh(onceCommand(KEY, 1, pc.command, pc.claims)).exitCode).toBe(0);
    expect(pc.runs()).toBe(1);
  });

  it("passes the command's own exit code and output through", () => {
    const pc = computer();
    expect(pc.sh(onceCommand(KEY, 1, "echo out; exit 3", pc.claims))).toEqual({ exitCode: 3, stdout: "out\n" });
  });

});

describe.skipIf(!POSIX_SH)(`stopping the command a call started ${ONLY_POSIX}`, () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (check: () => boolean, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 25))) if (check()) return true;
    return false;
  };

  it("ends the command and what it started, by the process id the call recorded, and nothing else", async () => {
    const pc = computer();
    const bystander = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
    const shell = spawn("/bin/sh", ["-c", onceCommand(KEY, 1, "sleep 30 & sleep 30; wait", pc.claims)], { stdio: "ignore" });
    const pidFile = join(pc.claims.disk, KEY, "pid");
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
    expect(Number(readFileSync(pidFile, "utf8"))).toBe(shell.pid);
    const children = () => execFileSync("/bin/sh", ["-c", `pgrep -P ${shell.pid} || true`], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    expect(await until(() => children().length >= 1)).toBe(true);
    const started = children();
    expect(pc.sh(stopCommand(KEY, pc.claims)).exitCode).toBe(0);
    expect(await until(() => !alive(shell.pid!) && started.every((pid) => !alive(pid)))).toBe(true);
    expect(alive(bystander.pid!)).toBe(true);
    bystander.kill();
  });

  it("does nothing, quietly, for a call that recorded no process", () => {
    const pc = computer();
    expect(pc.sh(stopCommand(KEY, pc.claims))).toEqual({ exitCode: 0, stdout: "" });
  });
});

type Sent = { ok: boolean; exitCode: number | null; stdout: string; stderr: string; unanswered?: true; busy?: true };
const UNANSWERED: Sent = { ok: false, exitCode: null, stdout: "", stderr: "", unanswered: true };

/** `gateway(send)` decides, per send, whether the command reaches the computer and whether its answer comes back. */
function relay(gateway: (send: number) => { delivered: boolean; answered: boolean; status?: 503 }, answersProbe: () => boolean = () => true, pc: { sh(script: string): Answer; runs(): number } = modelComputer()) {
  const counters = createCloudComputerCounters();
  let at = 0, sends = 0, probes = 0;
  const waits: number[] = [];
  const deps: Partial<OnceDeps> = {
    key: () => KEY, counters, now: () => at, random: () => 0.5,
    sleep: async (ms) => { waits.push(ms); at += ms; },
    run: async (_cfg, _box, script) => {
      const { delivered, answered, status } = gateway(sends++);
      const out = delivered ? pc.sh(script) : null;
      if (status === 503) return { ok: false, exitCode: null, stdout: "", stderr: "", busy: true as const };
      if (!answered || !out) return UNANSWERED;
      return { ok: out.exitCode === 0, exitCode: out.exitCode, stdout: out.stdout, stderr: "" };
    },
    awaitAnswer: async () => {
      probes++;
      at += 4_000;
      return answersProbe() ? { ok: true, waitedMs: 4_000 } : { ok: false, phase: "restoring", waitedMs: 90_000 };
    },
  };
  const call = () => runOnce(cfg, BOX, "make", { signal: new AbortController().signal, deadline: 120_000 }, deps);
  return { pc, call, counters, sends: () => sends, probes: () => probes, waits };
}

describe("a call the computer did not answer", () => {
  it("is sent again once the computer answers a probe, and runs once when the first copy never arrived", async () => {
    const r = relay((send) => ({ delivered: send > 0, answered: send > 0 }));
    const outcome = await r.call();
    expect(outcome).toMatchObject({ kind: "ran", resent: 1, result: { ok: true, stdout: "done\n" } });
    expect(r.pc.runs()).toBe(1);
    expect(r.probes()).toBe(1);
    expect(r.counters.snapshot(BOX)).toMatchObject({ unanswered: 1, resent: 1 });
  });

  it("is not run a second time when the first copy did arrive and only its answer was lost", async () => {
    const r = relay((send) => ({ delivered: true, answered: send > 0 }));
    await expect(r.call()).resolves.toEqual({ kind: "lost" });
    expect(r.pc.runs()).toBe(1);
    expect(r.counters.snapshot(BOX)).toMatchObject({ lostAnswers: 1 });
  });

  it("is not run a second time when the first copy arrives late, after the resend already ran", async () => {
    const r = relay((send) => ({ delivered: send > 0, answered: send > 0 }));
    await r.call();
    // The hung first send finally reaches the machine.
    const late = r.pc.sh(onceCommand(KEY, 1, "make"));
    expect(late.exitCode).toBe(75);
    expect(r.pc.runs()).toBe(1);
  });

  it("rides out a burst of gateway errors with a growing, varied pause, within its three resends", async () => {
    const r = relay((send) => ({ delivered: send === 3, answered: send === 3 }));
    await expect(r.call()).resolves.toMatchObject({ kind: "ran", resent: 3 });
    expect(r.waits).toEqual(RESEND.backoffMs);
    expect(r.pc.runs()).toBe(1);
  });

  it("stops after three resends and says the computer did not answer", async () => {
    const r = relay(() => ({ delivered: false, answered: false }));
    await expect(r.call()).resolves.toEqual({ kind: "unanswered", phase: "waking" });
    expect(r.sends()).toBe(1 + RESEND.max);
    expect(r.pc.runs()).toBe(0);
  });

  it("does not send again while the computer still gives no answer, and says what it is waiting on", async () => {
    const r = relay(() => ({ delivered: false, answered: false }), () => false);
    await expect(r.call()).resolves.toEqual({ kind: "unanswered", phase: "restoring" });
    expect(r.sends()).toBe(1);
  });

  it("sends again after a 503, and reports cloud computers as unreachable when it never clears", async () => {
    const clears = relay((send) => send === 0 ? { delivered: false, answered: false, status: 503 } : { delivered: true, answered: true });
    await expect(clears.call()).resolves.toMatchObject({ kind: "ran", resent: 1 });
    const stays = relay(() => ({ delivered: false, answered: false, status: 503 }));
    await expect(stays.call()).resolves.toEqual({ kind: "unanswered", phase: "unreachable" });
  });

  it("returns a command that ran and failed as it is, with no resend", async () => {
    const pc = modelComputer({ exitCode: 2 });
    let sends = 0;
    const outcome = await runOnce(cfg, BOX, "exit 2", { signal: new AbortController().signal, deadline: 120_000 }, {
      key: () => KEY, now: () => 0,
      run: async (_cfg, _box, script) => { sends++; const out = pc.sh(script); return { ok: false, exitCode: out.exitCode, stdout: out.stdout, stderr: "" }; },
    });
    expect(outcome).toMatchObject({ kind: "ran", resent: 0, result: { exitCode: 2 } });
    expect(sends).toBe(1);
  });

  it("does not run a resend that can claim nowhere, and says the computer did not answer", async () => {
    const r = relay((send) => ({ delivered: send > 0, answered: send > 0 }), () => true, modelComputer({ claimable: false }));
    await expect(r.call()).resolves.toEqual({ kind: "unanswered", phase: "waking" });
    expect(r.pc.runs()).toBe(0);
  });

  it("answers that the call ran out of time, not a raw error, when a send hangs with no reply until the call's time is up", async () => {
    let at = 0;
    const outcome = await runOnce(cfg, BOX, "make", { signal: new AbortController().signal, deadline: 120_000 }, {
      key: () => KEY, now: () => at,
      run: async (_cfg, _box, _script, opts) => { at += opts.timeoutMs!; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
    });
    expect(outcome).toEqual({ kind: "late" });
  });

  it("stops the command it was following when the person stops the turn, and not when only the call's time runs out", async () => {
    const sentFor = async (stoppedByPerson: boolean) => {
      const turn = new AbortController(), call = new AbortController();
      const sent: string[] = [];
      const pending = runOnce(cfg, BOX, "make", { signal: AbortSignal.any([turn.signal, call.signal]), deadline: Date.now() + 120_000, stopped: turn.signal }, {
        key: () => KEY,
        run: async (_cfg, _box, script, opts) => {
          sent.push(script);
          if (script === stopCommand(KEY)) return { ok: true, exitCode: 0, stdout: "", stderr: "" };
          await new Promise<void>((_resolve, reject) => opts.signal!.addEventListener("abort", () => reject(opts.signal!.reason)));
          throw new Error("unreachable");
        },
      });
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 30_000 });
      (stoppedByPerson ? turn : call).abort();
      await rejected;
      // The stop is sent in the same turn of the event loop as the rejection; one more turn shows whether it was.
      await new Promise((resolve) => setImmediate(resolve));
      return sent.includes(stopCommand(KEY));
    };
    expect(await sentFor(true)).toBe(true);
    expect(await sentFor(false)).toBe(false);
  });

  it("does not treat a refusal thrown before the send as the computer's silence", async () => {
    const refusal = Object.assign(new Error("this cloud computer is being deleted"), { status: 409 });
    await expect(runOnce(cfg, BOX, "true", { signal: new AbortController().signal, deadline: 120_000 }, {
      now: () => 0,
      run: async () => { throw refusal; },
    })).rejects.toBe(refusal);
  });
});

describe("a read the computer did not answer", () => {
  const options = { signal: new AbortController().signal, deadline: 120_000 };
  const quick: Partial<OnceDeps> = { now: () => 0, sleep: async () => {}, random: () => 0.5, counters: createCloudComputerCounters() };

  it("is tried again once the computer answers", async () => {
    let reads = 0;
    const read = async () => { if (reads++ < 2) throw new Error("no answer"); return "frame"; };
    await expect(retryRead(cfg, BOX, read, () => true, options, { ...quick, awaitAnswer: async () => ({ ok: true, waitedMs: 0 }) })).resolves.toEqual({ value: "frame" });
    expect(reads).toBe(3);
  });

  it("says what it was waiting on when the computer never answers, and passes any other error on", async () => {
    await expect(retryRead(cfg, BOX, async () => { throw new Error("no answer"); }, () => true, options,
      { ...quick, awaitAnswer: async () => ({ ok: false, phase: "restoring", waitedMs: 0 }) })).resolves.toEqual({ phase: "restoring" });
    const other = new Error("screen capture failed");
    await expect(retryRead(cfg, BOX, async () => { throw other; }, () => false, options, quick)).rejects.toBe(other);
  });
});

describe.skipIf(!POSIX_SH)(`a call sent again, against the real shell ${ONLY_POSIX}`, () => {
  /** The script as it reaches the computer, with the test's own claim folders in place of the real ones. */
  const onDisk = (pc: ReturnType<typeof computer>) => ({
    runs: pc.runs,
    sh: (script: string) => pc.sh(script.replace('a="${HOME:-/tmp}/.cache/omb-once"; b="/dev/shm/omb-once"', `a="${pc.claims.disk}"; b="${pc.claims.memory}"`).replace(/\nmake$/, `\n${pc.command}`)),
  });

  it("runs the command once when the first copy never arrived", async () => {
    const pc = computer();
    const r = relay((send) => ({ delivered: send > 0, answered: send > 0 }), () => true, onDisk(pc));
    await expect(r.call()).resolves.toMatchObject({ kind: "ran", resent: 1, result: { ok: true, stdout: "done\n" } });
    expect(pc.runs()).toBe(1);
  });

  it("does not run it a second time when only the first copy's answer was lost, or when that copy arrives late", async () => {
    const lost = computer();
    await expect(relay((send) => ({ delivered: true, answered: send > 0 }), () => true, onDisk(lost)).call()).resolves.toEqual({ kind: "lost" });
    expect(lost.runs()).toBe(1);
    const late = computer();
    await relay((send) => ({ delivered: send > 0, answered: send > 0 }), () => true, onDisk(late)).call();
    expect(late.sh(onceCommand(KEY, 1, late.command, late.claims)).exitCode).toBe(75);
    expect(late.runs()).toBe(1);
  });
});
