import { describe, expect, it, vi } from "vitest";

import { startAutoVmClaim, type AutoVmClaimSlot, type AutoVmClaimTable } from "./auto-vm-claims.ts";

const slot = (claim: () => Promise<void>, generation = "gen-1"): AutoVmClaimSlot => ({
  owner: { threadId: "t1", generation },
  claim,
});

describe("startAutoVmClaim", () => {
  it("fires a thread's claim exactly once, even across repeated gate polls", async () => {
    const table: AutoVmClaimTable = new Map();
    const claim = vi.fn(async () => undefined);
    table.set("t1", slot(claim));
    startAutoVmClaim(table, "t1", "gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    expect(claim).toHaveBeenCalledExactlyOnceWith();
  });

  it("refuses to fire for a different dispatch generation", () => {
    const table: AutoVmClaimTable = new Map();
    const claim = vi.fn(async () => undefined);
    table.set("t1", slot(claim, "gen-1"));
    startAutoVmClaim(table, "t1", "gen-2");
    expect(claim).not.toHaveBeenCalled();
    expect(table.get("t1")!.begin).toBeUndefined();
  });

  it("fails closed: a rejected claim keeps the slot so later gate polls stay held (F1)", async () => {
    const table: AutoVmClaimTable = new Map();
    const claim = vi.fn(async () => { throw new Error("Computer is still busy. Stop the turn using it, then retry."); });
    table.set("t1", slot(claim));
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    // The slot the GET gate reads must survive the rejection: deleting it
    // would fall through to held:false and the bridge would forward screen
    // calls onto a VM this turn never claimed.
    expect(table.has("t1")).toBe(true);
    expect(table.get("t1")!.failed).toBe(true);
    expect(table.get("t1")!.owner.generation).toBe("gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    expect(claim).toHaveBeenCalledExactlyOnceWith();
    // Settle GC still clears it, and the next generation starts fresh.
    table.delete("t1");
    const next = vi.fn(async () => undefined);
    table.set("t1", slot(next, "gen-2"));
    startAutoVmClaim(table, "t1", "gen-2");
    await table.get("t1")!.begin;
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(table.get("t1")!.failed).toBeUndefined();
  });

  it("keeps the slot after success so later polls stay no-ops", async () => {
    const table: AutoVmClaimTable = new Map();
    const claim = vi.fn(async () => undefined);
    table.set("t1", slot(claim));
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    startAutoVmClaim(table, "t1", "gen-1");
    await Promise.resolve();
    expect(claim).toHaveBeenCalledExactlyOnceWith();
    expect(table.has("t1")).toBe(true);
  });

  it("records a landed claim so the gate can answer honestly instead of held", async () => {
    const table: AutoVmClaimTable = new Map();
    table.set("t1", slot(vi.fn(async () => undefined)));
    startAutoVmClaim(table, "t1", "gen-1");
    expect(table.get("t1")!.claimed).toBeUndefined();
    await table.get("t1")!.begin;
    expect(table.get("t1")!.claimed).toBe(true);
    expect(table.get("t1")!.failed).toBeUndefined();
  });

  it("keeps the rejection's message so the refusal can say why", async () => {
    const table: AutoVmClaimTable = new Map();
    table.set("t1", slot(async () => { throw new Error("the Local VM is not ready (App Settings → Computers)"); }));
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    expect(table.get("t1")!.failure).toBe("the Local VM is not ready (App Settings → Computers)");
    expect(table.get("t1")!.claimed).toBeUndefined();
  });

  it("a stale rejection cannot delete a newer generation's slot", async () => {
    const table: AutoVmClaimTable = new Map();
    let rejectFirst: (error: Error) => void = () => {};
    const first = slot(() => new Promise<void>((_, reject) => { rejectFirst = reject; }));
    table.set("t1", first);
    startAutoVmClaim(table, "t1", "gen-1");
    const second = slot(vi.fn(async () => undefined), "gen-2");
    table.set("t1", second);
    rejectFirst(new Error("stale holder"));
    await first.begin;
    expect(table.get("t1")).toBe(second);
    expect(second.begin).toBeUndefined();
  });

  it("fires the turn's rejection hook once when its claim rejects (issue #1369)", async () => {
    const table: AutoVmClaimTable = new Map();
    const onRejected = vi.fn();
    table.set("t1", {
      owner: { threadId: "t1", generation: "gen-1" },
      claim: async () => { throw new Error("the Local VM died"); },
      onRejected,
    });
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    expect(onRejected).toHaveBeenCalledExactlyOnceWith("the Local VM died");
    // The hook rides the fire-once claim, so a later gate poll can never
    // surface a second terminal error for the same rejection.
    startAutoVmClaim(table, "t1", "gen-1");
    expect(onRejected).toHaveBeenCalledExactlyOnceWith("the Local VM died");
  });

  it("never fires the rejection hook for a claim that lands", async () => {
    const table: AutoVmClaimTable = new Map();
    const onRejected = vi.fn();
    table.set("t1", {
      owner: { threadId: "t1", generation: "gen-1" },
      claim: async () => undefined,
      onRejected,
    });
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    expect(table.get("t1")!.claimed).toBe(true);
    expect(onRejected).not.toHaveBeenCalled();
  });
});
