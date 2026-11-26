// @vitest-environment happy-dom
// Every conversation row in the Inbox leads with whose it is: the bot's own picture, or the room mark for a room,
// with the row's status on the picture's corner.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { AttentionThreadRows, botFaces, type AttentionThread } from "../SidebarBotActivity";
import { FinishedThreads, finishedThreads } from "./FinishedThreads";
import { PinnedThreads, pinnedThreadRows } from "./PinnedThreads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-25T08:00:00Z");
const PICTURE = "/api/attachments/eli-face.png";
const task = (threadId: string, patch: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 0, updatedAt: NOW, ...patch });
const eli = (tasks: Task[]): Bot => ({ id: "eli", name: "Eli", color: "blue", avatarUrl: PICTURE, avatarCrop: "circle", tasks } as unknown as Bot);
const room = (tasks: GroupTask[]): Group =>
  ({ id: "room", threadId: "room-main", name: "Room", memberIds: [], unread: false, createdAt: 0, tasks } as unknown as Group);
const roomTask = (patch: Partial<GroupTask> = {}): GroupTask => ({ threadId: "room-main", title: "room chat", createdAt: 0, updatedAt: NOW - 60_000, ...patch });
const working = (botId: string, botName: string): AttentionThread =>
  ({ kind: "bot", botId, botName, task: { ...task("working", { busy: true }), queued: false } });

let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(async () => { root.render(element); });
const faces = (rowSelector: string) => [...document.querySelectorAll<HTMLElement>(`${rowSelector} [data-attention-face]`)];
const pictureOf = (face: HTMLElement) => face.querySelector("img")?.getAttribute("src");

beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement("div"))); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

describe("faces on the Inbox's conversation rows", () => {
  it("leads each pinned row with the bot's picture, and a room's with the room mark", async () => {
    const bots = [eli([task("pinned", { pinned: true })])];
    const groups = [room([roomTask({ pinned: true })])];
    await render(createElement(PinnedThreads, { rows: pinnedThreadRows(bots, groups, {}), faces: botFaces(bots), now: NOW, onOpen: vi.fn(), onUnpin: vi.fn() }));
    const shown = faces("[data-pinned-row]");
    expect(shown.map((face) => face.dataset.attentionFace)).toEqual(["bot", "group"]);
    expect(pictureOf(shown[0]!)).toBe(PICTURE);
  });

  it("leads each finished row with the bot's picture, and a room's with the room mark", async () => {
    const bots = [eli([task("done", { lastReadMessageId: "m1" })])];
    const groups = [room([roomTask({ lastReadMessageId: "m2" })])];
    await render(createElement(FinishedThreads, { rows: finishedThreads(bots, groups, {}), faces: botFaces(bots), now: NOW, onOpen: vi.fn() }));
    const shown = faces("[data-inbox-finished] button");
    expect(shown.map((face) => face.dataset.attentionFace)).toEqual(["bot", "group"]);
    expect(pictureOf(shown[0]!)).toBe(PICTURE);
  });

  it("leads each at-work row with the bot's picture when the list is given faces", async () => {
    await render(createElement(AttentionThreadRows, { entries: [working("eli", "Eli")], faces: botFaces([eli([])]), inset: true, onJump: vi.fn() }));
    const shown = faces("button");
    expect(shown).toHaveLength(1);
    expect(pictureOf(shown[0]!)).toBe(PICTURE);
  });

  it("keeps the sidebar's rows as they were: no faces unless asked for", async () => {
    await render(createElement(AttentionThreadRows, { entries: [working("eli", "Eli")], inset: true, onJump: vi.fn() }));
    expect(faces("button")).toHaveLength(0);
  });

  it("still draws a face for a bot it has no picture details for", async () => {
    await render(createElement(AttentionThreadRows, { entries: [working("gone", "Gone")], faces: [], inset: true, onJump: vi.fn() }));
    expect(faces("button")).toHaveLength(1);
  });
});
