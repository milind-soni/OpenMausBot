import { afterEach, describe, expect, it } from "vitest";

import { buildNotification, buildSpendNotification, summarize } from "./notify.ts";
import { conversationLanguage, setConversationLanguage } from "./server-lines.ts";
import "./server-line-packs.ts";

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
    expect(buildNotification("routine-deferred", bot, "thread-1", "target busy for 30 minutes")?.title)
      .toBe("Scout's routine is waiting");
    expect(buildNotification("incident", bot, "thread-1", "the run stopped: exit_before_result")?.title).toBe("Scout hit a problem");
    expect(buildNotification("turn-failed", bot, "thread-1", "the Local VM is not ready")?.title)
      .toBe("Scout couldn't start");
  });

  it("announces a delegation settle as a resume with results", () => {
    expect(buildNotification("delegation-settled", bot, "thread-1", "Results in from Atlas")).toMatchObject({
      kind: "delegation-settled",
      botId: "bot-1",
      threadId: "thread-1",
      title: "Scout resumed with results",
      body: "Results in from Atlas",
    });
    expect(buildNotification("delegation-settled", { ...bot, notifications: false }, "thread-1", "Results in from Atlas")).toBeNull();
  });

  it("says who mentioned the person, and where", () => {
    const group = { id: "group-1", name: "Launch" };
    expect(buildNotification("mention", bot, "room-thread", "@you three open questions\nare blocking Section 2", { group })).toEqual({
      kind: "mention",
      botId: "bot-1",
      botName: "Scout",
      threadId: "room-thread",
      groupId: "group-1",
      title: "Scout in Launch mentioned you",
      body: "@you three open questions are blocking Section 2",
    });
    expect(buildNotification("mention", { ...bot, notifications: undefined }, "room-thread", "@you", { group })).not.toBeNull();
    expect(buildNotification("mention", { ...bot, notifications: false }, "room-thread", "@you", { group })).toBeNull();
    expect(buildNotification("mention", bot, "room-thread", "   ", { group })).toBeNull();
  });

  it("stays silent for a bot whose notifications are off", () => {
    const quiet = { ...bot, notifications: false };
    for (const kind of ["approval", "question", "done", "mention", "routine-failed", "turn-failed"] as const) {
      expect(buildNotification(kind, quiet, "thread-1", "anything")).toBeNull();
    }
    expect(buildNotification("approval", { ...bot, notifications: undefined }, "thread-1", "x")).not.toBeNull();
    expect(buildNotification("approval", { ...bot, notifications: true }, "thread-1", "x")).not.toBeNull();
  });

  it("does not buzz for a finish with nothing to say", () => {
    expect(buildNotification("done", bot, "thread-1", "   ")).toBeNull();
    expect(buildNotification("done", bot, "thread-1", "")).toBeNull();
    expect(buildNotification("approval", bot, "thread-1", "")).not.toBeNull();
    expect(buildNotification("turn-failed", bot, "thread-1", "")).not.toBeNull();
  });

  it("uses the thread it was raised on, not the bot's current one", () => {
    expect(buildNotification("done", bot, "other-thread", "done")?.threadId).toBe("other-thread");
  });

  it("carries the bot's avatar when one is given", () => {
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp";
    const frame = buildNotification("done", bot, "thread-1", "pushed the branch", { avatarUrl });
    expect(frame).toMatchObject({ botId: "bot-1", body: "pushed the branch", avatarUrl });

    expect(buildNotification("done", bot, "thread-1", "pushed")?.avatarUrl).toBeUndefined();
  });
  it("titles a finished wait and keeps its line as the body", () => {
    expect(buildNotification("wait", { id: "b", name: "Pepper" }, "t", "the build: done. ci passed.")).toEqual({
      kind: "wait", botId: "b", botName: "Pepper", threadId: "t", title: "Pepper's wait is over", body: "the build: done. ci passed.",
    });
  });
});

describe("sign-in requests", () => {
  it("names the room in the title and carries its id for grouping", () => {
    expect(buildNotification("sign-in", bot, "room-thread", "the dashboard is behind a login", {
      group: { id: "room-1", name: "Launch" }, site: "example.com",
    })).toMatchObject({
      kind: "sign-in",
      threadId: "room-thread",
      groupId: "room-1",
      title: "Scout in Launch needs you to sign in to example.com",
      body: "the dashboard is behind a login",
    });
    const direct = buildNotification("sign-in", bot, bot.threadId, "the dashboard is behind a login", { site: "example.com" });
    expect(direct?.title).toBe("Scout needs you to sign in to example.com");
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

describe("buildSpendNotification", () => {
  it("opens the thread whose turn crossed the line, and a bot's own toggle does not silence it", () => {
    const quiet = { ...bot, notifications: false };
    expect(buildSpendNotification(quiet, "thread-9", { title: "Monthly spend limit reached", body: "$100.00 of $100.00 spent this month (2026-09)." })).toEqual({
      kind: "spend", botId: "bot-1", botName: "Scout", threadId: "thread-9",
      title: "Monthly spend limit reached", body: "$100.00 of $100.00 spent this month (2026-09).",
    });
  });
});

describe("a notification's title", () => {
  afterEach(() => setConversationLanguage(() => undefined));

  it("is in the language of the conversation's person", () => {
    setConversationLanguage((threadId) => (threadId === "beaver-main" ? "de" : undefined));
    const bot = { id: "beaver", name: "Biber", threadId: "beaver-main" };
    expect(conversationLanguage("beaver-main")).toBe("de");
    expect(buildNotification("routine-failed", bot, "beaver-main", "Nightly report: signed out")?.title).toBe("Routine von Biber ist fehlgeschlagen");
    expect(buildNotification("question", bot, "beaver-main", "Send it?", { group: { id: "launch", name: "Launch" } })?.title).toBe("Biber in Launch hat eine Frage");
    expect(buildNotification("sign-in", bot, "beaver-main", "", { site: "github.com" })?.title).toBe("Biber braucht deine Anmeldung bei github.com");
    expect(buildNotification("sign-in", bot, "beaver-main", "")?.title).toBe("Biber braucht deine Anmeldung bei einer Website");
    expect(buildNotification("done", bot, "beaver-main", "Done.")?.title).toBe("Biber ist fertig");
    expect(buildNotification("routine-failed", bot, "other", "x")?.title).toBe("Biber's routine failed");
  });
});
