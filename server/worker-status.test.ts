import { describe, expect, it } from "vitest";

import { listWorkers, type ResolvedWorker } from "./computer-workers.ts";
import { macWorkerHealthArgs } from "./mac-worker.ts";
import {
  publicWorkerStatus,
  RemoteWorkerLease,
  remoteWorkerMcp,
  remoteWorkerSshEnvironment,
} from "./remote-worker.ts";
import { WINDOWS_HEALTH_SCRIPT, windowsWorkerHealthArgs } from "./windows-worker.ts";
import { allWorkerStatuses, workerStatus } from "./worker-status.ts";

const policy = "a".repeat(64);
const capability = "c".repeat(64);

const [macWorker, winWorker] = listWorkers({
  "mac-guest": { platform: "macos", sshAlias: "macguest", expectedBasePolicySha256: policy, expectedParkedCapabilitySha256: capability },
  "win-box": { platform: "windows", sshAlias: "winbox", expectedBasePolicySha256: policy, expectedParkedCapabilitySha256: capability },
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
    ...(platform === "macos" ? {
      permissionAttribution: "driver-daemon",
      accessibilityGranted: true,
      screenRecordingGranted: true,
    } : {}),
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

  it("reads macOS permissions from the running daemon without prompting", async () => {
    let script = "";
    const status = await workerStatus(macWorker, {
      runner: async (_args, _timeout, stdin) => {
        script = stdin ?? "";
        return { stdout: healthy("macos"), stderr: "" };
      },
    });
    expect(status.ready).toBe(true);
    expect(script).toContain("cua-driver call check_permissions");
    expect(script).toContain("'{\"prompt\":false}'");
    expect(script).toContain('--socket "$sock"');
    expect(script).not.toContain("openmausbot-worker-companion --permissions");
  });

  it("refreshes an expired parked macOS capability once through the fixed companion", async () => {
    const calls: { args: string[]; stdin: string }[] = [];
    let healthCalls = 0;
    const runner = async (args: string[], _timeout?: number, stdin = "") => {
      calls.push({ args, stdin });
      if (args.includes("stdio")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            version: 1,
            op: "resume",
            paused: false,
            capabilitySha256: capability,
          }),
          stderr: "",
        };
      }
      healthCalls += 1;
      return {
        stdout: healthy("macos", healthCalls === 1 ? {
          permissionAttribution: "unknown",
          permissionProbeExpired: true,
          accessibilityGranted: false,
          screenRecordingGranted: false,
        } : {}),
        stderr: "",
      };
    };

    const status = await workerStatus(macWorker, { runner });
    expect(status.ready).toBe(true);
    expect(healthCalls).toBe(2);
    const refresh = calls.find((call) => call.args.includes("stdio"));
    expect(refresh).toBeDefined();
    expect(JSON.parse(refresh!.stdin)).toEqual({
      op: "resume",
      expectedBasePolicySha256: policy,
    });
  });

  it("never refreshes an expired active task capability", async () => {
    const active = "d".repeat(64);
    let calls = 0;
    const status = await workerStatus(macWorker, {
      expectedCapabilityDigest: active,
      runner: async () => {
        calls += 1;
        return {
          stdout: healthy("macos", {
            capabilityDigest: active,
            permissionAttribution: "unknown",
            permissionProbeExpired: true,
          }),
          stderr: "",
        };
      },
    });
    expect(status.ready).toBe(false);
    expect(status.errorCode).toBe("worker_capability_mismatch");
    expect(calls).toBe(1);
  });

  it("rejects any Windows account in the Administrators group, even with a filtered token", () => {
    expect(WINDOWS_HEALTH_SCRIPT).toContain("S-1-5-32-544");
    expect(WINDOWS_HEALTH_SCRIPT).toContain("$currentIdentity.Groups");
    expect(WINDOWS_HEALTH_SCRIPT).not.toContain("IsInRole");
  });

  it("refuses an administrator worker account on both platforms", async () => {
    // An admin worker could rewrite the very base policy that bounds it.
    for (const [worker, platform] of [[macWorker, "macos"], [winWorker, "windows"]] as const) {
      const status = await workerStatus(worker, { runner: runnerFor(platform, { privileged: true }) });
      expect(status.ready).toBe(false);
      expect(status.errorCode).toBe("worker_privileged_account");
    }
  });

  it("requires explicit proof of a non-admin account and unlocked desktop", async () => {
    for (const field of ["privileged", "locked"] as const) {
      const missing = await workerStatus(winWorker, {
        runner: async () => {
          const report = JSON.parse(healthy("windows"));
          delete report[field];
          return { stdout: JSON.stringify(report), stderr: "" };
        },
      });
      expect(missing.ready).toBe(false);
      expect(missing.errorCode).toBe(field === "privileged" ? "worker_privileged_account" : "worker_locked");

      const malformed = await workerStatus(winWorker, { runner: runnerFor("windows", { [field]: "unknown" }) });
      expect(malformed.ready).toBe(false);
      expect(malformed.errorCode).toBe(field === "privileged" ? "worker_privileged_account" : "worker_locked");
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

  it("refuses a loaded capability that is neither parked nor approved", async () => {
    const status = await workerStatus(winWorker, {
      runner: runnerFor("windows", { capabilityDigest: "d".repeat(64) }),
    });
    expect(status.ready).toBe(false);
    expect(status.errorCode).toBe("worker_capability_mismatch");

    const approved = await workerStatus(winWorker, {
      runner: runnerFor("windows", { capabilityDigest: "d".repeat(64) }),
      expectedCapabilityDigest: "d".repeat(64),
    });
    expect(approved.ready).toBe(true);
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

  it("refuses macOS TCC status attributed to the SSH caller or embedding host", async () => {
    for (const permissionAttribution of ["caller", "host", "unknown"] as const) {
      const status = await workerStatus(macWorker, {
        runner: runnerFor("macos", { permissionAttribution }),
      });
      expect(status.ready).toBe(false);
      expect(status.errorCode).toBe("worker_permission_attribution_mismatch");
    }
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
    expect(status.problem).toBe("Worker SSH is offline or unreachable");
    expect(status.problem).not.toContain("winbox");
    expect(status.problem).not.toContain("Host is down");
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

  it("uses one lease for SSH aliases that differ only by case", () => {
    const lease = new RemoteWorkerLease();
    const isBotBusy = () => true;
    expect(lease.claim("MacGuest", "thread-a", "bot-a", isBotBusy)).toBe(true);
    expect(lease.claim("macguest", "thread-b", "bot-b", isBotBusy)).toBe(false);
    expect(lease.current("MACGUEST", isBotBusy)?.threadId).toBe("thread-a");
  });
});

describe("public worker status", () => {
  it("omits transport, policy, capability and lease-owner details", async () => {
    const lease = new RemoteWorkerLease();
    lease.claim(macWorker.sshAlias, "private-thread", "private-bot", () => true);
    const internal = await workerStatus(macWorker, {
      runner: runnerFor("macos"),
      lease,
      isBotBusy: () => true,
    });
    const shown = publicWorkerStatus(internal);
    expect(shown.lease).toEqual({ expiresAt: internal.lease?.expiresAt });
    const serialized = JSON.stringify(shown);
    for (const privateValue of [macWorker.sshAlias, MAC_SOCKET, policy, capability, "private-thread", "private-bot"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(shown).not.toHaveProperty("channelPath");
    expect(shown).not.toHaveProperty("policyDigest");
    expect(shown).not.toHaveProperty("capabilityDigest");
  });
});

describe("worker MCP boundary", () => {
  it("pins driver, policy, capability and channel into the generation", () => {
    const descriptor = remoteWorkerMcp(macWorker, MAC_SOCKET, undefined, capability);
    // The integration contract speaks Node platform names. SSH identity and
    // channel stay in the harness rather than crossing the model MCP process.
    expect(descriptor.platform).toBe("darwin");
    expect(descriptor.scope).toBe("remote-worker-computer");
    expect(descriptor.args).toEqual([]);
    expect(descriptor.generation).toBe(`0.20.0:${policy}:${capability}:${MAC_SOCKET}`);
    // A parked capability must not look the same as an approved one.
    expect(remoteWorkerMcp(macWorker, MAC_SOCKET).generation).toContain(":parked:");
  });

  it("refuses a control channel path that could smuggle shell syntax", () => {
    expect(() => remoteWorkerMcp(macWorker, "/tmp/a b|nc evil 1")).toThrow(/control channel/);
    expect(() => remoteWorkerMcp(macWorker, "")).toThrow(/control channel/);
  });

  it("refuses a safe-looking channel outside the fixed worker location", () => {
    expect(() => remoteWorkerMcp(macWorker, "/tmp/cua.sock")).toThrow(/control channel/);
    expect(() => remoteWorkerMcp(winWorker, "\\\\.\\pipe\\another-driver")).toThrow(/control channel/);
  });

  it("allows only SSH runtime metadata into worker transport processes", () => {
    // SSH must never inherit provider credentials or the loopback
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

  it("keeps SSH identity and channel out of the worker MCP process", () => {
    const descriptor = remoteWorkerMcp(
      macWorker,
      MAC_SOCKET,
      { url: "http://127.0.0.1/control", token: "control-token" },
      capability,
      { url: "http://127.0.0.1/task", token: "task-token" },
    );
    expect(descriptor.args).toEqual([]);
    expect(JSON.stringify({ args: descriptor.args, env: descriptor.env })).not.toContain(macWorker.sshAlias);
    expect(JSON.stringify({ args: descriptor.args, env: descriptor.env })).not.toContain(MAC_SOCKET);
    expect(descriptor.env).toEqual({
      OMB_CONTROL_URL: "http://127.0.0.1/control",
      OMB_CONTROL_TOKEN: "control-token",
      OMB_TASK_URL: "http://127.0.0.1/task",
      OMB_TASK_TOKEN: "task-token",
    });
  });
});
