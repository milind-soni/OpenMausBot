// A failed turn whose place could not be used, as the app shows it: the row's
// stored state worded again (shared/place-view.ts) as one line and at most
// one button, in the reader's role and mode. The phones read only the row's
// English words, so those carry the same line and the same action.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause, failedTurnTool } from "../../shared/failed-turn";
import { placeRowText, type PlaceRow } from "../../shared/place-view";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), advanced: false, ownerOrAdmin: null as boolean | null, bots: [] as Bot[], config: {} as Record<string, unknown> };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config, instances: [] as InstanceInfo[], bots: fixture.bots },
    dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const { placeRowViewFor } = await import("@/lib/place-view");


/** The row exactly as the server stores it. */
const stored = (place: PlaceRow): NonNullable<Message["tool"]> => failedTurnTool(placeRowText(place), { place });
const hours: PlaceRow = { state: "cc-no-hours", params: { bot: "Scout", plan: "Pro", hours: 50, month: "November" }, source: "works-on" };

/** Render the row and read its buttons off the rendered tree. */
function show(tool: NonNullable<Message["tool"]>, onRetry?: () => void) {
  const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, botId: "scout", threadId: "thread-scout", onRetry }));
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return { html, buttons };
}

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.advanced = false;
  fixture.ownerOrAdmin = null;
  fixture.config = {};
  fixture.bots = [{ id: "scout", name: "Scout", computer: "cloud", modelSelection: { instanceId: "claude", model: "m" } } as Bot];
});

describe("J11: a failed place's row", () => {
  it("says no hours are left in one line, with one button: See your plan", () => {
    const { html, buttons } = show(stored(hours), vi.fn());
    expect(html).toContain("This month&#x27;s 50 cloud computer hours are used up. They come back on 1 November.");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("See your plan");
    // no Retry beside it, and no second copy of the words under Details
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<details");
  });

  it("offers Try again only where the conversation can retry", () => {
    const passing = stored({ state: "cc-unavailable", params: { bot: "Scout" }, source: "works-on" });
    expect(show(passing, vi.fn()).buttons).toHaveLength(1);
    expect(show(passing, vi.fn()).buttons[0]).toContain("Try again");
    expect(show(passing).buttons).toHaveLength(0);
  });

  it("leads a person's pin back to the grid's choice in Simple, and to the composer's in Advanced", () => {
    const pinned = stored({ state: "cc-no-start", params: { bot: "Scout" }, source: "pin" });
    expect(show(pinned).buttons[0]).toContain("Use Cloud computer");
    fixture.advanced = true;
    expect(show(pinned).buttons[0]).toContain("Clear this conversation&#x27;s place");
  });

  it("gives a User no button that changes a setting, and says who can", () => {
    fixture.ownerOrAdmin = false;
    const { html, buttons } = show(stored(hours), vi.fn());
    expect(html).toContain("They come back on 1 November. Ask an Admin to change it.");
    expect(buttons).toHaveLength(0);
  });

  it("reads Needs a Boat key as My Cloud's on a desktop with a paid plan", () => {
    const needsKey: PlaceRow = { state: "cc-needs-key", params: { bot: "Scout" }, source: "works-on" };
    expect(show(stored(needsKey)).html).toContain("A cloud computer here needs your own Boat key, a paid service.");
    const seat = { server: "mac", plan: true, role: "admin", mode: "simple" } as const;
    expect(placeRowViewFor(needsKey, seat)).toMatchObject({
      state: "cc-on-my-cloud", line: "Cloud computers from your plan work for bots on My Cloud for now.", action: { id: "open-my-cloud" },
    });
    // My Cloud itself never reads it that way.
    expect(placeRowViewFor(needsKey, { ...seat, server: "my-cloud" }).state).toBe("cc-needs-key");
  });
});

describe("the phone row", () => {
  // What iOS (ChatPreferences.swift failedTurnCause) and Android
  // (ChatPreferences.kt failedTurnCause) do with a row: drop "error:" and
  // show the rest. They never read `place`.
  const phoneCause = (name: string) => name.startsWith("error:") ? name.slice("error:".length).trim() : null;

  it("carries the line and its action in words, whole, for every source", () => {
    const rows: Array<[PlaceRow, string]> = [
      [hours, "This month's 50 cloud computer hours are used up. They come back on 1 November. See your plan on the Plan page."],
      [{ state: "cc-unavailable", params: { bot: "Scout" }, source: "auto-pin" },
        "Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto. Send your message again."],
      [{ state: "cc-unavailable", params: { bot: "Scout" }, source: "routine" },
        "Cloud computers can't start right now. It isn't anything you did. Change where this routine runs."],
      [{ state: "cc-at-once", params: { bot: "Bo", plan: "Personal", max: 1, holders: ["Ada"] }, source: "works-on" },
        "Your Personal plan includes 1 cloud computer, and Ada has it. Manage your cloud computers in Settings → Local VM."],
    ];
    for (const [place, words] of rows) {
      const tool = stored(place);
      // Sent to a phone as JSON, read back the phone's way.
      const onPhone = JSON.parse(JSON.stringify(tool)) as { name: string };
      expect(phoneCause(onPhone.name)).toBe(words);
      expect(failedTurnCause(onPhone.name)).toBe(words);
    }
  });
});
