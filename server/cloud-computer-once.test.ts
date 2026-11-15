// The claim script is run for real, by this machine's own sh in a throwaway folder, standing in for the computer's shell.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { onceCommand, RESEND, retryRead, runOnce, stopCommand, type OnceDeps } from "./cloud-computer-once.ts";
import { createCloudComputerCounters } from "./cloud-computer-counters.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;
const BOX = "bx_23456789";
const KEY = "0123456789abcdef";
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

describe("a call's claim on the computer", () => {
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

  it("refuses a key that is not its own kind, since the key is written into the shell", () => {
    expect(() => onceCommand("$(reboot)", 1, "true")).toThrow(RangeError);
  });
});

describe("stopping the command a call started", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (check: () => boolean, ms = 10_000) => {
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
    expect(() => stopCommand("$(reboot)")).toThrow(RangeError);
  });
});

type Sent = { ok: boolean; exitCode: number | null; stdout: string; stderr: string; unanswered?: true; busy?: true };
const UNANSWERED: Sent = { ok: false, exitCode: null, stdout: "", stderr: "", unanswered: true };

/** `gateway(send)` decides, per send, whether the command reaches the computer and whether its answer comes back. */
function relay(gateway: (send: number) => { delivered: boolean; answered: boolean; status?: 503 }, answersProbe: () => boolean = () => true) {
  const pc = computer();
  const counters = createCloudComputerCounters();
  let at = 0, sends = 0, probes = 0;
  const waits: number[] = [];
  const deps: Partial<OnceDeps> = {
    key: () => KEY, counters, now: () => at, random: () => 0.5,
    sleep: async (ms) => { waits.push(ms); at += ms; },
    run: async (_cfg, _box, script) => {
      const { delivered, answered, status } = gateway(sends++);
      // What reaches the computer is the script with the test's own claim folders in place of the real ones.
      const out = delivered ? pc.sh(script.replace('a="${HOME:-/tmp}/.cache/omb-once"; b="/dev/shm/omb-once"', `a="${pc.claims.disk}"; b="${pc.claims.memory}"`)) : null;
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
  const call = () => runOnce(cfg, BOX, pc.command, { signal: new AbortController().signal, deadline: 120_000 }, deps);
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
    const late = r.pc.sh(onceCommand(KEY, 1, r.pc.command, r.pc.claims));
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
    const pc = computer();
    let sends = 0;
    const outcome = await runOnce(cfg, BOX, "exit 2", { signal: new AbortController().signal, deadline: Date.now() + 60_000 }, {
      key: () => KEY,
      run: async (_cfg, _box, script) => { sends++; const out = pc.sh(script.replace(/a="[^"]*"; b="[^"]*"/, `a="${pc.claims.disk}"; b="${pc.claims.memory}"`)); return { ok: false, exitCode: out.exitCode, stdout: out.stdout, stderr: "" }; },
    });
    expect(outcome).toMatchObject({ kind: "ran", resent: 0, result: { exitCode: 2 } });
    expect(sends).toBe(1);
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      (stoppedByPerson ? turn : call).abort();
      await rejected;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return sent.includes(stopCommand(KEY));
    };
    expect(await sentFor(true)).toBe(true);
    expect(await sentFor(false)).toBe(false);
  });

  it("does not treat a refusal thrown before the send as the computer's silence", async () => {
    const refusal = Object.assign(new Error("this cloud computer is being deleted"), { status: 409 });
    await expect(runOnce(cfg, BOX, "true", { signal: new AbortController().signal, deadline: Date.now() + 60_000 }, {
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
