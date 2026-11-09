import { afterEach, describe, expect, it, vi } from "vitest";
import { setTeamChats } from "./team-chats";
import { markedThread, openBotRow, openRoomThread } from "./thread-navigation";

type Task = { threadId: string; activity?: string; unread?: boolean; busy?: boolean; routineRunId?: string; archivedAt?: number; createdAt?: number; updatedAt?: number; openedBy?: { botId: string } };
const chief = (tasks: Task[], threadId = "main", mainThreadId = "main") => ({ id: "cos", threadId, mainThreadId, tasks: [{ threadId: "main", createdAt: 1 }, ...tasks] });
const opened = (bot: ReturnType<typeof chief>, threadsShown: boolean, onScreen = false) => {
  const dispatch = vi.fn();
  openBotRow(dispatch, bot, threadsShown, onScreen);
  return dispatch.mock.calls.map(([action]) => action);
};

afterEach(() => setTeamChats(null));

describe("what a bot's row or tile is marked for", () => {
  it("is what waits on the person first, then an unread reply, then work under way", () => {
    const working = { threadId: "work", busy: true }, unread = { threadId: "reply", unread: true }, waiting = { threadId: "ask", activity: "waiting-on-you" };
    expect(markedThread(chief([working]), false)).toBe("work");
    expect(markedThread(chief([working, unread]), false)).toBe("reply");
    expect(markedThread(chief([working, unread, waiting]), false)).toBe("ask");
  });

  it("is the newest of equals, unless the thread the bot opens to is one of them", () => {
    const older = { threadId: "older", unread: true, updatedAt: 5 }, newer = { threadId: "newer", unread: true, updatedAt: 9 };
    expect(markedThread(chief([older, newer]), false)).toBe("newer");
    expect(markedThread({ ...chief([older, newer]), tasks: [{ threadId: "main", unread: true, createdAt: 1 }, older, newer] }, false)).toBe("main");
  });

  it("is never a routine's run, nor an archived thread unless it waits on the person, as the row's own dot reads them", () => {
    expect(markedThread(chief([{ threadId: "run", busy: true, routineRunId: "r" }]), false)).toBeNull();
    expect(markedThread(chief([{ threadId: "put-away", unread: true, archivedAt: 1 }]), false)).toBeNull();
    expect(markedThread(chief([{ threadId: "put-away", activity: "waiting-on-you", archivedAt: 0 }]), false)).toBe("put-away");
  });

  it("is nothing on a quiet bot", () => {
    expect(markedThread(chief([{ threadId: "quiet" }]), false)).toBeNull();
    expect(markedThread({ id: "x", threadId: "t" } as unknown as ReturnType<typeof chief>, false)).toBeNull();
  });
});

