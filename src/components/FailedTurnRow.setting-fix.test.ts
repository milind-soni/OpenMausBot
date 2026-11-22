// A failed turn that one setting fixes offers that setting on its row, so nobody has to find it in Settings.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), bots: [] as Bot[], admin: true as boolean | null, advanced: true, phone: false };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: {}, instances: [] as InstanceInfo[], bots: fixture.bots },
    dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/use-media-query", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/use-media-query")>(), useMediaQuery: () => fixture.phone }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./FailedTurnRow");

const CREDITS = "Your OpenRouter account is out of credits. Add credits with OpenRouter, then run it again.";
const show = (tool: NonNullable<Message["tool"]>, room = false) =>
  renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, onRetry: vi.fn(), botId: "scout", threadId: room ? undefined : "t-scout" }));
const buttons = (html: string) => (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map((button) => button.replace(/<[^>]+>/g, ""));

beforeEach(() => {
  setLocale("en");
  Object.assign(fixture, { admin: true, advanced: true, phone: false });
  fixture.bots = [{ id: "scout", name: "Scout", threadId: "t-scout", modelSelection: { instanceId: "openrouter", model: "free-model" } } as Bot];
});

describe("a failed turn one setting fixes", () => {
  it("offers the bot's model picker when its AI is out of credits or limited, beside Retry", () => {
    for (const cause of [CREDITS, "Groq hit a rate limit (HTTP 429). Wait a minute, then run it again."]) {
      const html = show(failedTurnTool(cause));
      expect(html, cause).toContain('data-failed-turn-fix="model"');
      expect(html, cause).toContain("Switch model");
      expect(buttons(html).some((label) => label.includes("Retry")), cause).toBe(true);
    }
  });

  it("leaves the picker out in a room's row and on the phone layout, as the header does", () => {
    expect(show(failedTurnTool(CREDITS), true)).not.toContain("data-failed-turn-fix");
    fixture.phone = true;
    expect(show(failedTurnTool(CREDITS))).not.toContain("data-failed-turn-fix");
  });


  it("adds nothing to a failure no setting fixes, or for a bot it does not know", () => {
    expect(show(failedTurnTool("the process running this turn's AI ended — the turn was stopped"))).not.toContain("data-failed-turn-fix");
    fixture.bots = [];
    expect(show(failedTurnTool(CREDITS))).not.toContain("data-failed-turn-fix");
  });
});
