import { beforeEach, describe, expect, it } from "vitest";
import { createEventSounds, GROUP_WINDOW_MS, NOTIFICATION_SOUNDS, type NotificationSoundEntry } from "./events";
import type { SoundEvent } from "./render";

let clock = 0;
let finished = true;
let played: SoundEvent[] = [];

const sounds = () => createEventSounds({ play: (event) => (played.push(event), true), now: () => clock, finishedNotices: () => finished });
const entry = (over: Partial<NotificationSoundEntry> = {}): NotificationSoundEntry => ({ kind: "approval", threadId: "t1", id: `n${Math.random()}`, ...over });

beforeEach(() => {
  clock = 10_000;
  finished = true;
  played = [];
});

describe("notification sounds", () => {
  it("maps what needs the person, finished work, failures and mentions to their sounds", () => {
    expect(NOTIFICATION_SOUNDS.approval).toBe("attention");
    expect(NOTIFICATION_SOUNDS.secret).toBe("attention");
    expect(NOTIFICATION_SOUNDS.spend).toBe("attention");
    expect(NOTIFICATION_SOUNDS.done).toBe("done");
    expect(NOTIFICATION_SOUNDS["turn-failed"]).toBe("error");
    expect(NOTIFICATION_SOUNDS.mention).toBe("mention");
    expect(NOTIFICATION_SOUNDS.notice).toBeNull();
  });

  it("sounds once for a new notice and never for one already read or heard", () => {
    const notices = sounds();
    const first = entry({ id: "a" });
    expect(notices.notified(first, false)).toBe(true);
    clock += GROUP_WINDOW_MS;
    expect(notices.notified(first, false)).toBe(false);
    expect(notices.notified(entry({ id: "b", read: true }), false)).toBe(false);
    expect(played).toEqual(["attention"]);
  });

  it("sounds once for a burst from one thread or room", () => {
    const notices = sounds();
    expect(notices.notified(entry({ groupId: "room" }), false)).toBe(true);
    expect(notices.notified(entry({ groupId: "room", threadId: "t2" }), false)).toBe(false);
    expect(notices.notified(entry({ threadId: "t3" }), false)).toBe(true);
    clock += GROUP_WINDOW_MS;
    expect(notices.notified(entry({ groupId: "room" }), false)).toBe(true);
  });

  it("keeps finished work quiet when the person turned those notices off or is reading its reply", () => {
    const notices = sounds();
    expect(notices.notified(entry({ kind: "done" }), true)).toBe(false);
    finished = false;
    expect(notices.notified(entry({ kind: "done", threadId: "t9" }), false)).toBe(false);
    expect(notices.notified(entry({ kind: "approval" }), true)).toBe(true);
    expect(played).toEqual(["attention"]);
  });

  it("plays a reply once per message, only in the thread on screen", () => {
    const notices = sounds();
    expect(notices.replied("m1", false)).toBe(false);
    expect(notices.replied("m1", true)).toBe(true);
    expect(notices.replied("m1", true)).toBe(false);
    expect(played).toEqual(["reply"]);
  });
});
