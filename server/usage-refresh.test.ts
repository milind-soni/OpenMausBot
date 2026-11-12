import { describe, expect, it, vi } from "vitest";
import { UsageRefreshGate } from "./usage-refresh.ts";
import { USAGE_REFRESH_MS } from "./usage-types.ts";

describe("idle usage read gate", () => {
  it("requires an open window and an idle app, then permits at most one read every five minutes", async () => {
    let now = 0;
    const gate = new UsageRefreshGate(() => now);
    const read = vi.fn(async () => {});
    await gate.run("c", false, true, read); await gate.run("c", true, false, read);
    expect(read).not.toHaveBeenCalled();
    await gate.run("c", true, true, read); await gate.run("c", true, true, read);
    now += USAGE_REFRESH_MS - 1; await gate.run("c", true, true, read);
    expect(read).toHaveBeenCalledTimes(1);
    now++; await gate.run("c", true, true, read);
    expect(read).toHaveBeenCalledTimes(2);
    gate.noteRead("c"); now += 1; await gate.run("c", true, true, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("prevents overlapping reads, including when a window reconnects", async () => {
    let now = 0, finish!: () => void;
    const gate = new UsageRefreshGate(() => now);
    const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = gate.run("c", true, true, read);
    now += USAGE_REFRESH_MS * 2; await gate.run("c", true, true, read);
    expect(read).toHaveBeenCalledTimes(1);
    finish(); await first;
  });
});
