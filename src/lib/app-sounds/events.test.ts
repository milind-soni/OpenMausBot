import { beforeEach, describe, expect, it } from "vitest";
import { createEventSounds, GROUP_WINDOW_MS, NOTIFICATION_SOUNDS, type NotificationSoundEntry } from "./events";
import type { SoundEvent } from "./render";

let clock = 0;
let finished = true;
let played: SoundEvent[] = [];
let soundsOn = true;

let wanted: Array<(() => boolean) | undefined> = [];

const sounds = () => createEventSounds({ play: (event, still) => (played.push(event), wanted.push(still), "played"), now: () => clock, finishedNotices: () => finished, soundsOn: () => soundsOn });
const entry = (over: Partial<NotificationSoundEntry> = {}): NotificationSoundEntry => ({ kind: "approval", threadId: "t1", id: `n${Math.random()}`, ...over });

beforeEach(() => {
  clock = 10_000;
  finished = true;
  soundsOn = true;
  played = [];
  wanted = [];
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
    expect(notices.notified(first, false)).toBe("played");
    clock += GROUP_WINDOW_MS;
    expect(notices.notified(first, false)).toBe("silenced");
    expect(notices.notified(entry({ id: "b", read: true }), false)).toBe("silenced");
    expect(played).toEqual(["attention"]);
  });

  it("sounds once for a burst from one thread or room", () => {
    const notices = sounds();
    expect(notices.notified(entry({ groupId: "room" }), false)).toBe("played");
    expect(notices.notified(entry({ groupId: "room", threadId: "t2" }), false)).toBe("silenced");
    expect(notices.notified(entry({ threadId: "t3" }), false)).toBe("played");
    clock += GROUP_WINDOW_MS;
    expect(notices.notified(entry({ groupId: "room" }), false)).toBe("played");
  });

  it("keeps finished work quiet when the person turned those notices off or is reading its reply", () => {
    const notices = sounds();
    expect(notices.notified(entry({ kind: "done" }), true)).toBe("silenced");
    finished = false;
    expect(notices.notified(entry({ kind: "done", threadId: "t9" }), false)).toBe("silenced");
    expect(notices.notified(entry({ kind: "approval" }), true)).toBe("played");
    expect(played).toEqual(["attention"]);
  });

  it("leaves a notice the app has no sound for to the system chime, unless sounds are off", () => {
    const notices = sounds();
    expect(notices.notified(entry({ kind: "notice" }), false)).toBe("unplayable");
    soundsOn = false;
    expect(notices.notified(entry({ kind: "notice" }), false)).toBe("silenced");
    expect(played).toEqual([]);
  });

  it("plays a reply once per message, only in the thread on screen", () => {
    const notices = sounds();
    expect(notices.replied("m1", false)).toBe("silenced");
    expect(notices.replied("m1", true)).toBe("played");
    expect(notices.replied("m1", true)).toBe("silenced");
    expect(played).toEqual(["reply"]);
  });

  it("lets a sound still waiting to play know its notice was read meanwhile", () => {
    const notices = sounds();
    notices.notified(entry({ id: "a" }), false);
    notices.notified(entry({ id: "b", threadId: "t2" }), false);
    notices.notificationsRead(["a"]);
    expect(wanted.map((still) => still?.())).toEqual([false, true]);
  });
});
