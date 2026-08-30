import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  applyBrowserControlHold,
  browserLifecycleResult,
  decodeBrowserLifecycleMessage,
} = require("./browser-control-sync.cjs");

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("private browser control sync", () => {
  it("mirrors a valid server hold into Electron", () => {
    const take = vi.fn();
    expect(applyBrowserControlHold({ type: "openmausbot:browser-control", botId: "bot-a", held: true }, take)).toBe(true);
    expect(take).toHaveBeenCalledWith("bot-a");
  });

  it("never treats a generic server release as authority to clear the local gate", () => {
    const take = vi.fn();
    expect(() => applyBrowserControlHold({ type: "openmausbot:browser-control", botId: "bot-a", held: false }, take))
      .toThrow(/invalid browser-control hold/);
    expect(take).not.toHaveBeenCalled();
  });

  it("rejects malformed bot ids and ignores unrelated private messages", () => {
    expect(() => applyBrowserControlHold({ type: "openmausbot:browser-control", botId: "../other", held: true }, () => {}))
      .toThrow(/invalid browser-control hold/);
    expect(applyBrowserControlHold({ type: "openmausbot:browser-connection" }, () => {})).toBe(false);
  });
});

describe("private browser lifecycle sync", () => {
  it("accepts exact bot/profile deletion messages", () => {
    expect(decodeBrowserLifecycleMessage({
      type: "openmausbot:browser-bot-deleted",
      requestId,
      botId: "bot_A-1",
    })).toEqual({ type: "bot-deleted", requestId, botId: "bot_A-1" });
    expect(decodeBrowserLifecycleMessage({
      type: "openmausbot:browser-profile-deleted",
      requestId,
      partitionId: "Client_1",
    })).toEqual({ type: "profile-deleted", requestId, partitionId: "Client_1" });
  });

  it("builds an exact acknowledgement only for a valid request id", () => {
    expect(browserLifecycleResult(requestId, true)).toEqual({
      type: "openmausbot:browser-lifecycle-result",
      requestId,
      ok: true,
    });
    expect(() => browserLifecycleResult("../request", true)).toThrow(/result id/);
  });

  it("rejects malformed lifecycle ids and ignores unrelated messages", () => {
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-bot-deleted", botId: "../other" }))
      .toThrow(/bot-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-profile-deleted", partitionId: "work!" }))
      .toThrow(/profile-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-profile-deleted", partitionId: "guest" }))
      .toThrow(/profile-deleted/);
    expect(() => decodeBrowserLifecycleMessage({
      type: "openmausbot:browser-profile-deleted",
      requestId: "not-a-request-id",
      partitionId: "Work",
    })).toThrow(/request id/);
    expect(() => decodeBrowserLifecycleMessage({
      type: "openmausbot:browser-profile-deleted",
      profileId: "work",
    })).toThrow(/profile-deleted/);
    expect(decodeBrowserLifecycleMessage({ type: "openmausbot:managed-composio" })).toBeNull();
  });
});
