import { describe, expect, it } from "vitest";

import { aiLabel, newBotDifference, placedKey, type NewBotChoice } from "./places-together";

describe("the other place's bots beside this page's own", () => {
  it("keys a bot by its home and its id, so the same id in two places is two keys", () => {
    expect(placedKey("cloud", "scout")).toBe("cloud:scout");
    expect(placedKey("cloud", "scout")).not.toBe(placedKey("computer", "scout"));
  });

});

describe("what differs about making a bot in the other place", () => {
  const there = (ais: string[] | null, state: NewBotChoice["state"] = "ready", home: NewBotChoice["home"] = "cloud") => ({ home, state, ais });

  it("says which AIs are signed in on one side only", () => {
    expect(newBotDifference(["Claude", "Codex"], there(["claude", "Included AI"]))).toEqual({ kind: "ais", onlyThere: ["Included AI"], onlyHere: ["Codex"] });
    expect(newBotDifference(["Claude"], there(["Claude", "Codex"]))).toEqual({ kind: "ais", onlyThere: ["Codex"], onlyHere: [] });
  });

  it("says nothing when both sides match, or the other place could not be asked", () => {
    expect(newBotDifference(["Claude"], there(["Claude"]))).toBeNull();
    expect(newBotDifference(["Claude"], there(null))).toBeNull();
    expect(newBotDifference(["Claude"], null)).toBeNull();
  });

  it("says a sleeping Cloud will be woken, and that a place has no AI yet", () => {
    expect(newBotDifference(["Claude"], there(null, "asleep"))).toEqual({ kind: "asleep" });
    expect(newBotDifference(["Claude"], there([]))).toEqual({ kind: "noAi" });
    expect(newBotDifference([], there(null, "offline", "computer"))).toBeNull();
  });

  it("never words an AI by a name that holds an email address: its engine's name stands in", () => {
    const engine = (kind: string) => `engine:${kind}`;
    expect(aiLabel("Claude", "claudeAgent", engine)).toBe("Claude");
    expect(aiLabel("alice@example.com", "codex", engine)).toBe("engine:codex");
    expect(aiLabel("Work (alice@example.com)", "codex", engine)).toBe("engine:codex");
  });
});
