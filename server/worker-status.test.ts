import { describe, expect, it } from "vitest";

import { listWorkers, type ResolvedWorker } from "./computer-workers.ts";
import { macWorkerHealthArgs } from "./mac-worker.ts";
import { RemoteWorkerLease, remoteWorkerMcp, remoteWorkerSshEnvironment } from "./remote-worker.ts";
import { windowsWorkerHealthArgs } from "./windows-worker.ts";
import { allWorkerStatuses, workerStatus } from "./worker-status.ts";

const policy = "a".repeat(64);
const capability = "c".repeat(64);

const [macWorker, winWorker] = listWorkers({
  "mac-guest": { platform: "macos", sshAlias: "macguest", expectedBasePolicySha256: policy },
  "win-box": { platform: "windows", sshAlias: "winbox", expectedBasePolicySha256: policy },
}) as [ResolvedWorker, ResolvedWorker];

const MAC_SOCKET = "/Users/worker/.openmausbot/run/cua.sock";
const WIN_PIPE = "\\\\.\\pipe\\cua-driver";

function healthy(platform: "macos" | "windows", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    driverVersion: "0.20.0",
    companionVersion: 1,
    privileged: false,
    interactiveSession: true,
    interactiveSessionId: platform === "macos" ? 501 : 2,
    locked: false,
    channelPath: platform === "macos" ? MAC_SOCKET : WIN_PIPE,
    channelAvailable: true,
    channelAccess: "ok",
    policyDigest: policy,
    policyLoaded: true,
    permissionMode: "bounded",
    capabilityDigest: capability,
    capabilityLoaded: true,
    ...(platform === "macos" ? { accessibilityGranted: true, screenRecordingGranted: true } : {}),
    ...overrides,
  });
}

/** A fake worker: no SSH, no guest, just the probe's exact stdout. */
const runnerFor = (platform: "macos" | "windows", overrides: Record<string, unknown> = {}) =>
  async () => ({ stdout: healthy(platform, overrides), stderr: "" });

