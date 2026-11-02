import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import * as procs from "../../procs.ts";
import { awaitAcpTeardown, confirmAcpTermination } from "./termination.ts";
import type { AcpSession } from "./turn-state.ts";

const children: ReturnType<typeof procs.spawnCli>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await procs.killCliTree(child, 0);
  }
});

const fixture = async () => {
  const child = procs.spawnCli(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");'], {});
  children.push(child);
  await once(child.stdout, "data");
  return { child, host: { draining: false } } as AcpSession;
};

it.skipIf(process.platform === "win32")("confirms SIGKILL after an unanswered close within the ten-second teardown bound", async () => {
  const session = await fixture();
  const failed = vi.fn();
  const stopping = confirmAcpTermination(session, () => new Promise<boolean>(() => {}), failed, 5_000);
  await expect(awaitAcpTeardown([stopping], () => new Error("teardown deadline exceeded"))).resolves.toBeUndefined();
  expect(await stopping).toBe(true);
  expect(session.child.signalCode).toBe("SIGKILL");
  expect(failed).not.toHaveBeenCalled();
});

it("accepts a late close while a termination attempt is still pending", async () => {
  const session = await fixture();
  let confirm!: (closed: boolean) => void;
  const close = new Promise<boolean>(resolve => { confirm = resolve; });
  let finishKill!: (stopped: boolean) => void;
  const killing = vi.spyOn(procs, "killCliTree").mockImplementation(() => new Promise(resolve => { finishKill = resolve; }));
  const failed = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let result: boolean | undefined;
  const stopping = confirmAcpTermination(session, () => close, failed, 5_000).then(value => { result = value; });
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killing).toHaveBeenCalledTimes(1);
    confirm(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);
    finishKill(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(killing).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    finishKill(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
  }
});
