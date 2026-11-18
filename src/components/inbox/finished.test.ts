// Which conversations the Inbox's finished list shows.
import { describe, expect, it } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { finishedThreads } from "./FinishedThreads";

const task = (threadId: string, patch: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 0, updatedAt: 1, ...patch });
const bot = (id: string, tasks: Task[]): Bot => ({ id, name: id, tasks } as unknown as Bot);
const group = (tasks: GroupTask[], patch: Partial<Group> = {}): Group =>
  ({ id: "room", threadId: "room-main", name: "Room", memberIds: [], unread: false, createdAt: 0, tasks, ...patch } as unknown as Group);

describe("finishedThreads", () => {
  it("shows read, idle conversations and hides unread, busy or archived ones", () => {
    const bots = [bot("eli", [
      task("read", { updatedAt: 30 }),
      task("unread", { updatedAt: 40, unread: true }),
      task("busy", { updatedAt: 50, busy: true }),
      task("working", { updatedAt: 60, activity: "working" }),
      task("archived", { updatedAt: 70, archivedAt: 5 }),
      task("routine", { updatedAt: 80, routineRunId: "run-1" }),
    ])];
    expect(finishedThreads(bots).map((row) => row.task.threadId)).toEqual(["read"]);
  });

  it("keeps the ten newest by when the conversation last moved", () => {
    const bots = [bot("eli", Array.from({ length: 12 }, (_, i) => i + 1).map((n) => task(`t${n}`, { updatedAt: n })))];
    expect(finishedThreads(bots).map((row) => row.task.threadId)).toEqual(["t12", "t11", "t10", "t9", "t8", "t7", "t6", "t5", "t4", "t3"]);
  });

  it("leaves out a thread that never got going", () => {
    const bots = [bot("eli", [task("empty", { createdAt: 5, updatedAt: 5 }), task("used", { updatedAt: 9 })])];
    expect(finishedThreads(bots).map((row) => row.task.threadId)).toEqual(["used"]);
  });

  it("keeps a conversation opened from a message although it never moved again", () => {
    const quoted = task("quoted", { createdAt: 5, updatedAt: 5, origin: { threadId: "main", messageId: "m1" } as Task["origin"] });
    const bots = [bot("eli", [quoted, task("empty", { createdAt: 6, updatedAt: 6 })])];
    expect(finishedThreads(bots).map((row) => row.task.threadId)).toEqual(["quoted"]);
  });

  it("shows a conversation the person read in the Inbox although the chat was never opened", () => {
    const bots = [bot("eli", [task("read-in-inbox", { updatedAt: 9, unread: true })])];
    expect(finishedThreads(bots).map((row) => row.task.threadId)).toEqual([]);
    expect(finishedThreads(bots, [], {}, 5, new Set(["read-in-inbox"])).map((row) => row.task.threadId)).toEqual(["read-in-inbox"]);
  });

  it("leaves out a conversation the pinned section already shows", () => {
    const bots = [bot("eli", [task("pinned", { updatedAt: 2 }), task("plain", { updatedAt: 1 })])];
    expect(finishedThreads(bots, [], {}, 5, undefined, new Set(["pinned"])).map((row) => row.task.threadId)).toEqual(["plain"]);
  });

  it("leaves out a conversation still queued behind another", () => {
    const bots = [bot("eli", [task("read", { updatedAt: 1 }), task("queued", { updatedAt: 2 })])];
    expect(finishedThreads(bots, [], { queued: [{}] }).map((row) => row.task.threadId)).toEqual(["read"]);
  });

  it("shows a room's read, idle conversation and leaves out the working, unread or archived ones", () => {
    const room = group([
      { threadId: "room-main", title: "room", createdAt: 0, updatedAt: 7 },
      { threadId: "room-working", title: "working", createdAt: 0, updatedAt: 8, working: true },
      { threadId: "room-unread", title: "unread", createdAt: 0, updatedAt: 9, unread: true },
      { threadId: "room-archived", title: "archived", createdAt: 0, updatedAt: 10, archivedAt: 1 },
    ]);
    expect(finishedThreads([], [room]).map((row) => [row.kind, row.task.threadId])).toEqual([["group", "room-main"]]);
  });

  it("leaves out a room whose latest word waits on the person", () => {
    const chief = { id: "chief", name: "Chief", activity: "waiting-on-you", tasks: [] } as unknown as Bot;
    const room = group([{ threadId: "room-ask", title: "ask", createdAt: 0, updatedAt: 9, busyBotId: "chief" }]);
    expect(finishedThreads([chief], [room])).toEqual([]);
  });

  it("sorts bot conversations and rooms together, newest first", () => {
    const bots = [bot("eli", [task("bot-new", { updatedAt: 20 })])];
    const room = group([{ threadId: "room-main", title: "room", createdAt: 0, updatedAt: 30 }]);
    expect(finishedThreads(bots, [room]).map((row) => row.task.threadId)).toEqual(["room-main", "bot-new"]);
  });

  it("leaves out one-to-one bot channels", () => {
    const room = group([{ threadId: "room-main", title: "room", createdAt: 0, updatedAt: 9 }], { dm: true });
    expect(finishedThreads([], [room])).toEqual([]);
  });
});
