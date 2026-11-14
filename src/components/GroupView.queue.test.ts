// @vitest-environment happy-dom
// Same-room speakers take turns: a member sent work while another runs is
// shown waiting, on whom, and where in line, never as idle.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [] as Bot[] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { RoomQueueList } = await import("./RoomQueueList");

const members = [
  { id: "first", name: "First", color: "blue" },
  { id: "second", name: "Second", color: "green" },
  { id: "third", name: "Third", color: "orange" },
] as Bot[];
const room: Group = {
  id: "room", threadId: "room-thread", name: "Studio", memberIds: members.map((b) => b.id),
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the room's queue", () => {
  it("lists each waiting member with whom it waits on and its place in line", () => {
    flushSync(() => root.render(createElement(RoomQueueList, { members, group: { ...room, queue: [
      { botId: "first", threadId: "room-thread", state: "running", position: 1, of: 3 },
      { botId: "second", threadId: "room-thread", state: "queued", position: 2, of: 3, waitingForBotId: "first" },
      { botId: "third", threadId: "room-thread", state: "queued", position: 3, of: 3, waitingForBotId: "first" },
      { botId: "first", threadId: "other-thread", state: "queued", position: 2, of: 2 },
    ] } })));
    const rows = [...host.querySelectorAll('[data-testid="room-queue"] li')].map((li) => li.textContent);
    expect(rows).toEqual(["Second: Queued · waiting for First (2 of 3)", "Third: Queued · waiting for First (3 of 3)"]);
  });

  it("shows nothing when nobody waits in the open thread", () => {
    flushSync(() => root.render(createElement(RoomQueueList, { members, group: { ...room, queue: [] } })));
    expect(host.querySelector('[data-testid="room-queue"]')).toBeNull();
  });
});
