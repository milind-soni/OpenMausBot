import { describe, expect, it } from "vitest";

import {
  MAC_WORKER_LAUNCH_AGENT_LABEL,
  restartWorkerDaemon,
  type FixedRunner,
} from "../src/driver.ts";

function recorder() {
  const calls: Array<{ executable: string; args: string[]; acceptNonZero: boolean }> = [];
  const runner: FixedRunner = async (executable, args, _timeoutMs, acceptNonZero = false) => {
    calls.push({ executable, args, acceptNonZero });
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, runner };
}

describe("restartWorkerDaemon", () => {
  it("stops the immutable Windows daemon before kicking its fixed Scheduled Task", async () => {
    const h = recorder();
    await restartWorkerDaemon("win32", h.runner);
    expect(h.calls).toEqual([
      {
        executable: "cua-driver",
        args: ["stop", "--socket", "\\\\.\\pipe\\cua-driver"],
        acceptNonZero: true,
      },
      { executable: "cua-driver", args: ["autostart", "kick"], acceptNonZero: false },
    ]);
  });

  it("restarts only the dedicated macOS worker LaunchAgent", async () => {
    const h = recorder();
    await restartWorkerDaemon("darwin", h.runner, 501);
    expect(h.calls[0].executable).toBe("cua-driver");
    expect(h.calls[0].args[0]).toBe("stop");
    expect(h.calls[1]).toEqual({
      executable: "launchctl",
      args: ["kickstart", "-k", `gui/501/${MAC_WORKER_LAUNCH_AGENT_LABEL}`],
      acceptNonZero: false,
    });
  });
});