describe("a click on a bot's row or tile", () => {
  const work = { threadId: "work", unread: true };

  it("lands on the thread the dot is about, by the switch alone so the thread left behind stays unread", () => {
    expect(opened(chief([work]), false)).toEqual([{ type: "switchTask", botId: "cos", threadId: "work" }]);
  });

  it("selects first while threads are shown, as every thread opener does there", () => {
    expect(opened(chief([work]), true)).toEqual([{ type: "select", id: "cos" }, { type: "switchTask", botId: "cos", threadId: "work" }]);
  });

  it("lands on a thread a teammate's work is running in, and a second click comes back to the main chat", () => {
    const running = { threadId: "work", busy: true };
    expect(opened(chief([running]), false)).toEqual([{ type: "switchTask", botId: "cos", threadId: "work" }]);
    expect(opened(chief([running], "work"), false, true)).toEqual([{ type: "switchTask", botId: "cos", threadId: "main" }]);
  });

  it("opens the bot as ever when nothing is marked, or when the main chat itself is what is marked", () => {
    expect(opened(chief([{ threadId: "quiet" }]), false)).toEqual([{ type: "select", id: "cos" }]);
    expect(opened({ ...chief([work]), tasks: [{ threadId: "main", unread: true, createdAt: 1 }, { threadId: "work" }] }, false)).toEqual([{ type: "select", id: "cos" }]);
  });

  it("opens a finished hand-off instead of the older chat, and a second click still returns to that chat", () => {
    const handed = { threadId: "work", updatedAt: 20, openedBy: { botId: "lead" } };
    const bot = chief([handed], "main");
    bot.tasks = [{ threadId: "main", createdAt: 1, updatedAt: 2 }, handed];
    expect(opened(bot, false)).toEqual([{ type: "switchTask", botId: "cos", threadId: "work" }]);
    expect(opened({ ...bot, threadId: "work" }, false, true)).toEqual([{ type: "switchTask", botId: "cos", threadId: "main" }]);
  });

  it("opens the newest of two finished hand-offs, and a second click on that one returns to the main chat", () => {
    const older = { threadId: "older", updatedAt: 10, openedBy: { botId: "lead" } };
    const newest = { threadId: "newest", updatedAt: 20, openedBy: { botId: "qa" } };
    const bot = chief([older, newest], "main");
    bot.tasks = [{ threadId: "main", createdAt: 1, updatedAt: 2 }, older, newest];
    expect(opened(bot, false)).toEqual([{ type: "switchTask", botId: "cos", threadId: "newest" }]);
    expect(opened({ ...bot, threadId: "newest" }, false, true)).toEqual([{ type: "switchTask", botId: "cos", threadId: "main" }]);
    expect(opened({ ...bot, threadId: "newest" }, false, false)).toEqual([
      { type: "select", id: "cos" },
      { type: "switchTask", botId: "cos", threadId: "newest" },
    ]);
  });

  it("does not treat a thread the bot opened on itself as a teammate hand-off", () => {
    const own = { threadId: "own", updatedAt: 20, openedBy: { botId: "cos" } };
    const bot = chief([own], "main");
    bot.tasks = [{ threadId: "main", createdAt: 1, updatedAt: 2 }, own];
    expect(opened(bot, false)).toEqual([{ type: "select", id: "cos" }]);
  });

  it("does not prefer a hand-off the person is already on, or one older than the open chat", () => {
    const handed = { threadId: "work", updatedAt: 2, openedBy: { botId: "lead" } };
    const current = chief([handed], "work");
    current.tasks = [{ threadId: "main", createdAt: 1, updatedAt: 30 }, handed];
    expect(opened(current, false, true)).toEqual([{ type: "switchTask", botId: "cos", threadId: "main" }]);
    const older = chief([{ threadId: "work", updatedAt: 1, openedBy: { botId: "lead" } }], "main");
    older.tasks = [{ threadId: "main", createdAt: 1, updatedAt: 30 }, older.tasks![1]!];
    expect(opened(older, false)).toEqual([{ type: "select", id: "cos" }]);
  });

  it("leaves a team's Cloud alone: there a bot's row is the person's own conversation", () => {
    setTeamChats({ teamId: "acme", member: true });
    const bot = { ...chief([work]), tasks: [{ threadId: "mine", private: true, createdAt: 3 }, work] };
    expect(opened(bot as ReturnType<typeof chief>, false)).toEqual([{ type: "switchTask", botId: "cos", threadId: "mine" }]);
  });
});

describe("a hand-off's chip for work in a room", () => {
  const room = { id: "room", threadId: "room-now", tasks: [{ threadId: "room-now" }, { threadId: "room-older" }] };
  const clicked = (comm: { groupId: string; threadId?: string }) => {
    const dispatch = vi.fn();
    openRoomThread(dispatch, comm, [room]);
    return dispatch.mock.calls.map(([action]) => action);
  };

  it("lands on the thread it names, not whichever the room is on", () => {
    expect(clicked({ groupId: "room", threadId: "room-older" })).toEqual([{ type: "select", id: "room" }, { type: "switchGroupTask", groupId: "room", threadId: "room-older" }]);
  });

  it("opens the room when it names no thread, or one the room no longer has", () => {
    expect(clicked({ groupId: "room" })).toEqual([{ type: "select", id: "room" }]);
    expect(clicked({ groupId: "room", threadId: "deleted" })).toEqual([{ type: "select", id: "room" }]);
  });
});
