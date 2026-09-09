// What is worth interrupting someone for. The policy is small, so the
// tests are mostly about the cases where the answer is "stay quiet".
import { describe, expect, it } from "vitest";

import { blockedTarget, buildNotification, summarize } from "./notify.ts";

const bot = { id: "bot-1", name: "Scout", threadId: "thread-1" };

describe("buildNotification", () => {
  it("names the bot and carries the detail, per kind", () => {
    expect(buildNotification("approval", bot, "thread-1", "rm -rf ./build")).toMatchObject({
      kind: "approval",
      botId: "bot-1",
      threadId: "thread-1",
      title: "Scout needs approval",
      body: "rm -rf ./build",
    });
    expect(buildNotification("question", bot, "thread-1", "which branch?")?.title).toBe("Scout has a question");
    expect(buildNotification("done", bot, "thread-1", "pushed the branch")?.title).toBe("Scout finished");
    expect(buildNotification("routine-failed", bot, "thread-1", "boom")?.title).toBe("Scout's routine failed");
    expect(buildNotification("turn-failed", bot, "thread-1", "the Local VM is not ready")?.title)
      .toBe("Scout couldn't start");
  });

  it("stays silent for a bot whose notifications are off", () => {
    const quiet = { ...bot, notifications: false };
    for (const kind of ["approval", "question", "done", "routine-failed", "turn-failed"] as const) {
      expect(buildNotification(kind, quiet, "thread-1", "anything")).toBeNull();
    }
    // absent means "not turned off" — older bot records predate the flag
    expect(buildNotification("approval", { ...bot, notifications: undefined }, "thread-1", "x")).not.toBeNull();
    expect(buildNotification("approval", { ...bot, notifications: true }, "thread-1", "x")).not.toBeNull();
  });

  it("does not buzz for a finish with nothing to say", () => {
    expect(buildNotification("done", bot, "thread-1", "   ")).toBeNull();
    expect(buildNotification("done", bot, "thread-1", "")).toBeNull();
    // ...but a blocked bot is worth knowing about even with a thin summary
    expect(buildNotification("approval", bot, "thread-1", "")).not.toBeNull();
    expect(buildNotification("turn-failed", bot, "thread-1", "")).not.toBeNull();
  });

  it("uses the thread it was raised on, not the bot's current one", () => {
    // a routine runs a bot in a detached task; the notification has to open
    // that conversation, not whatever the bot happens to be showing
    expect(buildNotification("done", bot, "other-thread", "done")?.threadId).toBe("other-thread");
  });

  it("carries the bot's avatar when one is given", () => {
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp";
    const frame = buildNotification("done", bot, "thread-1", "pushed the branch", { avatarUrl });
    expect(frame).toMatchObject({ botId: "bot-1", body: "pushed the branch", avatarUrl });

    // no profile image → the frame stays exactly as before
    expect(buildNotification("done", bot, "thread-1", "pushed")?.avatarUrl).toBeUndefined();
  });
});

describe("blockedTarget", () => {
  const room = { id: "room-1", name: "Launch", threadId: "room-thread", busyBotId: "bot-1" };

  it("opens the room a bot is speaking in, not the bot's own thread", () => {
    // the turn, the screen and the card are all in the room; the 1:1 thread
    // the notification used to open has nothing on it
    expect(blockedTarget(bot, room)).toEqual({
      threadId: "room-thread",
      group: { id: "room-1", name: "Launch" },
    });
  });

  it("stays on the bot's own thread for a room it is not holding", () => {
    expect(blockedTarget(bot, { ...room, busyBotId: "someone-else" })).toEqual({ threadId: "thread-1" });
    expect(blockedTarget(bot, { ...room, busyBotId: null })).toEqual({ threadId: "thread-1" });
    expect(blockedTarget(bot, null)).toEqual({ threadId: "thread-1" });
    expect(blockedTarget(bot)).toEqual({ threadId: "thread-1" });
  });

  it("names the room in the title and carries its id for grouping", () => {
    const target = blockedTarget(bot, room);
    expect(buildNotification("takeover", bot, target.threadId, "the login page wants a code", {
      group: target.group,
    })).toMatchObject({
      kind: "takeover",
      threadId: "room-thread",
      groupId: "room-1",
      title: "Scout in Launch needs your hands",
    });
    // a 1:1 takeover is untouched — no room to name, nothing to group under
    const direct = buildNotification("takeover", bot, bot.threadId, "the login page wants a code");
    expect(direct?.title).toBe("Scout needs your hands");
    expect(direct?.groupId).toBeUndefined();
  });
});

describe("summarize", () => {
  it("flattens a model's answer into one lock-screen line", () => {
    expect(summarize("line one\n\nline two")).toBe("line one line two");
    expect(summarize("before\n```js\nconst x = 1;\n```\nafter")).toBe("before after");
    expect(summarize("   padded   ")).toBe("padded");
  });

  it("clamps long text with an ellipsis", () => {
    const long = summarize("x".repeat(400));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
    expect(summarize("short")).toBe("short");
  });
});
