import { describe, expect, it } from "vitest";

import { liveActivityLabel, liveActivityPhrases, phraseAt, phraseHoldMs } from "./live-activity";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: "activity",
  at: 1,
  role: "bot",
  kind: "activity",
  tool: { ...extra, name },
});

describe("liveActivityLabel", () => {
  it("shows thinking before a tool starts and after it settles", () => {
    expect(liveActivityLabel()).toBe("Thinking");
    expect(liveActivityLabel(activity("Read", { ok: true }))).toBe("Thinking");
  });

  it("uses the server's narration for the exact live action", () => {
    expect(liveActivityLabel(activity("Edit", { spoken: "editing a file" }))).toBe(
      "Editing a file",
    );
  });

  it("maps common native and MCP tool names when narration is unavailable", () => {
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("Running a command");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Using the computer");
    expect(liveActivityLabel(activity("web_search"))).toBe("Searching the web");
    expect(liveActivityLabel(activity("delegate_bot"))).toBe("Handing off a task");
    expect(liveActivityLabel(activity("ask_bot"))).toBe("Asking a teammate");
    expect(liveActivityLabel(activity("list_rooms"))).toBe("Checking the groups");
    expect(liveActivityLabel(activity("post_to_room"))).toBe("Posting in a group");
  });

  it("does not present bot-to-bot communication chips as the active action", () => {
    expect(
      liveActivityLabel({
        ...activity("ask_bot"),
        comm: { groupId: "room", withBotId: "bot", withName: "Peer", withColor: "blue" },
      }),
    ).toBe("Thinking");
  });
});

describe("liveActivityPhrases", () => {
  it("leads every phase with the plain label the sidebar shows", () => {
    for (const message of [undefined, activity("Bash: ls"), activity("web_search"), activity("something_unknown")]) {
      expect(liveActivityPhrases(message).phrases[0]).toBe(liveActivityLabel(message));
    }
  });

  it("varies plain reasoning with short, friendly phrases", () => {
    const { phase, phrases } = liveActivityPhrases();
    expect(phase).toBe("chat.activity.thinking");
    expect(phrases).toEqual(expect.arrayContaining(["Thinking", "Mulling it over", "Chipping away", "Making progress"]));
    for (const phrase of phrases) expect(phrase.split(" ").length).toBeLessThanOrEqual(3);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it("keeps activity phrases about the activity", () => {
    expect(liveActivityPhrases(activity("web_search")).phrases).toEqual(["Searching the web", "Looking it up", "Going through results"]);
    expect(liveActivityPhrases(activity("Read")).phrases).toEqual(["Reading a file", "Reading through", "Looking it over"]);
  });

  it("never rotates the server's exact narration", () => {
    const narrated = liveActivityPhrases(activity("Bash", { spoken: "running the test suite" }));
    expect(narrated.phrases).toEqual(["Running the test suite"]);
    expect(narrated.phase).toBe("spoken:running the test suite");
  });
});

describe("phraseAt", () => {
  const phrases = ["Thinking", "Mulling it over", "Piecing it together", "Digging in"];

  it("opens on the plain label and is reproducible for one seed", () => {
    expect(phraseAt(phrases, "turn-1", 0)).toBe("Thinking");
    const walk = (seed: string) => Array.from({ length: 8 }, (_, step) => phraseAt(phrases, seed, step));
    expect(walk("turn-1")).toEqual(walk("turn-1"));
  });

  it("visits every phrase and never repeats one back to back", () => {
    const walk = Array.from({ length: 12 }, (_, step) => phraseAt(phrases, "turn-1", step));
    expect(new Set(walk.slice(0, 4))).toEqual(new Set(phrases));
    for (let i = 1; i < walk.length; i++) expect(walk[i]).not.toBe(walk[i - 1]);
  });

  it("orders the alternates differently across turns", () => {
    const order = (seed: string) => [1, 2, 3].map((step) => phraseAt(phrases, seed, step)).join("|");
    const orders = new Set(["a", "b", "c", "d", "e", "f"].map(order));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("holds a single phrase and holds each step 4 to 6 seconds", () => {
    expect(phraseAt(["Working"], "turn-1", 5)).toBe("Working");
    for (let step = 0; step < 50; step++) {
      const hold = phraseHoldMs("turn-1", step);
      expect(hold).toBeGreaterThanOrEqual(4000);
      expect(hold).toBeLessThanOrEqual(6000);
    }
  });
});
