import { describe, expect, it } from "vitest";
import { PICKABLE_STATES, stateForBot } from "./mascot";

import { POOLS, EXPRESSIONS } from "../components/CursorAvatar";

it("offers a distinct resting face for every expression choice", () => {
  const faces = PICKABLE_STATES.map(state => JSON.stringify(EXPRESSIONS[POOLS[state][0]]));
  expect(new Set(faces).size).toBe(PICKABLE_STATES.length);
});

describe("a bot's expression communicates activity before its resting personality", () => {
  const bot = { name: "Orbit", mascotExpression: "sleeping" };

  it("wakes a sleepy character while it works, then restores its chosen face", () => {
    expect(stateForBot({ ...bot, busy: true })).toBe("thinking");
    expect(stateForBot({ ...bot, busy: false })).toBe("sleeping");
  });

  it("makes errors, unread results and questions visible on a customized character", () => {
    expect(stateForBot({ ...bot, messages: [{ kind: "activity", tool: { ok: false } }] })).toBe("alerting");
    expect(stateForBot({ ...bot, unread: true })).toBe("notifying");
    expect(stateForBot({ ...bot, messages: [{ kind: "options" }] })).toBe("curious");
  });

  it("shows a new attempt working even when the previous tool failed", () => {
    expect(stateForBot({ ...bot, busy: true, messages: [{ kind: "activity", tool: { ok: false } }] })).toBe("thinking");
  });

  it("shows attention and lost contact before a runtime's busy flag", () => {
    expect(stateForBot({ ...bot, busy: true, activity: "waiting-on-you" })).toBe("curious");
    expect(stateForBot({ ...bot, busy: true, activity: "no-signal" })).toBe("confused");
    expect(stateForBot({ ...bot, busy: false, activity: "dead" })).toBe("sad");
  });

  it("follows pending tools and returns to thinking between steps without celebrating", () => {
    const running = { ...bot, busy: true, unread: true };
    expect(stateForBot(running)).toBe("thinking");
    expect(stateForBot({ ...running, messages: [{ kind: "activity", tool: {} }] })).toBe("working");
    expect(stateForBot({ ...running, messages: [{ kind: "activity", tool: { ok: true } }] })).toBe("thinking");
    expect(stateForBot({ ...running, messages: [{ kind: "activity", tool: { ok: false } }] })).toBe("thinking");
    expect(stateForBot({ ...running, busy: false })).toBe("notifying");
    expect(stateForBot({ ...running, busy: false, unread: false })).toBe("sleeping");
  });
});
