import { describe, expect, it } from "vitest";

import {
  findWorker,
  isSafeWorkerExecutable,
  listWorkers,
  publicWorker,
  workerConfigMapSchema,
  WORKER_DRIVER_VERSION,
} from "./computer-workers.ts";
import { parseStoredConfig } from "./config.ts";

const policy = "a".repeat(64);

const twoWorkers = {
  "mac-guest": { platform: "macos", sshAlias: "macguest", expectedBasePolicySha256: policy },
  "win-box": { platform: "windows", sshAlias: "winbox", expectedBasePolicySha256: policy },
} as const;

describe("worker registry", () => {
  it("accepts one Windows and one macOS worker side by side", () => {
    const parsed = workerConfigMapSchema.safeParse(twoWorkers);
    expect(parsed.success).toBe(true);
    const workers = listWorkers(parsed.success ? parsed.data : undefined);
    expect(workers.map((worker) => [worker.id, worker.platform])).toEqual([
      ["mac-guest", "macos"],
      ["win-box", "windows"],
    ]);
    expect(workers.every((worker) => worker.configured)).toBe(true);
    expect(workers.every((worker) => worker.expectedDriverVersion === WORKER_DRIVER_VERSION)).toBe(true);
  });

  it("rejects two workers pointed at one machine", () => {
    // Two ids on one alias would take two independent leases against a single
    // desktop, and each would believe it held the screen exclusively.
    const parsed = workerConfigMapSchema.safeParse({
      "mac-a": { platform: "macos", sshAlias: "macguest", expectedBasePolicySha256: policy },
      "mac-b": { platform: "macos", sshAlias: "macguest", expectedBasePolicySha256: policy },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("distinct SSH alias");
  });

  it("rejects an alias that could smuggle extra ssh arguments", () => {
    const parsed = workerConfigMapSchema.safeParse({
      evil: { platform: "macos", sshAlias: "host -o ProxyCommand=curl", expectedBasePolicySha256: policy },
    });
    expect(parsed.success).toBe(false);
  });

  it("holds a worker unconfigured until its base policy is pinned", () => {
    // Without a pinned digest the driver's tool ceiling is whatever happens to
    // be on the worker's disk, so this must never read as usable.
    const workers = listWorkers({ "mac-guest": { platform: "macos", sshAlias: "macguest" } });
    expect(workers[0].configured).toBe(false);
    expect(workers[0].expectedBasePolicySha256).toBeNull();
  });

  it("validates executable paths against the worker's own platform", () => {
    expect(isSafeWorkerExecutable("windows", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe(true);
    expect(isSafeWorkerExecutable("windows", "/Applications/Safari.app/Contents/MacOS/Safari")).toBe(false);
    expect(isSafeWorkerExecutable("macos", "/Applications/Safari.app/Contents/MacOS/Safari")).toBe(true);
    expect(isSafeWorkerExecutable("macos", "C:\\Windows\\explorer.exe")).toBe(false);
    expect(isSafeWorkerExecutable("macos", "/usr/bin/open\u0000")).toBe(false);
  });

  it("rejects a POSIX executable configured on a Windows worker", () => {
    const parsed = workerConfigMapSchema.safeParse({
      "win-box": {
        platform: "windows",
        sshAlias: "winbox",
        expectedBasePolicySha256: policy,
        ideExecutable: "/usr/local/bin/code",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps the SSH alias out of anything a bot or device can see", () => {
    const worker = findWorker(twoWorkers, "mac-guest");
    expect(worker?.sshAlias).toBe("macguest");
    expect(JSON.stringify(publicWorker(worker!))).not.toContain("macguest");
  });

  it("round-trips through the stored app config", () => {
    const cfg = parseStoredConfig({ workers: twoWorkers });
    expect(Object.keys(cfg.workers ?? {})).toEqual(["mac-guest", "win-box"]);
  });
});
