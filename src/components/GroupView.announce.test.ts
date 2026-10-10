import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Group } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { StoreProvider } = await import("@/state/store");
const { GroupView } = await import("./GroupView");
afterAll(() => vi.unstubAllGlobals());

const group: Group = {
  id: "room", threadId: "room-thread", name: "Standup", memberIds: [], defaultResponder: "all",
  bulletin: "", unread: false, createdAt: 1, dm: true, messages: [],
} as unknown as Group;

// Same rule as the one-on-one chat: the room transcript is browsable but not
// live, and one hidden status line speaks when a member's reply is done.
describe("room screen reader announcements", () => {
  it("keeps the room log quiet and renders one status line", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupView, { group })));
    expect(markup).toMatch(/role="log" aria-live="off" aria-label="[^"]*Standup[^"]*"/);
    expect(markup.match(/data-testid="transcript-announcer"/g)).toHaveLength(1);
  });
});
