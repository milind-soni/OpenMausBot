import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
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
const { activityPreview } = await import("@/lib/failed-turn");
const cause = "Stopped because the tool call “read_file” failed. The bot's reply isn't proof the work was done; the failed step shows the error.";
const show = (tool: NonNullable<Message["tool"]>) => renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, onRetry: vi.fn() }));

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a turn whose reply came back but a step failed", () => {
  it("reads as partly done, not as a broken turn, with the cause under Details and Retry kept", () => {
    const html = show(failedTurnTool(cause, { terminal: true, partial: true }));
    expect(html).toContain("Partly done. The reply came back, but a step didn&#x27;t work");
    expect(html).toContain("warning");
    expect(html).not.toMatch(/danger|lucide-triangle-alert|lucide-alert-triangle/);
    expect(html).toMatch(/<details[\s\S]*Details[\s\S]*Stopped because the tool call/);
    expect(html).toContain("Retry");
  });

  it("is still the red failure row when the turn did not finish", () => {
    const html = show(failedTurnTool(cause, { terminal: true }));
    expect(html).toContain("danger");
    expect(html).not.toContain("Partly done");
  });

  it("says partly done in the chat list preview too", () => {
    expect(activityPreview(failedTurnTool(cause, { partial: true }), undefined)).toBe("Partly done: a step didn't work");
    expect(activityPreview(failedTurnTool(cause), undefined)).not.toContain("Partly done");
  });
});
