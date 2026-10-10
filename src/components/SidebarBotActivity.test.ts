import { BellDot, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { botShowsUnread } from "@/lib/bot-unread";
import { t } from "@/lib/i18n";
import { attentionHasRunningWork, attentionJumpAction, attentionOwnerName, attentionRowStatus, attentionTriggerLabel, attentionUnpinAction, crossBotAttentionThreads, crossBotPinnedThreads, sidebarGroupActivityTasks } from "./SidebarBotActivity";

const task = (threadId: string, title: string, extra: Partial<Task>): Task =>
  ({ threadId, title, createdAt: 0, ...extra }) as Task;
const bot = (id: string, name: string, threadId: string, tasks?: Task[], extra: Partial<Bot> = {}): Bot =>
  ({ id, name, threadId, tasks, ...extra }) as unknown as Bot;
const group = (id: string, name: string, threadId: string, extra: Partial<Group> = {}): Group =>
  ({ id, name, threadId, memberIds: [], bulletin: "", unread: false, createdAt: 0, messages: [], ...extra }) as unknown as Group;

describe("botShowsUnread", () => {
  it("keeps the bot flag when there is no task list", () => {
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined, { unread: true }))).toBe(true);
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined))).toBe(false);
    expect(botShowsUnread(bot("s", "Solo", "s0", [], { unread: true }))).toBe(true);
  });

  it("ignores a hidden routine execution and counts a visible unread thread", () => {
    const hiddenOnly = bot("r", "Runner", "r0", [
      task("r0", "Read chat", {}),
      task("r1", "Failed run", { routineRunId: "run-1", unread: true }),
    ], { unread: true });
    expect(botShowsUnread(hiddenOnly)).toBe(false);
    const visible = bot("p", "Plain", "p0", [
      task("p0", "Unread chat", { unread: true }),
      task("p1", "Failed run", { routineRunId: "run-1", unread: true }),
    ]);
    expect(botShowsUnread(visible)).toBe(true);
  });
});

describe("header activity", () => {
  const entry = (task: Partial<Task> & { queued?: boolean }) => ({ kind: "bot" as const, botId: "a", botName: "Alpha", task: { threadId: "t", title: "T", createdAt: 0, queued: false, ...task } });

  it("names the pulse with the count only when there is something to count", () => {
    expect(attentionTriggerLabel(0)).toBe("Active Threads");
    expect(attentionTriggerLabel(2)).toBe(t("attention.titleCount", { count: 2 }));
  });

  it("marks running or queued work and leaves unread alone", () => {
    expect(attentionHasRunningWork([entry({ unread: true })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you" })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you", busy: true })])).toBe(false);
    expect(attentionHasRunningWork([entry({ activity: "waiting-on-you", busy: true, queued: true })])).toBe(true);
    expect(attentionHasRunningWork([entry({ activity: "working" })])).toBe(true);
    expect(attentionHasRunningWork([entry({ busy: true })])).toBe(true);
    expect(attentionHasRunningWork([entry({ queued: true })])).toBe(true);
  });
});

describe("cross-bot attention", () => {
  it("collects only attention threads from every other bot, waiting first across bots", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Waiting approval", { activity: "waiting-on-you" }),
      task("a2", "Unread reply", { unread: true }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Building site", { busy: true, activity: "working" }),
      task("b1", "Wrapped long ago", {}),
    ]);
    const entries = crossBotAttentionThreads([alpha, beta], { b2: [{}] }, "current");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["a1", "b0", "a2"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Alpha", "Beta", "Alpha"]);
  });

  it("excludes the bot the picker belongs to and keeps queued threads", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Waiting approval", { activity: "waiting-on-you" })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Queued job", {})]);
    const entries = crossBotAttentionThreads([alpha, beta], { b0: [{}] }, "a");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b0"]);
    expect(entries[0].task.queued).toBe(true);
  });

  it("falls back to the bot's own line when it has no task list yet", () => {
    const solo = bot("s", "Solo", "s0", undefined, { unread: true });
    expect(crossBotAttentionThreads([solo], {}).map((entry) => entry.task.threadId)).toEqual(["s0"]);
  });
  it("never offers a hidden bot or a routine run", () => {
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Waiting", { activity: "waiting-on-you" })], { hidden: true });
    const runner = bot("r", "Runner", "r0", [task("r0", "Routine step", { routineRunId: "run-1", busy: true })]);
    const plain = bot("p", "Plain", "p0", [task("p0", "Unread note", { unread: true })]);
    expect(crossBotAttentionThreads([hidden, runner, plain], {}).map((entry) => entry.task.threadId)).toEqual(["p0"]);
  });

  it("orders waiting ahead of unread across bots, not just inside one", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Waiting approval", { activity: "waiting-on-you" })]);
    expect(crossBotAttentionThreads([alpha, beta], {}).map((entry) => entry.task.threadId)).toEqual(["b0", "a0"]);
  });
});

