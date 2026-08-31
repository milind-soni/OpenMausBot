import { describe, expect, it, vi } from "vitest";

import { transitionComputerControlLease } from "../lib/computer-control";

const snap = (held: boolean) => ({ held, helpReason: null });

describe("computer control transitions", () => {
  it("returns the snapshot when the server confirms the take", async () => {
    const calls: string[] = [];
    const result = await transitionComputerControlLease({
      action: "take",
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    expect(calls).toEqual(["server:take"]);
    expect(result.held).toBe(true);
  });

  it("fails loudly when the server did not release the lease", async () => {
    await expect(transitionComputerControlLease({
      action: "release",
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
  });

  it("fails loudly when the server did not confirm the take", async () => {
    await expect(transitionComputerControlLease({
      action: "take",
      requestControl: async () => snap(false),
    })).rejects.toThrow(/could not confirm/i);
  });

  it("passes dismiss-help straight through without a held check", async () => {
    const requestControl = vi.fn(async () => snap(false));
    await transitionComputerControlLease({ action: "dismiss-help", requestControl });
    expect(requestControl).toHaveBeenCalledWith("dismiss-help");
  });
});
