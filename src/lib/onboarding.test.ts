import { describe, expect, it } from "vitest";
import {
  beatWidth,
  beatsFor,
  completionPatch,
  EMPTY_ONBOARDING,
  hintSeen,
  hintSeenPatch,
  nextBeat,
  previousBeat,
  welcomeDue,
  WELCOME_VERSION,
} from "./onboarding";

const done = { completedAt: "2026-09-09T10:00:00.000Z", version: WELCOME_VERSION, reelSeen: false, hintsSeen: [] };

describe("welcomeDue", () => {
  it("waits for the server before deciding", () => {
    expect(welcomeDue(null, { remoteClient: false, legacyDone: false })).toBe(false);
    expect(welcomeDue(undefined, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("shows the tour to a fresh workspace", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: false })).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("never shows it to a paired remote client", () => {
    expect(welcomeDue({}, { remoteClient: true, legacyDone: false })).toBe(false);
  });

  it("respects a completion at the current version", () => {
    expect(welcomeDue({ onboarding: done }, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("re-shows a flow completed at an older version", () => {
    expect(welcomeDue({ onboarding: { ...done, version: WELCOME_VERSION - 1 } }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("honours the old localStorage gate for one release", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: true })).toBe(false);
    // but a server record, once present, wins over the browser
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { remoteClient: false, legacyDone: true })).toBe(true);
  });
});

describe("persistence patches", () => {
  it("stamps completion with the current version", () => {
    expect(completionPatch(new Date("2026-09-09T12:34:56.000Z"))).toEqual({
      onboarding: { completedAt: "2026-09-09T12:34:56.000Z", version: WELCOME_VERSION },
    });
  });

  it("adds a hint once and never writes a no-op", () => {
    expect(hintSeen(undefined, "computer")).toBe(false);
    expect(hintSeenPatch(undefined, "computer")).toEqual({ onboarding: { hintsSeen: ["computer"] } });
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["computer"] };
    expect(hintSeen(record, "computer")).toBe(true);
    expect(hintSeenPatch(record, "computer")).toBeNull();
    expect(hintSeenPatch(record, "apps")).toEqual({ onboarding: { hintsSeen: ["computer", "apps"] } });
  });
});

describe("beat machine", () => {
  it("lists beats for the desktop app with the reel off", () => {
    expect(beatsFor({ dictation: true, reel: false })).toEqual(["hello", "engines", "permissions", "phone", "bot"]);
  });

  it("drops the permissions beat where there is no microphone to ask for", () => {
    expect(beatsFor({ dictation: false, reel: false })).toEqual(["hello", "engines", "phone", "bot"]);
  });

  it("slots the reel after hello when enabled", () => {
    expect(beatsFor({ dictation: false, reel: true })).toEqual(["hello", "reel", "engines", "phone", "bot"]);
  });

  it("always ends on the bot beat", () => {
    for (const dictation of [true, false]) {
      for (const reel of [true, false]) {
        expect(beatsFor({ dictation, reel }).at(-1)).toBe("bot");
      }
    }
  });

  it("walks forward and back and stops at the ends", () => {
    const beats = beatsFor({ dictation: true, reel: false });
    expect(nextBeat(beats, "hello")).toBe("engines");
    expect(nextBeat(beats, "bot")).toBeNull();
    expect(previousBeat(beats, "engines")).toBe("hello");
    expect(previousBeat(beats, "hello")).toBeNull();
    expect(nextBeat(beats, "reel")).toBeNull();
  });

  it("gives the engines beat the widest card", () => {
    expect(beatWidth("engines")).toBeGreaterThan(beatWidth("hello"));
    expect(beatWidth("bot")).toBeGreaterThan(beatWidth("hello"));
  });
});
