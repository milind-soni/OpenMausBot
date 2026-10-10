// Exit code 75, "start me again" (server/restart.ts): a server whose copied
// workspace committed exits with it, and every launcher in this repo starts
// it again: the `openmausbot serve` loop (systemd, launchd, fleet and a
// terminal all run that) and the container launcher. The Cloud launcher and
// the desktop's supervisor are covered where they live.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import type { CliOptions } from "./cli.ts";
import { serveUntilStopped } from "./cli.ts";
import { RESTART_EXIT_CODE, restartPolicy, STABLE_RUN_MS } from "./restart.ts";
import { superviseServer } from "./server-launcher.ts";

it("one policy counts for every launcher: again only on 75, not while stopping, at most five in a row, and a run that stayed up starts the count again", () => {
  expect(RESTART_EXIT_CODE).toBe(75);
  let clock = 0;
  const policy = restartPolicy(() => clock);
  for (const code of [0, 1, 130, null]) expect(restartPolicy(() => clock).again(code)).toBe(false);
  expect(restartPolicy(() => clock).again(RESTART_EXIT_CODE, true)).toBe(false);
  for (let run = 0; run < 5; run++) expect(policy.again(RESTART_EXIT_CODE), `restart ${run + 1}`).toBe(true);
  // A loop: the sixth in a row is refused, and stays refused until a run stays up.
  expect(policy.again(RESTART_EXIT_CODE)).toBe(false);
  clock += STABLE_RUN_MS - 1;
  expect(policy.again(RESTART_EXIT_CODE)).toBe(false);
  // Each "again" times the next run from that answer: one that stays up a minute is not a loop.
  clock += 1;
  expect(policy.again(RESTART_EXIT_CODE)).toBe(true);
  clock += STABLE_RUN_MS - 1;
  for (let run = 0; run < 4; run++) expect(policy.again(RESTART_EXIT_CODE)).toBe(true);
  expect(policy.again(RESTART_EXIT_CODE)).toBe(false);
});

const options = { command: "serve", port: 8799, dataDir: "/tmp/omb", tailscale: false, tunnel: false, client: false, pair: true, json: false } as CliOptions;

it("`serve` starts the server again in the same process on 75, without a second pairing code or browser tab", async () => {
  const codes = [RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0];
  const runs: CliOptions[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await serveUntilStopped(options, async (next) => { runs.push(next); return codes.shift()!; })).toBe(0);
  } finally { log.mockRestore(); }
  expect(runs).toHaveLength(3);
  expect(runs[0]).toBe(options);
  for (const rerun of runs.slice(1)) expect(rerun).toMatchObject({ pair: false, open: false, port: 8799, dataDir: "/tmp/omb" });
});

it("`serve` stops after five restarts in a row, and passes any other exit straight through", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    let runs = 0;
    expect(await serveUntilStopped(options, async () => { runs++; return RESTART_EXIT_CODE; }, () => 0)).toBe(RESTART_EXIT_CODE);
    expect(runs).toBe(6);
    runs = 0;
    expect(await serveUntilStopped(options, async () => { runs++; return 1; })).toBe(1);
    expect(runs).toBe(1);
    // Each run stayed up a while: no loop, so it keeps coming back.
    let clock = 0;
    runs = 0;
    expect(await serveUntilStopped(options, async () => { clock += STABLE_RUN_MS; return ++runs < 9 ? RESTART_EXIT_CODE : 0; }, () => clock)).toBe(0);
    expect(runs).toBe(9);
  } finally { log.mockRestore(); }
});

/** A child process that exits when told to. */
function fakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), { pid, killed: [] as string[], exitCode: null as number | null,
    kill(signal: string) { child.killed.push(signal); return true; } });
  return child;
}

it("the container launcher starts the server again on 75, passes SIGTERM on, and exits with the server's code", async () => {
  const signals = new EventEmitter();
  const children: ReturnType<typeof fakeChild>[] = [];
  const done = superviseServer(() => { const child = fakeChild(children.length + 1); children.push(child); return child as unknown as ChildProcess; },
    { signals: signals as unknown as NodeJS.Process, now: () => 0 });
  expect(children).toHaveLength(1);
  children[0].emit("exit", RESTART_EXIT_CODE, null);
  expect(children).toHaveLength(2);
  // `docker stop`: the launcher passes it on, and the server's own exit decides.
  signals.emit("SIGTERM");
  expect(children[1].killed).toEqual(["SIGTERM"]);
  children[1].emit("exit", 0, null);
  expect(await done).toBe(0);
  expect(children).toHaveLength(2);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

it("the container launcher stops on any other exit, and on a 75 that arrives while it is stopping", async () => {
  const signals = new EventEmitter();
  let child = fakeChild(1);
  const failed = superviseServer(() => child as unknown as ChildProcess, { signals: signals as unknown as NodeJS.Process });
  child.emit("exit", 1, null);
  expect(await failed).toBe(1);
  child = fakeChild(2);
  let started = 0;
  const stopping = superviseServer(() => { started++; return child as unknown as ChildProcess; }, { signals: signals as unknown as NodeJS.Process });
  signals.emit("SIGINT");
  expect(child.killed).toEqual(["SIGINT"]);
  child.emit("exit", RESTART_EXIT_CODE, null);
  expect(await stopping).toBe(RESTART_EXIT_CODE);
  expect(started).toBe(1);
  // A server killed by a signal ends the launcher too.
  child = fakeChild(3);
  const killed = superviseServer(() => child as unknown as ChildProcess, { signals: signals as unknown as NodeJS.Process });
  child.emit("exit", null, "SIGKILL");
  expect(await killed).toBe(1);
  // Five restarts in a row, then it gives up with the server's code.
  let runs = 0;
  const looping = superviseServer(() => { runs++; const next = fakeChild(runs); queueMicrotask(() => next.emit("exit", RESTART_EXIT_CODE, null)); return next as unknown as ChildProcess; },
    { signals: signals as unknown as NodeJS.Process, now: () => 0 });
  expect(await looping).toBe(RESTART_EXIT_CODE);
  expect(runs).toBe(6);
});
