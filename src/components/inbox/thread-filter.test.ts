import { describe, expect, it } from "vitest";
import type { AttentionThread } from "../SidebarBotActivity";
import { matchesThreadFilter, threadFilterOn, threadOwners, threadStatus } from "./thread-filter";

const row = (botId: string, task: Partial<AttentionThread["task"]> = {}): AttentionThread =>
  ({ kind: "bot", botId, botName: botId.toUpperCase(), task: { threadId: `${botId}-t`, title: "t", queued: false, ...task } } as AttentionThread);
const room = (groupId: string): AttentionThread =>
  ({ kind: "group", groupId, groupName: `Room ${groupId}`, groupThreadId: "main", task: { threadId: "main", title: "t", queued: false } } as AttentionThread);

describe("the inbox's thread filters", () => {
  it("sorts a conversation the way its own status line does: waiting before working", () => {
    expect(threadStatus(row("a", { activity: "waiting-on-you", busy: true }).task)).toBe("waiting");
    expect(threadStatus(row("a", { waitingForTeammates: true, busy: true }).task)).toBe("waiting");
    expect(threadStatus(row("a", { busy: true }).task)).toBe("working");
    expect(threadStatus(row("a", { queued: true }).task)).toBe("working");
    expect(threadStatus(row("a", { unread: true }).task)).toBe("finished");
  });

  it("matches on bot or room and on status together, and matches everything with nothing picked", () => {
    const busy = row("a", { busy: true });
    expect(threadFilterOn({})).toBe(false);
    expect(matchesThreadFilter(busy, {})).toBe(true);
    expect(matchesThreadFilter(busy, { owner: { key: "bot:a", name: "A" }, status: "working" })).toBe(true);
    expect(matchesThreadFilter(busy, { owner: { key: "bot:b", name: "B" } })).toBe(false);
    expect(matchesThreadFilter(busy, { status: "finished" })).toBe(false);
    expect(matchesThreadFilter(room("r"), { owner: { key: "group:r", name: "Room r" } })).toBe(true);
  });

  it("lists each owner once by name, and keeps the picked one when it has nothing left", () => {
    expect(threadOwners([row("b"), row("a"), row("b"), room("r")])).toEqual([
      { key: "bot:a", name: "A" }, { key: "bot:b", name: "B" }, { key: "group:r", name: "Room r" },
    ]);
    expect(threadOwners([row("a")], { key: "bot:z", name: "Zed" }).map((owner) => owner.name)).toEqual(["A", "Zed"]);
  });
});