describe("remote worker readiness", () => {
  it("reports a fully configured worker of either platform as ready", async () => {
    const mac = await workerStatus(macWorker, { runner: runnerFor("macos") });
    const win = await workerStatus(winWorker, { runner: runnerFor("windows") });
    expect([mac.ready, win.ready]).toEqual([true, true]);
    expect([mac.state, win.state]).toEqual(["ready", "ready"]);
    expect(mac.channelPath).toBe(MAC_SOCKET);
    expect(win.channelPath).toBe(WIN_PIPE);
  });

  it("sends each platform its own fixed probe over stdin", () => {
    expect(macWorkerHealthArgs("macguest")).toEqual([
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "macguest", "/bin/sh", "-s",
    ]);
    const win = windowsWorkerHealthArgs("winbox");
    expect(win.slice(0, 6)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "winbox"]);
    expect(win.slice(6, -1)).toEqual([
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    ]);
    // Windows OpenSSH runs the command through cmd.exe, whose command-line
    // ceiling is far below the encoded form of the whole probe.
    expect(win.at(-1)!.length).toBeLessThan(1_024);
    expect(() => macWorkerHealthArgs("host -o ProxyCommand=curl")).toThrow(/invalid worker SSH/);
  });

  it("refuses an administrator worker account on both platforms", async () => {
    // An admin worker could rewrite the very base policy that bounds it.
    for (const [worker, platform] of [[macWorker, "macos"], [winWorker, "windows"]] as const) {
      const status = await workerStatus(worker, { runner: runnerFor(platform, { privileged: true }) });
      expect(status.ready).toBe(false);
      expect(status.errorCode).toBe("worker_privileged_account");
    }
  });

  it("refuses a driver whose version is not the pinned one", async () => {
    const status = await workerStatus(macWorker, { runner: runnerFor("macos", { driverVersion: "0.19.3" }) });
    expect(status.errorCode).toBe("worker_driver_wrong_version");
  });

  it("refuses a policy file that the daemon never loaded", async () => {
    // A matching file on disk is not enough: the driver reads policy once at
    // start, and an unset policy variable disables enforcement entirely.
    const status = await workerStatus(winWorker, { runner: runnerFor("windows", { policyLoaded: false }) });
    expect(status.errorCode).toBe("worker_policy_mismatch");
    expect(status.policyMatches).toBe(false);
  });

  it("refuses a locked desktop and a missing control channel", async () => {
    const locked = await workerStatus(macWorker, { runner: runnerFor("macos", { locked: true }) });
    expect(locked.errorCode).toBe("worker_locked");
    const noChannel = await workerStatus(macWorker, {
      runner: runnerFor("macos", { channelAvailable: false, channelAccess: "missing" }),
    });
    expect(noChannel.errorCode).toBe("worker_channel_missing");
  });

  it("fails closed when macOS TCC grants are absent", async () => {
    // Accessibility and Screen Recording are per-binary and are silently
    // revoked when the driver binary is replaced, so an absent grant must
    // never read as ready.
    const noAx = await workerStatus(macWorker, { runner: runnerFor("macos", { accessibilityGranted: false }) });
    expect(noAx.errorCode).toBe("worker_accessibility_denied");
    const noScreen = await workerStatus(macWorker, { runner: runnerFor("macos", { screenRecordingGranted: false }) });
    expect(noScreen.errorCode).toBe("worker_screen_recording_denied");
    // A probe that omits the fields entirely is "not proven", not "fine".
    const silent = await workerStatus(macWorker, {
      runner: async () => {
        const report = JSON.parse(healthy("macos"));
        delete report.accessibilityGranted;
        return { stdout: JSON.stringify(report), stderr: "" };
      },
    });
    expect(silent.ready).toBe(false);
    expect(silent.errorCode).toBe("worker_accessibility_denied");
  });

  it("degrades a malformed probe field to unproven instead of discarding the report", async () => {
    // A half-configured worker is exactly the case the operator needs
    // diagnostics for, so one bad field must not collapse the whole report
    // into a bare offline error that names nothing.
    const status = await workerStatus(winWorker, {
      runner: async () => ({
        stdout: JSON.stringify({
          driverVersion: "0.20.0",
          companionVersion: 1,
          privileged: false,
          interactiveSession: true,
          interactiveSessionId: 2,
          locked: false,
          channelPath: WIN_PIPE,
          channelAvailable: true,
          channelAccess: "ok",
          policyDigest: "not-a-digest",
          policyLoaded: true,
          permissionMode: "bounded",
          capabilityDigest: capability,
          capabilityLoaded: true,
        }),
        stderr: "",
      }),
    });
    expect(status.driverVersion).toBe("0.20.0");
    expect(status.interactiveSession).toBe(true);
    expect(status.policyDigest).toBeNull();
    expect(status.errorCode).toBe("worker_policy_missing");
  });

  it("proves nothing when the probe returns something that is not a report", async () => {
    const status = await workerStatus(macWorker, {
      runner: async () => ({ stdout: '"not an object"', stderr: "" }),
    });
    expect(status.ready).toBe(false);
    expect(status.errorCode).toBe("worker_driver_missing");
  });

  it("treats an unreachable worker as offline rather than throwing", async () => {
    const status = await workerStatus(winWorker, {
      runner: async () => { throw new Error("ssh: connect to host winbox port 22: Host is down"); },
    });
    expect(status.state).toBe("offline");
    expect(status.errorCode).toBe("worker_offline");
    expect(status.problem).toContain("Host is down");
  });

  it("keeps one dead worker from taking the healthy one down with it", async () => {
    // #508 acceptance 6: disconnect either worker and the other stays usable.
    const statuses = await allWorkerStatuses([macWorker, winWorker], {
      runner: async (args) => {
        if (args.includes("winbox")) throw new Error("Host is down");
        return { stdout: healthy("macos"), stderr: "" };
      },
    });
    const byId = Object.fromEntries(statuses.map((status) => [status.workerId, status]));
    expect(byId["mac-guest"].ready).toBe(true);
    expect(byId["win-box"].state).toBe("offline");
  });
});

