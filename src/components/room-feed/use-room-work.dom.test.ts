// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem, BoardItemFrame } from "../../../shared/board";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  asked: [] as string[],
  answer: { items: [] as unknown[], you: "p_me" },
  listener: null as null | { onFrame: (frame: unknown) => void; onMissedFrames?: () => void },
}));
vi.mock("@/state/api", async (original) => ({ ...(await original<typeof import("@/state/api")>()),
  api: vi.fn(async (path: string) => { fixture.asked.push(path); return fixture.answer; }) }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: (listener: typeof fixture.listener) => { fixture.listener = listener; return () => { fixture.listener = null; }; } }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: unknown) => unknown) => select({ config: fixture.config }) }));

const { useRoomWorkStatuses } = await import("./use-room-work");

const item = (threadId: string, extra: Partial<BoardItem>): BoardItem => ({ threadId, groupId: "g1", title: threadId, state: "ready", needs: [], labels: {}, attempts: 0,
  createdBy: { kind: "bot", id: "lead", name: "Lead" }, createdAt: 1, updatedAt: 1, ...extra });
const BOTS = [{ id: "writer", name: "Writer" }];

let root: Root | null = null;
let seen: ReadonlyMap<string, { label: string }> = new Map();
function Probe({ groupId }: { groupId: string }) {
  seen = useRoomWorkStatuses(groupId, BOTS);
  return null;
}
const mount = async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(Probe, { groupId: "g1" })));
};
const labels = () => Object.fromEntries([...seen].map(([threadId, status]) => [threadId, status.label]));
afterEach(() => { act(() => root?.unmount()); root = null; fixture.asked = []; fixture.listener = null; fixture.config = {}; });

describe("a room's work statuses", () => {
  it("asks for nothing off a Team Cloud", async () => {
    await mount();
    expect(fixture.asked).toEqual([]);
    expect(fixture.listener).toBeNull();
    expect(seen.size).toBe(0);
  });

  it("reads the room's items on a Team Cloud and follows its live frames, only for this room", async () => {
    fixture.config = { team: { id: "t", name: "Acme" } };
    fixture.answer = { items: [item("a", { state: "working", holder: { botId: "writer", since: 1 } }), item("b", { state: "cancelled" })], you: "p_me" };
    await mount();
    expect(fixture.asked).toEqual(["/api/board?groupId=g1"]);
    expect(labels()).toEqual({ a: "Writer working" });
    const frame = (threadId: string, next: BoardItem | null, groupId = "g1"): BoardItemFrame => ({ kind: "board.item", groupId, threadId, item: next });
    await act(async () => fixture.listener!.onFrame(frame("c", item("c", { state: "needs_person", question: { text: "?", askedAt: 1, person: "p_me" } }))));
    await act(async () => fixture.listener!.onFrame(frame("a", item("a", { state: "done" }))));
    await act(async () => fixture.listener!.onFrame(frame("x", item("x", {}), "g2")));
    expect(labels()).toEqual({ a: "Done", c: "Needs you" });
    await act(async () => fixture.listener!.onFrame(frame("c", null)));
    expect(labels()).toEqual({ a: "Done" });
    await act(async () => fixture.listener!.onMissedFrames!());
    expect(fixture.asked).toHaveLength(2);
  });
});
