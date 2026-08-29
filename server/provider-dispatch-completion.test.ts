import { describe, expect, it, vi } from "vitest";

import { completeAcceptedProviderDispatch } from "./provider-dispatch-completion.ts";

describe("accepted provider dispatch completion", () => {
  it("interrupts a post-acceptance cancellation and preserves normal completion", async () => {
    const interrupt = vi.fn(async () => {});
    const assertOwned = vi.fn();
    const finish = vi.fn();

    await completeAcceptedProviderDispatch({ cancelled: true, interrupt, assertOwned, finish });

    expect(interrupt).toHaveBeenCalledOnce();
    expect(assertOwned).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("checks ownership for an uncancelled accepted dispatch", async () => {
    const interrupt = vi.fn(async () => {});
    const assertOwned = vi.fn();
    const finish = vi.fn();

    await completeAcceptedProviderDispatch({ cancelled: false, interrupt, assertOwned, finish });

    expect(interrupt).not.toHaveBeenCalled();
    expect(assertOwned).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("still finishes when the provider interrupt rejects", async () => {
    const finish = vi.fn();

    await completeAcceptedProviderDispatch({
      cancelled: true,
      interrupt: async () => { throw new Error("already settled"); },
      assertOwned: vi.fn(),
      finish,
    });

    expect(finish).toHaveBeenCalledOnce();
  });
});