describe("worker leases", () => {
  it("lets a macOS bot and a Windows bot hold their desktops at the same time", async () => {
    // The whole point of the registry: two OS-different desktops, two bots,
    // one control plane, concurrently.
    const lease = new RemoteWorkerLease();
    const busy = new Set(["bot-mac", "bot-win"]);
    const isBotBusy = (botId: string) => busy.has(botId);

    expect(lease.claim(macWorker.sshAlias, "thread-mac", "bot-mac", isBotBusy)).toBe(true);
    expect(lease.claim(winWorker.sshAlias, "thread-win", "bot-win", isBotBusy)).toBe(true);

    const mac = await workerStatus(macWorker, { runner: runnerFor("macos"), lease, isBotBusy });
    const win = await workerStatus(winWorker, { runner: runnerFor("windows"), lease, isBotBusy });
    expect(mac.lease?.botId).toBe("bot-mac");
    expect(win.lease?.botId).toBe("bot-win");
    // Each desktop reports busy to *other* callers while its own turn runs;
    // neither lease blocks the other.
    expect([mac.errorCode, win.errorCode]).toEqual(["worker_busy", "worker_busy"]);
  });

  it("admits one task per desktop and releases it with the turn", async () => {
    const lease = new RemoteWorkerLease();
    const busy = new Set(["bot-a"]);
    const isBotBusy = (botId: string) => busy.has(botId);

    expect(lease.claim(macWorker.sshAlias, "thread-a", "bot-a", isBotBusy)).toBe(true);
    expect(lease.claim(macWorker.sshAlias, "thread-b", "bot-b", isBotBusy)).toBe(false);
    // Re-claiming from the same thread is a renewal, not a conflict.
    expect(lease.claim(macWorker.sshAlias, "thread-a", "bot-a", isBotBusy)).toBe(true);

    lease.release("thread-a");
    const free = await workerStatus(macWorker, { runner: runnerFor("macos"), lease, isBotBusy });
    expect(free.ready).toBe(true);
  });

  it("drops a lease whose owning turn ended without releasing it", () => {
    const lease = new RemoteWorkerLease();
    let busy = true;
    const isBotBusy = () => busy;
    lease.claim(macWorker.sshAlias, "thread-a", "bot-a", isBotBusy);
    busy = false;
    // Otherwise a crashed turn parks the desktop for the full TTL.
    expect(lease.current(macWorker.sshAlias, isBotBusy)).toBeNull();
  });

  it("expires a lease at its TTL", () => {
    const lease = new RemoteWorkerLease(1_000);
    const isBotBusy = () => true;
    lease.claim(macWorker.sshAlias, "thread-a", "bot-a", isBotBusy, 0);
    expect(lease.current(macWorker.sshAlias, isBotBusy, 999)).not.toBeNull();
    expect(lease.current(macWorker.sshAlias, isBotBusy, 1_001)).toBeNull();
  });

  it("frees an alias outright when its worker is removed or repointed", () => {
    const lease = new RemoteWorkerLease();
    const isBotBusy = () => true;
    lease.claim(macWorker.sshAlias, "thread-a", "bot-a", isBotBusy);
    lease.releaseAlias(macWorker.sshAlias);
    expect(lease.current(macWorker.sshAlias, isBotBusy)).toBeNull();
  });
});

describe("worker MCP boundary", () => {
  it("pins driver, policy, capability and channel into the generation", () => {
    const descriptor = remoteWorkerMcp(macWorker, MAC_SOCKET, undefined, capability);
    // The integration contract speaks Node platform names; the worker's own
    // spelling travels in argv for the bridge's liveness command.
    expect(descriptor.platform).toBe("darwin");
    expect(descriptor.scope).toBe("remote-worker-computer");
    expect(descriptor.args).toEqual(["macguest", MAC_SOCKET, "macos"]);
    expect(descriptor.generation).toBe(`0.20.0:${policy}:${capability}:${MAC_SOCKET}`);
    // A parked capability must not look the same as an approved one.
    expect(remoteWorkerMcp(macWorker, MAC_SOCKET).generation).toContain(":parked:");
  });

  it("refuses a control channel path that could smuggle shell syntax", () => {
    expect(() => remoteWorkerMcp(macWorker, "/tmp/a b|nc evil 1")).toThrow(/control channel/);
    expect(() => remoteWorkerMcp(macWorker, "")).toThrow(/control channel/);
  });

  it("allows only SSH runtime metadata into the bridge process", () => {
    // The bridge must never inherit provider credentials or the loopback
    // control token, so the environment is an allow-list, not a deny-list.
    const marker = "must-not-be-forwarded";
    const env = remoteWorkerSshEnvironment({
      HOME: "/Users/gus",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LANG: "en_US.UTF-8",
      EXAMPLE_PROVIDER_CREDENTIAL: marker,
      OMB_CONTROL_TOKEN: marker,
      SOME_OTHER_SETTING: marker,
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "SSH_AUTH_SOCK"]);
    expect(JSON.stringify(env)).not.toContain(marker);
  });
});
