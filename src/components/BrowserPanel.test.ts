import { describe, expect, it } from "vitest";

import {
  browserProfileChangesDisabled,
  editableUrl,
  profileIdFor,
  shouldRequestBrowserControl,
} from "./BrowserPanel";
import {
  heldComputerControlBotIds,
  transitionBrowserControlLease,
} from "@/lib/computer-control";

describe("browser panel address and profile helpers", () => {
  it("keeps the complete URL that will be submitted", () => {
    const url = "https://example.com/path/to/page?account=work&tab=2#details";
    expect(editableUrl(url)).toBe(url);
    expect(editableUrl("about:blank")).toBe("");
  });

  it("creates partition-safe, collision-free profile ids", () => {
    const profiles = [
      { id: "work-microsoft", name: "Work Microsoft" },
      { id: "work-microsoft-2", name: "Work Microsoft 2" },
    ];
    expect(profileIdFor(" Work / Microsoft ", profiles)).toBe("work-microsoft-3");
    expect(profileIdFor("🔥", profiles)).toBe("profile");
  });

  it("coalesces native focus and input into one take-control request", () => {
    const first = {
      botId: "bot-1",
      eventBotId: "bot-1",
      held: false,
      pending: false,
      takeInFlight: false,
    };
    expect(shouldRequestBrowserControl(first)).toBe(true);
    expect(shouldRequestBrowserControl({ ...first, takeInFlight: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, pending: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, held: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, eventBotId: "bot-2" })).toBe(false);
  });

  it("locks browser profile changes while a bot turn is active", () => {
    expect(browserProfileChangesDisabled({ busy: true })).toBe(true);
    expect(browserProfileChangesDisabled({ busy: false })).toBe(false);
    expect(browserProfileChangesDisabled({})).toBe(false);
  });

  it("mirrors only positive authoritative control snapshots", () => {
    expect(heldComputerControlBotIds({
      "bot-held": { held: true },
      "bot-released": { held: false },
    })).toEqual(["bot-held"]);
    expect(heldComputerControlBotIds({})).toEqual([]);
  });

  it("takes locally before the durable lease and releases in the opposite order", async () => {
    const takeCalls: string[] = [];
    await expect(transitionBrowserControlLease({
      action: "take",
      setNativeControl: async (held) => {
        takeCalls.push(`native:${held}`);
        return true;
      },
      requestDurableControl: async (action) => {
        takeCalls.push(`durable:${action}`);
        return true;
      },
    })).resolves.toEqual({ ok: true });
    expect(takeCalls).toEqual(["native:true", "durable:take"]);

    const releaseCalls: string[] = [];
    await expect(transitionBrowserControlLease({
      action: "release",
      setNativeControl: async (held) => {
        releaseCalls.push(`native:${held}`);
        return true;
      },
      requestDurableControl: async (action) => {
        releaseCalls.push(`durable:${action}`);
        return true;
      },
    })).resolves.toEqual({ ok: true });
    expect(releaseCalls).toEqual(["durable:release", "native:false"]);
  });

  it("fails closed when either durable transition is rejected", async () => {
    const failedTakeCalls: string[] = [];
    await expect(transitionBrowserControlLease({
      action: "take",
      setNativeControl: async (held) => {
        failedTakeCalls.push(`native:${held}`);
        return true;
      },
      requestDurableControl: async (action) => {
        failedTakeCalls.push(`durable:${action}`);
        return false;
      },
    })).resolves.toEqual({ ok: false, failed: "durable-take" });
    expect(failedTakeCalls).toEqual(["native:true", "durable:take"]);

    const failedReleaseCalls: string[] = [];
    await expect(transitionBrowserControlLease({
      action: "release",
      setNativeControl: async (held) => {
        failedReleaseCalls.push(`native:${held}`);
        return true;
      },
      requestDurableControl: async (action) => {
        failedReleaseCalls.push(`durable:${action}`);
        return false;
      },
    })).resolves.toEqual({ ok: false, failed: "durable-release" });
    expect(failedReleaseCalls).toEqual(["durable:release", "native:true"]);
  });
});
