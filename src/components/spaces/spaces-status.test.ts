import { describe, expect, it } from "vitest";

import { statusChip } from "./spaces-status";

const bot = (over: Record<string, unknown> = {}) =>
  ({ id: "b", name: "Gmail", unread: false, ...over }) as never;

describe("statusChip for a bot", () => {
  it("puts what needs you above what is merely busy", () => {
    expect(statusChip(bot({ activity: "waiting-on-you", unread: true })).label).toBe("Waiting on you");
    expect(statusChip(bot({ activity: "waiting-on-you" })).tone).toBe("attention");
  });

  it("shows work in progress", () => {
    const chip = statusChip(bot({ activity: "working", unread: true }));
    expect(chip.label).toBe("Working");
    expect(chip.tone).toBe("active");
  });

  it("surfaces a dead or unreachable bot over an unread badge", () => {
    expect(statusChip(bot({ activity: "dead", unread: true })).label).toBe("Stopped");
    expect(statusChip(bot({ activity: "dead" })).tone).toBe("danger");
    expect(statusChip(bot({ activity: "no-signal", unread: true })).label).toBe("No signal");
  });

  it("falls back to unread when nothing is happening", () => {
    expect(statusChip(bot({ activity: "idle", unread: true })).label).toBe("New messages");
    expect(statusChip(bot({ unread: true })).label).toBe("New messages");
  });

  it("says idle when there is genuinely nothing to report", () => {
    const chip = statusChip(bot({ activity: "idle" }));
    expect(chip.label).toBe("Idle");
    expect(chip.tone).toBe("muted");
  });

  it("treats busy without an activity as working", () => {
    expect(statusChip(bot({ busy: true })).label).toBe("Working");
  });
});

describe("statusChip for a room", () => {
  const group = (over: Record<string, unknown> = {}) =>
    ({ id: "g", name: "Design", memberIds: ["a", "b"], unread: false, ...over }) as never;

  it("reports the room working while any member holds the turn", () => {
    expect(statusChip(group({ working: true })).label).toBe("Working");
    expect(statusChip(group({ busyBotId: "a" })).label).toBe("Working");
  });

  it("falls back to unread, then idle", () => {
    expect(statusChip(group({ unread: true })).label).toBe("New messages");
    expect(statusChip(group()).label).toBe("Idle");
  });
});
