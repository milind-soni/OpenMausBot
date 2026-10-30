import { describe, expect, it, vi } from "vitest";

import { keepTransient, lazyClaimRetryText, MAX_CLAIM_ATTEMPTS, startAutoVmClaim, transientClaimFailure, type AutoVmClaimSlot, type AutoVmClaimTable } from "./auto-vm-claims.ts";

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
    expect(claim).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("hands the claim what the first screen call would open, so the person's question can name it", async () => {
    const table: AutoVmClaimTable = new Map();
    const claim = vi.fn(async () => undefined);
    table.set("t1", slot(claim));
    startAutoVmClaim(table, "t1", "gen-1", { app: "Chrome", site: "calendar.google.com" });
    await table.get("t1")!.begin;
    expect(claim).toHaveBeenCalledExactlyOnceWith({ app: "Chrome", site: "calendar.google.com" });
  });

  it("takes a person's No as an answer: the slot refuses later calls, and no failed turn is reported", async () => {
    const table: AutoVmClaimTable = new Map();
    const onRejected = vi.fn();
    const declined = Object.assign(new Error("the person said no to using their own computer"), { declined: true });
    table.set("t1", { ...slot(async () => { throw declined; }), onRejected });
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    expect(table.get("t1")).toMatchObject({ failed: true, failure: "the person said no to using their own computer" });
    expect(onRejected).not.toHaveBeenCalled();
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
    expect(table.has("t1")).toBe(true);
    expect(table.get("t1")!.failed).toBe(true);
    expect(table.get("t1")!.owner.generation).toBe("gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    startAutoVmClaim(table, "t1", "gen-1");
    expect(claim).toHaveBeenCalledExactlyOnceWith(undefined);
    table.delete("t1");
    const next = vi.fn(async () => undefined);
    table.set("t1", slot(next, "gen-2"));
    startAutoVmClaim(table, "t1", "gen-2");
    await table.get("t1")!.begin;
    expect(next).toHaveBeenCalledExactlyOnceWith(undefined);
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
    expect(claim).toHaveBeenCalledExactlyOnceWith(undefined);
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
    expect(onRejected).toHaveBeenCalledExactlyOnceWith("the Local VM died", expect.objectContaining({ message: "the Local VM died" }));
    startAutoVmClaim(table, "t1", "gen-1");
    expect(onRejected).toHaveBeenCalledExactlyOnceWith("the Local VM died", expect.objectContaining({ message: "the Local VM died" }));
  });

  it("lets a later screen call claim again after a network failure, without failing the turn", async () => {
    const table: AutoVmClaimTable = new Map();
    const onRejected = vi.fn();
    const unreachable = Object.assign(new Error("Could not reach MausBot Cloud's computer service to list cloud computers"), { transient: true });
    const claim = vi.fn<() => Promise<void>>().mockRejectedValueOnce(unreachable).mockResolvedValueOnce(undefined);
    table.set("t1", { ...slot(claim), label: "the cloud computer", onRejected });
    startAutoVmClaim(table, "t1", "gen-1");
    await table.get("t1")!.begin;
    const after = table.get("t1")!;
    expect(after).toMatchObject({ retryReason: unreachable.message, begin: undefined });
    expect(after.failed).toBeUndefined();
    expect(onRejected).not.toHaveBeenCalled();
    expect(lazyClaimRetryText(after)).toBe("This turn could not reach the cloud computer just now (Could not reach MausBot Cloud's computer service to list cloud computers). This call was not performed; try it again in a moment.");
    startAutoVmClaim(table, "t1", "gen-1");
    await after.begin;
    expect(after).toMatchObject({ claimed: true, retryReason: undefined, attempts: 2 });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("fails closed once network failures reach the attempt limit, and at once on any other failure", async () => {
    const table: AutoVmClaimTable = new Map();
    const onRejected = vi.fn();
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const claim = vi.fn(async () => { throw reset; });
    table.set("t1", { ...slot(claim), onRejected });
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS + 2; attempt++) {
      startAutoVmClaim(table, "t1", "gen-1");
      await table.get("t1")!.begin;
    }
    expect(claim).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
    expect(table.get("t1")).toMatchObject({ failed: true, failure: "fetch failed" });
    expect(onRejected).toHaveBeenCalledOnce();
    const refused = vi.fn(async () => { throw new Error("the cloud computer didn't start in time"); });
    table.set("t2", { owner: { threadId: "t2", generation: "gen-1" }, claim: refused });
    startAutoVmClaim(table, "t2", "gen-1");
    await table.get("t2")!.begin;
    startAutoVmClaim(table, "t2", "gen-1");
    expect(refused).toHaveBeenCalledOnce();
    expect(table.get("t2")!.failed).toBe(true);
  });

  it("knows a network failure through the wrapper that rewords it", () => {
    expect(transientClaimFailure(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
    expect(transientClaimFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(transientClaimFailure(Object.assign(new Error("boat.dev rejected your Boat API key"), { status: 401 }))).toBe(false);
    expect(transientClaimFailure(new Error("the cloud computer didn't start in time"))).toBe(false);
    const shown = keepTransient(Object.assign(new Error("unreachable"), { transient: true }), new Error("Pepper's cloud computer isn't available right now."));
    expect(transientClaimFailure(shown)).toBe(true);
    expect(transientClaimFailure(keepTransient(new Error("refused"), new Error("reworded")))).toBe(false);
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
