import { afterEach, describe, expect, it, vi } from "vitest";

import { codexLaunchesStarting, codexLaunchLimit, codexLaunchSlot, codexRpcTimeoutMs, keepStopping, tryCodexLaunchSlot } from "./codex-process.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Codex launch slots", () => {
  it("sizes the host's slots from its CPUs unless configured", () => {
    expect(codexLaunchLimit()).toBeGreaterThanOrEqual(2);
    vi.stubEnv("OMB_CODEX_LAUNCH_SLOTS", "3");
    expect(codexLaunchLimit()).toBe(3);
  });

  it("hands a freed slot to the first waiter, skips one that stopped waiting, and releases each slot once", async () => {
    vi.stubEnv("OMB_CODEX_LAUNCH_SLOTS", "1");
    const held = tryCodexLaunchSlot()!;
    expect(tryCodexLaunchSlot()).toBeNull();
    const stopped = new AbortController();
    const abandoned = codexLaunchSlot(stopped.signal);
    const next = codexLaunchSlot(new AbortController().signal);
    stopped.abort();
    await expect(abandoned).resolves.toBeNull();
    held();
    held();
    const granted = await next;
    expect(granted).toBeTypeOf("function");
    expect(codexLaunchesStarting()).toBe(1);
    granted!();
    expect(codexLaunchesStarting()).toBe(0);
  });
});

describe("Codex request timeouts", () => {
  it("gives the startup calls minutes on a loaded host and keeps later calls short", () => {
    for (const method of ["initialize", "config/read", "thread/start", "thread/resume", "thread/unarchive", "turn/start"]) {
      expect(codexRpcTimeoutMs(method)).toBe(180_000);
    }
    expect(codexRpcTimeoutMs("turn/interrupt")).toBe(60_000);
  });
});

describe("keepStopping", () => {
  it("retries until the stop succeeds, and gives up after its bound", async () => {
    vi.stubEnv("FAKE_CODEX_STOP_RETRY_MS", "5");
    let calls = 0;
    await expect(keepStopping(async () => ++calls === 3, () => true)).resolves.toBe(true);
    expect(calls).toBe(3);
    calls = 0;
    await expect(keepStopping(async () => { calls++; return false; }, () => true)).resolves.toBe(false);
    expect(calls).toBe(12);
    await expect(keepStopping(async () => true, () => false)).resolves.toBe(false);
  });
});