describe("group attention", () => {
  it("surfaces a working or waiting room on its primary thread", () => {
    const busyBot = bot("b", "Beta", "b0", [], { activity: "waiting-on-you" });
    const room = group("g", "Crew", "g0", { working: true, busyBotId: "b" });
    const tasks = sidebarGroupActivityTasks(room, [busyBot], {});
    expect(tasks.map((task) => task.threadId)).toEqual(["g0"]);
    expect(tasks[0].activity).toBe("waiting-on-you");
  });

  it("ignores an idle room and never surfaces a bot-to-bot DM channel", () => {
    const idle = group("g", "Crew", "g0");
    const dm = group("d", "Bot DM", "d0", { working: true, dm: true });
    expect(sidebarGroupActivityTasks(idle, [], {})).toEqual([]);
    expect(sidebarGroupActivityTasks(dm, [], {})).toEqual([]);
  });

  it("attributes busy/unread only to the room's own primary task, not its other conversations", () => {
    const extra: GroupTask = { threadId: "g1", title: "Side thread", createdAt: 0 };
    const room = group("g", "Crew", "g0", { working: true, unread: true, tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, extra] });
    const tasks = sidebarGroupActivityTasks(room, [], {});
    expect(tasks.map((task) => task.threadId)).toEqual(["g0"]);
    expect(tasks[0].busy).toBe(true);
    expect(tasks[0].unread).toBe(true);
  });

  it("keeps a queued side conversation even while the room itself is idle", () => {
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, { threadId: "g1", title: "Side thread", createdAt: 0 }] });
    const tasks = sidebarGroupActivityTasks(room, [], { g1: [{}] });
    expect(tasks.map((task) => task.threadId)).toEqual(["g1"]);
    expect(tasks[0].queued).toBe(true);
  });

  it("merges bot and room entries into one ordered attention list", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const room = group("g", "Crew", "g0", { working: true, busyBotId: "b", tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }] });
    const busyBot = bot("b", "Beta", "b0", [], { activity: "waiting-on-you" });
    const entries = crossBotAttentionThreads([alpha, busyBot], {}, undefined, [room]);
    expect(entries.map((entry) => `${entry.kind}:${entry.task.threadId}`)).toEqual(["group:g0", "bot:a0"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Crew", "Alpha"]);
  });

  it("jumps a room's primary thread by selecting the room, and a side conversation via switchGroupTask", () => {
    const room = group("g", "Crew", "g0", { working: true, tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }] });
    const [primary] = crossBotAttentionThreads([], {}, undefined, [room]);
    expect(attentionJumpAction(primary)).toEqual({ type: "select", id: "g" });

    const sideRoom = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, { threadId: "g1", title: "Side thread", createdAt: 0 }] });
    const [side] = crossBotAttentionThreads([], { g1: [{}] }, undefined, [sideRoom]);
    expect(attentionJumpAction(side)).toEqual({ type: "switchGroupTask", groupId: "g", threadId: "g1" });
  });

  it("jumps a bot entry with switchTask", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const [entry] = crossBotAttentionThreads([alpha], {});
    expect(attentionJumpAction(entry)).toEqual({ type: "switchTask", botId: "a", threadId: "a0" });
  });
});

