import { describe, expect, it } from "vitest";
import { notificationThreadName } from "./NotificationsPanel";

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
