import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { applyBrowserControlHold, decodeBrowserLifecycleMessage } = require("./browser-control-sync.cjs");

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
    expect(decodeBrowserLifecycleMessage({ type: "openmausbot:browser-bot-deleted", botId: "bot_A-1" }))
      .toEqual({ type: "bot-deleted", botId: "bot_A-1" });
    expect(decodeBrowserLifecycleMessage({ type: "openmausbot:browser-profile-deleted", profileId: "client_1" }))
      .toEqual({ type: "profile-deleted", profileId: "client_1" });
  });

  it("rejects malformed lifecycle ids and ignores unrelated messages", () => {
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-bot-deleted", botId: "../other" }))
      .toThrow(/bot-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-profile-deleted", profileId: "Work" }))
      .toThrow(/profile-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "openmausbot:browser-profile-deleted", profileId: "guest" }))
      .toThrow(/profile-deleted/);
    expect(decodeBrowserLifecycleMessage({ type: "openmausbot:managed-composio" })).toBeNull();
  });
});