describe("cross-bot pinned threads", () => {
  it("collects only pinned threads from every bot, newest pin first", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Old pin", { pinned: true, updatedAt: 1 }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Unpinned", {}),
      task("b1", "New pin", { pinned: true, updatedAt: 2 }),
    ]);
    const entries = crossBotPinnedThreads([alpha, beta], [], {});
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b1", "a1"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Beta", "Alpha"]);
  });

  it("ignores a pinned routine run and a hidden bot", () => {
    const visible = bot("v", "Visible", "v0", [task("v0", "Pinned run", { pinned: true, routineRunId: "run-1" })]);
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Pinned elsewhere", { pinned: true })], { hidden: true });
    expect(crossBotPinnedThreads([visible, hidden], [], {})).toEqual([]);
  });

  it("includes a pinned room thread alongside pinned bot threads", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true, updatedAt: 1 })]);
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0, pinned: true, updatedAt: 2 }] });
    const entries = crossBotPinnedThreads([alpha], [room], {});
    expect(entries.map((entry) => `${entry.kind}:${entry.task.threadId}`)).toEqual(["group:g0", "bot:a0"]);
    expect(attentionJumpAction(entries[0])).toEqual({ type: "select", id: "g" });
  });

  it("marks a pinned thread queued the same way attention does", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })]);
    const [entry] = crossBotPinnedThreads([alpha], [], { a0: [{}] });
    expect(entry.task.queued).toBe(true);
  });

  it("keeps pinned task status independent of the bot's aggregate activity", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle pin", { pinned: true, busy: false, activity: "idle" }),
      task("a1", "Working pin", { pinned: true, busy: true, activity: "working" }),
    ], { busy: true, activity: "waiting-on-you" });
    const entries = crossBotPinnedThreads([alpha], [], {});
    expect(attentionRowStatus(entries[0].task).active).toBe(false);
    expect(attentionRowStatus(entries[1].task).label).toBe(t("chat.activity.working"));
  });

  it("derives a pinned room's live status without attributing it to an idle sibling", () => {
    const alpha = bot("a", "Alpha", "a0", [], { activity: "waiting-on-you" });
    const room = group("g", "Crew", "g0", { busyBotId: "a", unread: true, tasks: [
      { threadId: "g0", title: "Crew", createdAt: 0, pinned: true },
      { threadId: "g1", title: "Idle sibling", createdAt: 0, pinned: true },
    ] });
    const status = (patch: Partial<Group>) => crossBotPinnedThreads([alpha], [{ ...room, ...patch }], {})
      .map((entry) => attentionRowStatus(entry.task));
    expect(status({})[0].label).toBe(t("task.waiting"));
    expect(status({ busyBotId: null, working: true })[0].label).toBe(t("chat.activity.working"));
    expect(status({ busyBotId: null })[0].label).toBe(t("task.unread"));
    expect(status({})[1].active).toBe(false);
  });
});

describe("attentionRowStatus", () => {
  it("flags a waiting-on-you task active with the CircleAlert icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, activity: "waiting-on-you" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.waiting"));
    expect(status.Icon).toBe(CircleAlert);
  });

  it("flags a working task active with the spinning Loader2 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, busy: true, activity: "working" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("chat.activity.working"));
    expect(status.Icon).toBe(Loader2);
  });

  it("flags a queued task active with the Clock3 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.queued"));
    expect(status.Icon).toBe(Clock3);
  });

  it("flags an unread task active with the BellDot icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, unread: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.unread"));
    expect(status.Icon).toBe(BellDot);
  });

  it("marks a plain idle task inactive", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false });
    expect(status.active).toBe(false);
  });
});

describe("attentionUnpinAction", () => {
  it("unpins a bot thread via updateTask", () => {
    const [entry] = crossBotPinnedThreads([bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })])], [], {});
    expect(attentionUnpinAction(entry)).toEqual({ type: "updateTask", botId: "a", threadId: "a0", patch: { pinned: false } });
  });

  it("unpins a room thread via pinGroupTask", () => {
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0, pinned: true }] });
    const [entry] = crossBotPinnedThreads([], [room], {});
    expect(attentionUnpinAction(entry)).toEqual({ type: "pinGroupTask", groupId: "g", threadId: "g0", pinned: false, title: "Crew" });
  });
});
