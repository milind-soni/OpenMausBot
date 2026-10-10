import { describe, expect, it } from "vitest";
import { ALL_BOTS, filterNotifications, notificationBots, notificationBotForAvatar, notificationThreadName } from "./NotificationsPanel";

const state = {
  bots: [{ id: "b1", threadId: "t-main", tasks: [{ threadId: "t-main", title: "Notification Pane" }, { threadId: "t-2", title: "Hotpatches" }] }],
  groups: [{ threadId: "g-main", name: "Mantis-email & co.", tasks: [{ threadId: "g-task", title: "Skill rollout" }] }],
};

describe("notificationThreadName", () => {
  it("finds a bot task title", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "t-2" }, state)).toBe("Hotpatches");
  });
  it("finds a room task title, else the room name", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "g-task" }, state)).toBe("Skill rollout");
    expect(notificationThreadName({ botId: "b1", threadId: "g-main" }, state)).toBe("Mantis-email & co.");
  });
  it("returns null for an unknown thread", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "gone" }, state)).toBeNull();
  });
});

describe("bot filter", () => {
  const rows = [
    { botId: "b2", botName: "Dev" },
    { botId: "b1", botName: "Claw1" },
    { botId: "b2", botName: "Dev" },
  ];
  it("lists each bot once, sorted by name", () => {
    expect(notificationBots(rows)).toEqual([{ id: "b1", name: "Claw1" }, { id: "b2", name: "Dev" }]);
  });
  it("filters to one bot, or returns everything for all", () => {
    expect(filterNotifications(rows, "b2")).toHaveLength(2);
    expect(filterNotifications(rows, ALL_BOTS)).toHaveLength(3);
    expect(filterNotifications(rows, "none")).toHaveLength(0);
  });
});

describe("notificationBotForAvatar", () => {
  const bots = [{ id: "a" }, { id: "b" }];
  it("finds the bot that sent the notification", () => {
    expect(notificationBotForAvatar({ botId: "b" }, bots)).toBe(bots[1]);
  });
  it("returns null for workspace events or deleted bots", () => {
    expect(notificationBotForAvatar({ botId: "gone" }, bots)).toBeNull();
  });
});
