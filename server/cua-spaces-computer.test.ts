import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { perBotLocalVmTarget, poolLocalVmTarget, SHARED_LOCAL_VM_TARGET } from "./container-computer.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { cuaSpaceOwnership, forgetCuaSpaceOwnership, recordCuaSpaceOwnership } from "./cua-space-ownership.ts";
import {
  cuaSpaceAction,
  cuaSpaceExec,
  cuaSpaceRetitle,
  cuaSpaceStatus,
  cuaSpacesAvailability,
  cuaSpaceTarget,
  cuaSpaceTitle,
  cuaSpaceViewerLink,
  cuaSpaceWakeAction,
  findCuaCli,
  existingCuaSpaces,
  onThisMachine,
  stageCuaSpaceFile,
  parseSpaceList,
  type CuaDeps,
  type CuaHost,
} from "./cua-spaces-computer.ts";

const CLI = "/opt/cua/bin/cua";
const MAC: CuaHost = { platform: "darwin", macosSupported: true };
const INTEL_MAC: CuaHost = { platform: "darwin", macosSupported: false };

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Reply = { stdout?: string; stderr?: string; code?: number };

/** A scripted `cua`: each call is matched by its argv prefix; the latest
 * matching rule wins so a test can change the world between calls. */
function fakeCua(rules: Array<[string[], Reply | (() => Reply)]>, owned = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-cua-ownership-"));
  dataDirs.push(dataDir);
  if (owned) {
    recordCuaSpaceOwnership("openmausbot-computer-linux", dataDir);
    recordCuaSpaceOwnership("openmausbot-computer-macos", dataDir);
  }
  const calls: string[][] = [];
  const run: CuaDeps["run"] = async (command, args) => {
    expect(command).toBe(CLI);
    calls.push(args);
    const rule = [...rules].reverse().find(([prefix]) => prefix.every((part, index) => args[index] === part));
    if (!rule) throw new Error(`unexpected cua ${args.join(" ")}`);
    const reply = typeof rule[1] === "function" ? rule[1]() : rule[1];
    if (reply.code) {
      throw Object.assign(new Error(`cua exited ${reply.code}`), { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code });
    }
    return { stdout: reply.stdout ?? "" };
  };
  const exec: CuaDeps["exec"] = async (command, args) => {
    expect(command).toBe(CLI);
    calls.push(args);
    return { stdout: "out", stderr: "", code: 3 };
  };
  return { deps: { cli: CLI, run, exec, dataDir } satisfies CuaDeps, calls, rules };
}

const version = (v = "0.2.0"): [string[], Reply] => [["--version"], { stdout: `cua ${v}\n` }];
const listing = (entries: Array<{ name: string; state: string; status: string }>): [string[], Reply] =>
  [["sb", "ls"], { stdout: JSON.stringify(entries.map((entry) => ({ ...entry, kind: "container", location: "local" }))) }];

const shared = cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "linux");

describe("cuaSpaceTarget", () => {
  it("names one Space per mode identity and OS, never sharing a container's or another OS's key", () => {
    const bot = perBotLocalVmTarget("bot-1");
    const targets = [
      shared,
      cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos"),
      cuaSpaceTarget(bot, "linux"),
      cuaSpaceTarget(bot, "macos"),
      cuaSpaceTarget(poolLocalVmTarget(0), "linux"),
    ];
    expect(targets.map((target) => target.space?.name)).toEqual([
      "openmausbot-computer-linux",
      "openmausbot-computer-macos",
      `${bot.containerName}-linux`,
      `${bot.containerName}-macos`,
      "openmausbot-computer-p0-linux",
    ]);
    const keys = new Set([SHARED_LOCAL_VM_TARGET.key, bot.key, ...targets.map((target) => target.key)]);
    expect(keys.size).toBe(7);
    // Mode checks in the harness read the key prefix.
    expect(targets[2].key.startsWith("bot:")).toBe(true);
    expect(/^pool:(\d+)(?::|$)/.exec(targets[4].key)?.[1]).toBe("0");
    // A Space has no host workspace a container path could delete.
    expect(targets.every((target) => target.workspaceDir === "")).toBe(true);
  });
});

