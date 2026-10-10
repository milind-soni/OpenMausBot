// A turn the trial's Claude credit refused, as chat shows it: the row's
// stored English words (shared/trial-credit.ts, read whole by the phones)
// said again in the reader's language, with the one next step: connect their
// own AI when the credit is used up, gone or too low for the chat, and try
// again when it is only paused.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { TRIAL_CREDIT_REFUSED } from "../../shared/trial-credit";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {}, instances: [] as InstanceInfo[], bots: [] }, dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const engine = { instanceId: "trial-credit", trialCredit: "used_up" } as unknown as InstanceInfo;
const stored = (kind: keyof typeof TRIAL_CREDIT_REFUSED): NonNullable<Message["tool"]> => failedTurnTool(TRIAL_CREDIT_REFUSED[kind], { setup: kind !== "paused" });
const show = (tool: NonNullable<Message["tool"]>, onRetry?: () => void) => {
  const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine, onRetry }));
  return { html, buttons: (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map(button => button.replace(/<[^>]+>/g, "")) };
};

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a turn the trial's Claude credit refused", () => {
  it("is said in the reader's language, never the server's English, with connect your own AI as the next step", () => {
    setLocale("de");
    const usedUp = show(stored("used_up"));
    expect(usedUp.html).toContain("Dein Claude-Guthaben der Testphase ist aufgebraucht.");
    expect(usedUp.html).not.toContain("Your trial Claude credit is used up");
    expect(usedUp.buttons).toEqual(["Eigene KI verbinden"]);
    expect(show(stored("ended")).html).toContain("Das Claude-Guthaben der Testphase ist auf My Cloud nicht mehr verfügbar.");
    expect(show(stored("too_low")).html).toContain("reicht für diesen Chat nicht aus");
    // Paused is for now: try again, nothing to connect.
    const paused = show(stored("paused"), vi.fn());
    expect(paused.html).toContain("Das Claude-Guthaben der Testphase ist vorübergehend pausiert.");
    expect(paused.buttons.some(label => label.includes("Eigene KI"))).toBe(false);
  });

  it("is told apart by its words alone, whichever engine the turn ran on", () => {
    const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool: stored("used_up"), engine: undefined }));
    expect(html).toContain("Your trial Claude credit is used up. Sign in with your own Claude or ChatGPT account, or add an API key, to keep your bots working.");
    expect(html).toContain("Connect your own AI");
  });
});
