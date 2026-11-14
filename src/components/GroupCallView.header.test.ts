import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", { ogb: { speechStart: () => {} } });
  return { advanced: true };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: { tts: { configured: true, ready: true } } }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, dictation: { available: true } }, ready: true }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));

const { GroupCallButton, RoomHeaderCallButton } = await import("./GroupCallView");
afterAll(() => vi.unstubAllGlobals());

const ada: Bot = {
  id: "ada", threadId: "ada-thread", name: "Ada", title: "", description: "", color: "green", voice: "v",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "codex", model: "m" },
};
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: ["ada"],
  defaultResponder: { kind: "member", botId: "ada" }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
};

describe("a room's call button", () => {
  it("stays in the room header in Advanced mode", () => {
    fixture.advanced = true;
    expect(renderToStaticMarkup(createElement(RoomHeaderCallButton, { group: room, members: [ada] }))).toContain('data-call-button="header"');
  });

  it("leaves the header in Simple mode, where the composer calls the room", () => {
    fixture.advanced = false;
    expect(renderToStaticMarkup(createElement(RoomHeaderCallButton, { group: room, members: [ada] }))).toBe("");
    const composer = renderToStaticMarkup(createElement(GroupCallButton, { group: room, members: [ada], placement: "composer", fill: "var(--color-accent)" }));
    expect(composer).toContain('data-call-button="composer"');
    expect(composer).toContain("background-color:var(--color-accent)");
    expect(composer).toContain("rounded-full");
    fixture.advanced = true;
  });
});