describe("findCuaCli", () => {
  // install.ps1 puts cua.exe in %LOCALAPPDATA%\Programs\cua\bin and adds it to
  // the user PATH, which an app started earlier never sees. Simulated so it
  // runs on every platform.
  it("finds Cua installed after launch on Windows", () => {
    const realPlatform = process.platform;
    const previous = process.env.LOCALAPPDATA;
    const localAppData = mkdtempSync(join(tmpdir(), "omb-cua-localappdata-"));
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.LOCALAPPDATA = localAppData;
      const bin = join(localAppData, "Programs", "cua", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cua.exe"), "");
      // The simulated Windows platform still checks the host's execute bit.
      chmodSync(join(bin, "cua.exe"), 0o755);
      resetPathCacheForTests();
      expect(findCuaCli("win32")).toBe(join(bin, "cua.exe"));
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      resetPathCacheForTests();
      rmSync(localAppData, { recursive: true, force: true });
    }
  });
  it("uses an explicit fake CLI override and never falls back for an invalid override", () => {
    const previous = process.env.OMB_CUA_CLI;
    const dir = mkdtempSync(join(tmpdir(), "omb-cua-override-"));
    try {
      const executable = join(dir, "fake-cua");
      writeFileSync(executable, "#!/usr/bin/env node\n");
      chmodSync(executable, 0o755);
      process.env.OMB_CUA_CLI = executable;
      expect(findCuaCli()).toBe(executable);
      process.env.OMB_CUA_CLI = join(dir, "missing");
      expect(findCuaCli()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OMB_CUA_CLI;
      else process.env.OMB_CUA_CLI = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cuaSpaceStatus", () => {
  it("asks for an install when the CLI is missing", async () => {
    const status = await cuaSpaceStatus(shared, { ...fakeCua([]).deps, cli: null }, MAC);
    expect(status).toMatchObject({ installed: false, ready: false, create_supported: false, container: "missing" });
    expect(status.problem).toMatch(/Install Cua Spaces/);
    expect(cuaSpaceWakeAction(status)).toBeNull();
  });

  it("maps a missing, running, starting and stopped Space onto the shared lifecycle vocabulary", async () => {
    const cua = fakeCua([version(), listing([])]);
    const missing = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(missing).toMatchObject({ container: "missing", create_supported: true, ready: false, problem: "Create the Cua Space" });
    expect(cuaSpaceWakeAction(missing)).toBe("run");

    cua.rules.push(listing([{ name: "openmausbot-computer-linux", state: "running", status: "ready" }]));
    const ready = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(ready).toMatchObject({ container: "running", ready: true, problem: null, version: "0.2.0" });

    cua.rules.push(listing([{ name: "openmausbot-computer-linux", state: "running", status: "booting" }]));
    const booting = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(booting).toMatchObject({ container: "running", ready: false, problem: "The Cua Space is still starting" });
    expect(cuaSpaceWakeAction(booting)).toBeNull();

    cua.rules.push(listing([{ name: "openmausbot-computer-linux", state: "stopped", status: "stopped" }]));
    const stopped = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(stopped).toMatchObject({ container: "stopped", resumable: true, ready: false });
    expect(cuaSpaceWakeAction(stopped)).toBe("start");

    cua.rules.push(listing([{ name: "openmausbot-computer-linux", state: "error", status: "disk full" }]));
    const broken = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(broken).toMatchObject({ container: "stopped", resumable: false, problem: "The Cua Space is error (disk full)" });
    expect(cuaSpaceWakeAction(broken)).toBeNull();
  });

  it("refuses to create or wake anything on a CLI older than the tested surface", async () => {
    const cua = fakeCua([version("0.1.9"), listing([{ name: "openmausbot-computer-linux", state: "stopped", status: "stopped" }])]);
    const status = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(status.problem).toBe("Update Cua Spaces to 0.2.0 or newer (found 0.1.9)");
    expect(cuaSpaceWakeAction(status)).toBeNull();
  });

  it("never offers a macOS Space on a Mac without Apple silicon", async () => {
    const cua = fakeCua([version(), listing([])]);
    const status = await cuaSpaceStatus(cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos"), cua.deps, INTEL_MAC);
    expect(status).toMatchObject({ create_supported: false, problem: "macOS Spaces need a Mac with Apple silicon" });
    expect(cuaSpaceWakeAction(status)).toBeNull();
  });

  it("reports an unreachable daemon instead of claiming the Space is missing and creatable", async () => {
    const cua = fakeCua([version(), [["sb", "ls"], { code: 1, stderr: "cua: daemon: connection refused\n" }]]);
    const status = await cuaSpaceStatus(shared, cua.deps, MAC);
    expect(status).toMatchObject({ create_supported: false, problem: "Cua Spaces is not responding: daemon: connection refused" });
    expect(cuaSpaceWakeAction(status)).toBeNull();
  });
  it("does not adopt a same-name Space without this data directory's receipt", async () => {
    const cua = fakeCua([version(), listing([{ name: shared.space!.name, state: "running", status: "ready" }])], false);
    const target = cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "linux", "Do not rename me");
    const status = await cuaSpaceStatus(target, cua.deps, MAC);
    expect(status).toMatchObject({ managed: false, container: "running", ready: false, resumable: false });
    expect(status.problem).toMatch(/this OpenMausBot did not create.*delete it in Cua, or rename it/);
    expect(cuaSpaceWakeAction(status)).toBeNull();
    for (const action of ["stop", "remove"] as const) {
      await expect(cuaSpaceAction(action, target, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    }
    await expect(cuaSpaceRetitle(target, cua.deps)).rejects.toMatchObject({ status: 409 });
    expect(cua.calls.every((args) => args[0] === "--version" || args[1] === "ls")).toBe(true);
  });

  it("rejects a replacement registry creation identity but preserves ownership across a relabel", async () => {
    const cua = fakeCua([
      version(),
      listing([{ name: shared.space!.name, state: "running", status: "ready" }]),
      [["spaces", "ls"], { stdout: JSON.stringify({ spaces: [{ id: `local:${shared.space!.name}`, added_at: "original" }] }) }],
      [["spaces", "add"], { stdout: "{}" }],
    ]);
    recordCuaSpaceOwnership(shared.space!.name, cua.deps.dataDir, "original");
    const target = cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "linux", "Renamed");
    await expect(cuaSpaceRetitle(target, cua.deps)).resolves.toBeUndefined();
    expect(await cuaSpaceStatus(target, cua.deps, MAC)).toMatchObject({ managed: true, ready: true });
    cua.rules.push([["spaces", "ls"], { stdout: JSON.stringify({ spaces: [{ id: `local:${shared.space!.name}`, added_at: "replacement" }] }) }]);
    expect(await cuaSpaceStatus(target, cua.deps, MAC)).toMatchObject({ managed: false, container: "running", ready: false });
    await expect(cuaSpaceAction("remove", target, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    cua.rules.push(listing([]));
    expect(await cuaSpaceStatus(target, cua.deps, MAC)).toMatchObject({ managed: false, container: "missing", create_supported: false });
    await expect(cuaSpaceAction("run", target, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
  });
});

describe("cuaSpaceAction", () => {
  it("creates the pinned image under the derived name, labels it for Cua Spaces, then reports it ready", async () => {
    let created = false;
    const cua = fakeCua([
      version(),
      [["sb", "ls"], () => listing(created ? [{ name: "openmausbot-computer-macos", state: "running", status: "ready" }] : [])[1]],
      [["spaces", "create"], () => {
        created = true;
        return { stdout: JSON.stringify({ spaces: [{ id: "local:openmausbot-computer-macos", added_at: "created-at" }] }) };
      }],
      [["spaces", "add"], { stdout: "{}" }],
      [["spaces", "ls"], { stdout: JSON.stringify({ spaces: [{ id: "local:openmausbot-computer-macos", added_at: "created-at" }] }) }],
    ]);
    const target = cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos", cuaSpaceTitle("Hawkeye", "macos"));
    const status = await cuaSpaceAction("run", target, cua.deps, MAC);
    expect(cuaSpaceOwnership(target.space!.name, cua.deps.dataDir)).toEqual({ name: target.space!.name, addedAt: "created-at" });
    expect(status).toMatchObject({ ready: true, os: "macos" });
    expect(cua.calls).toContainEqual([
      "spaces", "create", "ghcr.io/trycua/macos:26-slim", "--on", "local", "--name", "openmausbot-computer-macos", "--json",
    ]);
    expect(cua.calls).toContainEqual(["spaces", "add", "local:openmausbot-computer-macos", "--name", "OpenMausBot: Hawkeye (macOS)", "--json"]);
  });

  it("reports a create in flight instead of offering another one", async () => {
    let finish = () => {};
    const cua = fakeCua([version(), listing([])]);
    const target = cuaSpaceTarget(perBotLocalVmTarget("bot-slow"), "macos");
    const deps: CuaDeps = {
      ...cua.deps,
      run: (command, args, timeout) => args[1] === "create"
        ? new Promise((resolve) => { finish = () => resolve({ stdout: "{\"spaces\":[{}]}" }); })
        : cua.deps.run(command, args, timeout),
    };
    const creating = cuaSpaceAction("run", target, deps, MAC);
    await expect.poll(async () => (await cuaSpaceStatus(target, deps, MAC)).problem).toMatch(/^Creating the Cua Space/);
    const during = await cuaSpaceStatus(target, deps, MAC);
    expect(during.create_supported).toBe(false);
    expect(cuaSpaceWakeAction(during)).toBeNull();
    finish();
    await creating;
    expect((await cuaSpaceStatus(target, deps, MAC)).problem).toBe("Create the Cua Space");
  });

  it("keeps Cua's own create error as the Space's problem until a create succeeds", async () => {
    const reason = "local runtime: Local Network access is not available: allow Cua Spaces in System Settings";
    const cua = fakeCua([
      version(),
      listing([]),
      [["spaces", "create"], { code: 1, stdout: JSON.stringify({ spaces: [{ error: reason }] }) }],
    ]);
    const target = cuaSpaceTarget(perBotLocalVmTarget("bot-net"), "linux");
    await expect(cuaSpaceAction("run", target, cua.deps, MAC)).rejects.toMatchObject({
      status: 502,
      message: `Creating the Cua Space failed: ${reason}`,
    });
    const after = await cuaSpaceStatus(target, cua.deps, MAC);
    expect(after.problem).toBe(`Creating the Cua Space failed: ${reason}`);
    // Still creatable: the person can fix the cause and retry.
    expect(cuaSpaceWakeAction(after)).toBe("run");
  });

  it("guards each transition against the Space's real state", async () => {
    const cua = fakeCua([version(), listing([{ name: "openmausbot-computer-linux", state: "running", status: "ready" }])]);
    await expect(cuaSpaceAction("run", shared, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    await expect(cuaSpaceAction("start", shared, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    await expect(cuaSpaceAction("pull", shared, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    expect(cua.calls.some((args) => args[0] === "spaces")).toBe(false);

    cua.rules.push(listing([]));
    await expect(cuaSpaceAction("stop", shared, cua.deps, MAC)).rejects.toMatchObject({ status: 409 });
    // An owned missing sandbox still needs idempotent registry cleanup.
    forgetCuaSpaceOwnership(shared.space!.name, cua.deps.dataDir);
    await expect(cuaSpaceAction("remove", shared, cua.deps, MAC)).resolves.toMatchObject({ container: "missing" });
    expect(cua.calls.some((args) => args[0] === "spaces")).toBe(false);
  });

  it("stops and starts by local ref, and deletes through the daemon without a prompt", async () => {
    let state = "running";
    const cua = fakeCua([
      version(),
      [["sb", "ls"], () => listing(state === "gone" ? [] : [{ name: "openmausbot-computer-linux", state, status: state === "running" ? "ready" : state }])[1]],
      [["spaces", "stop"], () => { state = "suspended"; return { stdout: "{}" }; }],
      [["spaces", "start"], () => { state = "running"; return { stdout: "{}" }; }],
      [["sb", "rm"], () => { state = "gone"; return { stdout: "{}" }; }],
      // A Space the registry never knew: nothing to forget is not a failure.
      [["spaces", "rm"], { code: 3, stderr: "cua: not found: Space local:openmausbot-computer-linux\n" }],
    ]);
    expect(await cuaSpaceAction("stop", shared, cua.deps, MAC)).toMatchObject({ container: "stopped", resumable: true });
    expect(await cuaSpaceAction("start", shared, cua.deps, MAC)).toMatchObject({ container: "running", ready: true });
    expect(await cuaSpaceAction("remove", shared, cua.deps, MAC)).toMatchObject({ container: "missing" });
    expect(cua.calls.filter((args) => args[0] === "spaces" || args[1] === "rm")).toEqual([
      ["spaces", "stop", "local:openmausbot-computer-linux", "--json"],
      ["spaces", "start", "local:openmausbot-computer-linux", "--json"],
      ["sb", "rm", "local:openmausbot-computer-linux", "--force", "--json"],
      ["spaces", "rm", "local:openmausbot-computer-linux", "--json"],
    ]);
  });
  it("keeps ownership written before an interrupted create", async () => {
    const cua = fakeCua([version(), listing([])], false);
    const deps: CuaDeps = {
      ...cua.deps,
      run: async (command, args, timeout) => {
        if (args[1] === "create") {
          expect(cuaSpaceOwnership(shared.space!.name, cua.deps.dataDir)).toEqual({ name: shared.space!.name });
          cua.rules.push(listing([{ name: shared.space!.name, state: "running", status: "ready" }]));
          throw new Error("client interrupted");
        }
        return cua.deps.run(command, args, timeout);
      },
    };
    await expect(cuaSpaceAction("run", shared, deps, MAC)).rejects.toMatchObject({ status: 502 });
    expect(await cuaSpaceStatus(shared, deps, MAC)).toMatchObject({ managed: true, ready: true });
  });

  it("repairs registry deletion on retry after the sandbox was already removed", async () => {
    let sandbox = true;
    let registryAttempts = 0;
    const cua = fakeCua([
      version(),
      [["sb", "ls"], () => listing(sandbox ? [{ name: shared.space!.name, state: "running", status: "ready" }] : [])[1]],
      [["sb", "rm"], () => {
        if (!sandbox) return { code: 1, stderr: `cua: not found: sandbox ${shared.space!.name}` };
        sandbox = false;
        return { stdout: "{}" };
      }],
      [["spaces", "rm"], () => ++registryAttempts === 1 ? { code: 1, stderr: "cua: registry unavailable" } : { stdout: "{}" }],
      [["spaces", "ls"], { stdout: JSON.stringify({ spaces: [{ id: `local:${shared.space!.name}`, added_at: "created-at" }] }) }],
    ]);
    recordCuaSpaceOwnership(shared.space!.name, cua.deps.dataDir, "created-at");
    await expect(cuaSpaceAction("remove", shared, cua.deps, MAC)).rejects.toMatchObject({ status: 502, message: "registry unavailable" });
    expect(cuaSpaceOwnership(shared.space!.name, cua.deps.dataDir)).not.toBeNull();
    expect(await cuaSpaceAction("remove", shared, cua.deps, MAC)).toMatchObject({ container: "missing", managed: false });
    expect(registryAttempts).toBe(2);
    expect(cuaSpaceOwnership(shared.space!.name, cua.deps.dataDir)).toBeNull();
  });

  it("fails stop and remove loudly when sandbox listing is unavailable, even with no ownership record", async () => {
    const cua = fakeCua([version(), [["sb", "ls"], { code: 1, stderr: "cua: daemon: connection refused" }]], false);
    for (const action of ["stop", "remove"] as const) {
      await expect(cuaSpaceAction(action, shared, cua.deps, MAC)).rejects.toMatchObject({ status: 502, message: "Cua Spaces is not responding: daemon: connection refused" });
    }
    expect(cua.calls.some((args) => args[1] === "rm" || args[1] === "stop")).toBe(false);
  });
});

describe("cuaSpaceViewerLink", () => {
  it("gives the person keyboard and mouse alongside the bot, never a watch-only link", async () => {
    const cua = fakeCua([[["sb", "view"], { stdout: JSON.stringify({ url: "http://127.0.0.1:53120/viewer/#ticket=t", expires_at_unix: 1_800_000_000 }) }]]);
    expect(await cuaSpaceViewerLink(shared, cua.deps)).toEqual({ url: "http://127.0.0.1:53120/viewer/#ticket=t", expiresAt: 1_800_000_000_000 });
    expect(cua.calls[0]).toEqual(["sb", "view", "local:openmausbot-computer-linux", "--no-open", "--json", "--ttl", "1h"]);
  });

  it("hands on a macOS Space's link on this Mac's VM bridge, never one on the LAN", async () => {
    const link = "http://192.168.64.5:3211/viewer/#ticket=t";
    const cua = fakeCua([[["sb", "view"], { stdout: JSON.stringify({ url: link }) }]]);
    const nic = (address: string) => [{ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` }];
    const macos = cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos");
    const realPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      await expect(cuaSpaceViewerLink(macos, cua.deps, { bridge100: nic("192.168.64.1") })).resolves.toMatchObject({ url: link });
      // The same subnet on a real network interface, or on the Thunderbolt
      // bridge to another machine, is somewhere else.
      await expect(cuaSpaceViewerLink(macos, cua.deps, { en0: nic("192.168.64.20") })).rejects.toMatchObject({ status: 502 });
      await expect(cuaSpaceViewerLink(macos, cua.deps, { bridge0: nic("192.168.64.20") })).rejects.toMatchObject({ status: 502 });
      const remote = fakeCua([[["sb", "view"], { stdout: JSON.stringify({ url: "http://198.51.100.7:3211/viewer/#ticket=t" }) }]]);
      await expect(cuaSpaceViewerLink(shared, remote.deps, { bridge100: nic("192.168.64.1") })).rejects.toMatchObject({ status: 502 });
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(onThisMachine("192.168.64.5", { bridge100: nic("192.168.64.1") })).toBe(false);
      await expect(cuaSpaceViewerLink(macos, cua.deps, { bridge100: nic("192.168.64.1") })).rejects.toMatchObject({ status: 502 });
      expect(onThisMachine("127.0.0.1", {})).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });
  it("maps non-JSON viewer output to a gateway error carrying Cua's message", async () => {
    const cua = fakeCua([[["sb", "view"], { stdout: "daemon unavailable" }]]);
    await expect(cuaSpaceViewerLink(shared, cua.deps)).rejects.toMatchObject({ status: 502, message: "daemon unavailable" });
  });
});

describe("cuaSpaceExec", () => {
  it("bounds a Linux command inside the guest and passes it as one quoted shell line", async () => {
    const cua = fakeCua([]);
    const result = await cuaSpaceExec(shared, "echo 'it''s' && exit 3", { timeoutSeconds: 9, deps: cua.deps });
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "", timedOut: false });
    expect(cua.calls[0]).toEqual([
      "sb", "exec", "local:openmausbot-computer-linux",
      `cd ~ && timeout -k 5 9 sh -lc 'echo '\\''it'\\'''\\''s'\\'' && exit 3'`,
    ]);
  });

  it("does not depend on GNU timeout inside a macOS Space", async () => {
    const cua = fakeCua([]);
    await cuaSpaceExec(cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos"), "sw_vers", { deps: cua.deps });
    expect(cua.calls[0][3]).toContain("/usr/bin/perl -MPOSIX=setsid -e ");
    expect(cua.calls[0][3]).toContain("setsid() >= 0");
    expect(cua.calls[0][3]).toContain("kill ");
    expect(cua.calls[0][3]).toContain("-$pid");
    expect(cua.calls[0][3]).toContain("exit 124");
    expect(cua.calls[0][3]).toMatch(/ 60 sh -lc 'sw_vers'$/);
  });

  it("returns the structured macOS timeout result from the guest watchdog", async () => {
    const cua = fakeCua([]);
    const deps: CuaDeps = { ...cua.deps, exec: async () => ({ stdout: "started", stderr: "", code: 124 }) };
    expect(await cuaSpaceExec(cuaSpaceTarget(SHARED_LOCAL_VM_TARGET, "macos"), "sleep 30", { timeoutSeconds: 3, deps }))
      .toEqual({ exitCode: 124, stdout: "started", stderr: "", timedOut: true });
  });
  it("rejects an empty command before reaching the Space", async () => {
    const cua = fakeCua([]);
    await expect(cuaSpaceExec(shared, "  ", { deps: cua.deps })).rejects.toMatchObject({ status: 400 });
    expect(cua.calls).toEqual([]);
  });
});

describe("cuaSpacesAvailability", () => {
  it("separates a missing install from an old one and a stopped daemon", async () => {
    expect(await cuaSpacesAvailability({ ...fakeCua([]).deps, cli: null }, MAC)).toMatchObject({
      installed: false,
      problem: "Install Cua Spaces to use it for Local VMs",
      installUrl: "https://cua.ai/docs/spaces/quickstart",
    });
    const old = fakeCua([version("0.1.0"), [["daemon", "status"], { stdout: JSON.stringify({ pid: 7, mode: "daemon" }) }]]);
    expect(await cuaSpacesAvailability(old.deps, MAC)).toMatchObject({
      installed: true, version: "0.1.0", daemonUp: true, problem: "Update Cua Spaces to 0.2.0 or newer (found 0.1.0)",
    });
    const noDaemon = fakeCua([version(), [["daemon", "status"], { code: 1, stderr: "not running" }]]);
    expect(await cuaSpacesAvailability(noDaemon.deps, INTEL_MAC)).toMatchObject({
      installed: true, daemonUp: false, macosSupported: false, problem: null,
    });
  });
});

describe("parseSpaceList", () => {
  it("skips entries it cannot name instead of hiding every Space", () => {
    expect(parseSpaceList(JSON.stringify([{ id: "cloud:x" }, { name: "a", state: "running" }]))).toEqual([
      { name: "a", state: "running", status: "" },
    ]);
  });
});

describe("stageCuaSpaceFile", () => {
  it("refuses a colon filename before it can enter Cua's sandbox path parser", async () => {
    const cua = fakeCua([]);
    await expect(stageCuaSpaceFile(shared, "a:b.txt", cua.deps)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("cannot contain ':'") });
    expect(cua.calls).toEqual([]);
  });

  it("stages an ordinary guest file using a relative host destination", async () => {
    const cua = fakeCua([]);
    const target = cuaSpaceTarget(perBotLocalVmTarget("stage-success"), "linux");
    const deps: CuaDeps = {
      ...cua.deps,
      exec: async () => ({ stdout: "/home/cua", stderr: "", code: 0 }),
      run: async (_command, args, _timeout, cwd) => {
        expect(args).toEqual(["sb", "cp", `local:${target.space!.name}:/home/cua/results/report.txt`, "results/report.txt"]);
        expect(cwd).toBeTruthy();
        writeFileSync(join(cwd!, "results", "report.txt"), "report");
        return { stdout: "" };
      },
    };
    const staged = await stageCuaSpaceFile(target, "results/report.txt", deps);
    expect(staged).toMatchObject({ path: "/home/cua/results/report.txt", guest: { root: "/home/cua" } });
    await staged!.dispose();
  });

  it("returns null only for explicit guest file not-found output", async () => {
    const cua = fakeCua([]);
    const target = cuaSpaceTarget(perBotLocalVmTarget("stage-missing"), "linux");
    const deps: CuaDeps = {
      ...cua.deps,
      exec: async () => ({ stdout: "/home/cua", stderr: "", code: 0 }),
      run: async () => { throw Object.assign(new Error("copy failed"), { stderr: "cua: open /home/cua/missing: no such file or directory" }); },
    };
    await expect(stageCuaSpaceFile(target, "missing", deps)).resolves.toBeNull();
  });

  it.each(["daemon: connection refused", "dial unix /tmp/cua.sock: no such file or directory", "permission denied", "the command client timed out"])("propagates a transfer failure as 502: %s", async (reason) => {
    const cua = fakeCua([]);
    const target = cuaSpaceTarget(perBotLocalVmTarget(`stage-${reason}`), "linux");
    const deps: CuaDeps = {
      ...cua.deps,
      exec: async () => ({ stdout: "/home/cua", stderr: "", code: 0 }),
      run: async () => { throw Object.assign(new Error("copy failed"), { stderr: `cua: ${reason}` }); },
    };
    await expect(stageCuaSpaceFile(target, "report.txt", deps)).rejects.toMatchObject({ status: 502, message: reason });
  });

  it("lets the caller search host roots when guest home discovery fails", async () => {
    const cua = fakeCua([]);
    const target = cuaSpaceTarget(perBotLocalVmTarget("stage-home-failed"), "linux");
    const deps: CuaDeps = { ...cua.deps, exec: async () => { throw new Error("daemon offline"); } };
    await expect(stageCuaSpaceFile(target, "host-report.txt", deps)).resolves.toBeNull();
    expect(cua.calls).toEqual([]);
  });
});

it("reports unavailable inventory when Cua is not installed", async () => {
  await expect(existingCuaSpaces([shared], { ...fakeCua([]).deps, cli: null })).rejects.toMatchObject({ status: 409, message: "Install Cua Spaces to use it for Local VMs" });
});
