import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  aspectFitBrowserBounds,
  BrowserSurfacePlaceholder,
  browserInteractionPlan,
  browserSurfaceForProfile,
  browserSurfacePresentation,
  browserProfileChangesDisabled,
  editableUrl,
  profileIdFor,
  shouldAcceptBrowserSurfaceState,
  shouldClearBrowserSurfaceFailure,
} from "./BrowserPanel";
import {
  heldComputerControlBotIds,
  transitionBrowserControlLease,
} from "@/lib/computer-control";

const surface = (overrides: Partial<BrowserSurfaceState> = {}): BrowserSurfaceState => ({
  botId: "bot-1",
  open: true,
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  partition: "persist:profile-work",
  profile: "profile-work",
  mode: "compact",
  ...overrides,
});

describe("browser panel address and profile helpers", () => {
  it("keeps the complete URL that will be submitted", () => {
    const url = "https://example.com/path/to/page?account=work&tab=2#details";
    expect(editableUrl(url)).toBe(url);
    expect(editableUrl("about:blank")).toBe("");
  });

  it("centers the 16:10 page inside wide and tall expanded workspaces", () => {
    expect(aspectFitBrowserBounds({ x: 10, y: 20, width: 1_000, height: 500 })).toEqual({
      x: 110,
      y: 20,
      width: 800,
      height: 500,
    });
    expect(aspectFitBrowserBounds({ x: 10, y: 20, width: 800, height: 800 })).toEqual({
      x: 10,
      y: 170,
      width: 800,
      height: 500,
    });
    expect(aspectFitBrowserBounds({ x: 10, y: 20, width: 1_280, height: 800 })).toEqual({
      x: 10,
      y: 20,
      width: 1_280,
      height: 800,
    });
  });

  it("creates partition-safe, collision-free profile ids", () => {
    const profiles = [
      { id: "work-microsoft", name: "Work Microsoft" },
      { id: "work-microsoft-2", name: "Work Microsoft 2" },
    ];
    expect(profileIdFor(" Work / Microsoft ", profiles)).toBe("work-microsoft-3");
    expect(profileIdFor("🔥", profiles)).toBe("profile");
    expect(profileIdFor("Guest", profiles)).toBe("guest-2");
  });

  it("coalesces native focus and input and still reopens a controlled compact page", () => {
    const first = {
      botId: "bot-1",
      eventBotId: "bot-1",
      profile: "profile-work",
      eventProfile: "profile-work",
      compact: false,
      held: false,
      pending: false,
      takeInFlight: false,
    };
    expect(browserInteractionPlan(first)).toBe("take");
    expect(browserInteractionPlan({ ...first, compact: true })).toBe("expand-and-take");
    expect(browserInteractionPlan({ ...first, compact: true, held: true })).toBe("expand");
    expect(browserInteractionPlan({ ...first, takeInFlight: true })).toBe("ignore");
    expect(browserInteractionPlan({ ...first, pending: true })).toBe("ignore");
    expect(browserInteractionPlan({ ...first, held: true })).toBe("ignore");
    expect(browserInteractionPlan({ ...first, eventBotId: "bot-2" })).toBe("ignore");
    expect(browserInteractionPlan({ ...first, eventProfile: "profile-personal" })).toBe("ignore");
  });

  it("locks browser profile changes while a bot turn or local browser transition is active", () => {
    expect(browserProfileChangesDisabled({ busy: true })).toBe(true);
    expect(browserProfileChangesDisabled({ busy: false }, { browserAction: true })).toBe(true);
    expect(browserProfileChangesDisabled({ busy: false }, { controlTransition: true })).toBe(true);
    expect(browserProfileChangesDisabled({ busy: false })).toBe(false);
    expect(browserProfileChangesDisabled({})).toBe(false);
  });

  it("never leaks the old profile's page or address into a new selection", () => {
    const work = surface({ url: "https://work.example/inbox" });
    expect(browserSurfaceForProfile(work, "bot-1", "profile-work")).toBe(work);
    expect(browserSurfaceForProfile(work, "bot-1", "profile-personal")).toBeNull();
    expect(browserSurfaceForProfile(work, "bot-2", "profile-work")).toBeNull();
    expect(browserSurfacePresentation({
      surface: work,
      botId: "bot-1",
      profile: "profile-personal",
    })).toBe("connecting");
    expect(shouldAcceptBrowserSurfaceState(work, "bot-1", "profile-personal")).toBe(false);
    expect(shouldAcceptBrowserSurfaceState(
      surface({ profile: "profile-personal", url: "https://personal.example" }),
      "bot-1",
      "profile-personal",
    )).toBe(true);
    expect(shouldAcceptBrowserSurfaceState(
      surface({ open: false, profile: null, code: "renderer-gone" }),
      "bot-1",
      "profile-personal",
    )).toBe(false);
    expect(shouldAcceptBrowserSurfaceState(
      surface({ open: false, profile: "profile-personal", code: "renderer-gone" }),
      "bot-1",
      "profile-personal",
    )).toBe(true);
  });

  it("derives explicit connecting, empty, loading, ready, and failed page states", () => {
    const common = { botId: "bot-1", profile: "profile-work" };
    expect(browserSurfacePresentation({ surface: null, ...common })).toBe("connecting");
    expect(browserSurfacePresentation({ surface: surface(), ...common })).toBe("empty");
    expect(browserSurfacePresentation({ surface: surface({ loading: true }), ...common })).toBe("loading");
    expect(browserSurfacePresentation({
      surface: surface({ url: "https://example.com" }),
      ...common,
    })).toBe("ready");
    expect(browserSurfacePresentation({
      surface: surface({ url: "https://example.com" }),
      actionPending: true,
      ...common,
    })).toBe("loading");
    expect(browserSurfacePresentation({
      surface: surface({ open: false, profile: null, code: "renderer-gone" }),
      failureCode: "renderer-gone",
      ...common,
    })).toBe("failed");
  });

  it("renders useful empty, loading, and recoverable failure chrome", () => {
    const empty = renderToStaticMarkup(createElement(BrowserSurfacePlaceholder, {
      presentation: "empty",
      botName: "Sprout",
    }));
    const loading = renderToStaticMarkup(createElement(BrowserSurfacePlaceholder, {
      presentation: "loading",
      botName: "Sprout",
    }));
    const failed = renderToStaticMarkup(createElement(BrowserSurfacePlaceholder, {
      presentation: "failed",
      botName: "Sprout",
      failureCode: "renderer-gone",
      onRetry: vi.fn(),
    }));

    expect(empty).toContain("Nothing open yet");
    expect(empty).toContain("Sprout");
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Opening page");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Page unavailable");
    expect(failed).toContain("Retry");
  });

  it("keeps a terminal failure visible until retry creates a replacement surface", () => {
    const closed = surface({ open: false, profile: null, url: "" });
    expect(shouldClearBrowserSurfaceFailure("failed", closed)).toBe(false);
    expect(shouldClearBrowserSurfaceFailure("loading", closed)).toBe(true);
    expect(shouldClearBrowserSurfaceFailure(
      "loading",
      surface({ open: false, profile: null, url: "", code: "renderer-gone" }),
    )).toBe(false);
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
