import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./container-computer.ts";
import { NOT_ANSWERING_YET, startStoppedPodmanMachine } from "./podman-machine.ts";

type Status = { runtime: "docker" | "podman" | null; daemonUp: boolean; problem: string | null };
const down: Status = { runtime: "podman", daemonUp: false, problem: "Start podman first" };
const up: Status = { runtime: "podman", daemonUp: true, problem: null };
const recheck = async () => up;

function podman(machines: unknown[], bootMachine: (name: string) => void | Promise<void> = () => {}) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.join(" ") === "machine list --format json") return { stdout: JSON.stringify(machines) };
    if (args[0] === "machine" && args[1] === "start") {
      await bootMachine(args[2]!);
      return { stdout: "Machine started successfully\n" };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  const shown: string[] = [];
  const start = (status = down, platform: NodeJS.Platform = "darwin", now = Date.now, check = recheck) =>
    startStoppedPodmanMachine(status, check, () => shown.push("starting"), { runner: run, platform, now, pause: async () => {} });
  return { run, calls, shown, start };
}

describe("starting a stopped Podman machine on a Mac", () => {
  it("starts the machine that is set up but stopped, so a bot's Local VM can come up", async () => {
    const fake = podman([
      { Name: "other", Default: false, Running: false, Starting: false },
      { Name: "podman-machine-default", Default: true, Running: false, Starting: false },
    ]);
    await expect(fake.start()).resolves.toBe(up);
    expect(fake.calls).toEqual(["podman machine list --format json", "podman machine start podman-machine-default"]);
    expect(fake.shown).toEqual(["starting"]);
  });

  it("starts the only machine when none is marked default", async () => {
    const fake = podman([{ Name: "mine", Running: false }]);
    await expect(fake.start()).resolves.toBe(up);
    expect(fake.calls.at(-1)).toBe("podman machine start mine");
  });

  it.each([
    ["Linux", down, "linux"],
    ["Windows", down, "win32"],
    ["Docker", { ...down, runtime: "docker" }, "darwin"],
    ["no runtime", { ...down, runtime: null }, "darwin"],
    ["Podman already answering", up, "darwin"],
  ] as const)("leaves %s alone", async (_label, status: Status, platform) => {
    const fake = podman([{ Name: "podman-machine-default", Default: true, Running: false }]);
    await expect(fake.start(status, platform)).resolves.toBe(status);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["no machine was ever set up", []],
    ["a machine is already running", [{ Name: "podman-machine-default", Default: true, Running: true }]],
    ["a machine is already starting", [{ Name: "podman-machine-default", Default: true, Starting: true }]],
    ["several machines and none is the default", [{ Name: "a" }, { Name: "b" }]],
  ])("never creates or restarts one when %s", async (_label, machines) => {
    const fake = podman(machines);
    await expect(fake.start()).resolves.toBe(down);
    expect(fake.calls).toEqual(["podman machine list --format json"]);
    expect(fake.shown).toEqual([]);
  });

  it("says what went wrong when the machine does not start, and does not retry it on every turn", async () => {
    let clock = 0;
    const failing = podman([{ Name: "podman-machine-default", Default: true }], () => {
      throw Object.assign(new Error("Command failed: podman machine start podman-machine-default"), {
        stderr: 'Starting machine "podman-machine-default"\nError: vfkit exited unexpectedly\n',
      });
    });
    const problem = 'The Podman machine "podman-machine-default" did not start (Error: vfkit exited unexpectedly); run podman machine start';
    await expect(failing.start(down, "darwin", () => clock)).resolves.toEqual({ ...down, problem });
    clock = 60_000;
    await expect(failing.start(down, "darwin", () => clock)).resolves.toEqual({ ...down, problem });
    expect(failing.calls.filter((call) => call.includes("machine start"))).toHaveLength(1);

    clock = 6 * 60_000;
    const fixed = podman([{ Name: "podman-machine-default", Default: true }]);
    await expect(fixed.start(down, "darwin", () => clock)).resolves.toBe(up);
  });

  it("waits a moment for Podman to answer after the machine starts", async () => {
    const fake = podman([{ Name: "podman-machine-default", Default: true }]);
    const answers = [down, down, up];
    await expect(fake.start(down, "darwin", Date.now, async () => answers.shift()!)).resolves.toBe(up);
    expect(answers).toEqual([]);
  });

  it("says the machine started when Podman still does not answer after the wait, not \"Start podman first\"", async () => {
    const fake = podman([{ Name: "podman-machine-default", Default: true }]);
    let checks = 0;
    await expect(fake.start(down, "darwin", Date.now, async () => { checks++; return down; })).resolves.toEqual({ ...down, problem: NOT_ANSWERING_YET });
    expect(checks).toBe(20);
  });

  it("does not hold a failed status check against later turns", async () => {
    const fake = podman([{ Name: "podman-machine-default", Default: true }]);
    await expect(fake.start(down, "darwin", Date.now, async () => { throw new Error("inspect failed"); })).rejects.toThrow("inspect failed");
    await expect(fake.start()).resolves.toBe(up);
  });

  it("starts the machine once for turns that arrive together", async () => {
    let release!: () => void;
    const fake = podman([{ Name: "podman-machine-default", Default: true }], () => new Promise<void>((resolve) => { release = resolve; }));
    const first = fake.start();
    const second = fake.start();
    await expect.poll(() => fake.calls.length).toBe(2);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([up, up]);
    expect(fake.calls.filter((call) => call.includes("machine start"))).toHaveLength(1);
  });
});
