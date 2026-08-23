import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentCall, deferCallCleanup, endCall, matchSpokenOption, startCall } from "./call";

describe("call ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    endCall();
  });

  it("does not let stale cleanup hang up a newer call", () => {
    startCall("bot-a");
    startCall("bot-b");

    expect(endCall("bot-a")).toBe(false);
    expect(currentCall()).toBe("bot-b");
    expect(endCall("bot-b")).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("does not let StrictMode's effect probe hang up a new call", async () => {
    startCall("bot-a");
    let mounted = false;
    deferCallCleanup("bot-a", () => mounted);
    mounted = true;

    await Promise.resolve();

    expect(currentCall()).toBe("bot-a");
  });

  it("hangs up after a genuine call-screen unmount", async () => {
    startCall("bot-a");
    deferCallCleanup("bot-a", () => false);

    await Promise.resolve();

    expect(currentCall()).toBeNull();
  });

  it("matches a spoken option without requiring accents or case", () => {
    expect(matchSpokenOption(["Café", "Thé"], "cafe")).toBe("Café");
    expect(matchSpokenOption(["Café", "Thé"], "inconnu")).toBeUndefined();
  });
});
