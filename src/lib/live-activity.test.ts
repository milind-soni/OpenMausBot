import { describe, expect, it } from "vitest";

import { activityStepLabel, formatProgressSize, liveActivityLabel, liveActivityPhrases, phraseAt, phraseHoldMs, turnNowPhrases } from "./live-activity";
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
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Using the screen");
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

describe("activityStepLabel", () => {
  it("names a step the way the working line does: the server's narration first", () => {
    expect(activityStepLabel({ name: "Edit", spoken: "editing a file" })).toBe("Editing a file");
    expect(activityStepLabel({ name: "mcp__computer__click" })).toBe("Using the screen");
  });

  it("never shows a step's arguments", () => {
    expect(activityStepLabel({ name: "Bash: rm -rf ~/private" })).toBe("Running a command");
    expect(activityStepLabel({ name: "make_invoice" })).toBe("Working");
  });

  it("names a step by its tool alone, whatever its arguments say", () => {
    expect(activityStepLabel({ name: "make_invoice: read the file" })).toBe("Working");
  });

  // "Edit" and "editing a file" read the same, so only these cases tell narration from a name-derived label.
  it("prefers the narration to the label the tool's name would give", () => {
    expect(activityStepLabel({ name: "Bash", spoken: "checking the build." })).toBe("Checking the build");
  });

  it("falls back to the tool's name when the narration is blank", () => {
    expect(activityStepLabel({ name: "Bash", spoken: "   " })).toBe("Running a command");
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

describe("turnNowPhrases: what the status line says is happening now", () => {
  it("names the file being written and how much, from the engine's own report", () => {
    expect(turnNowPhrases({ activity: "write", itemId: "w", file: "index.html", bytes: 14 * 1024 + 9 })).toMatchObject({ phrases: ["Writing index.html"], size: "14 KB" });
    expect(turnNowPhrases({ activity: "edit", file: "app.ts", bytes: 3 * 1024 * 1024 + 300_000 })).toMatchObject({ phrases: ["Editing app.ts"], size: "3.2 MB" });
    expect(turnNowPhrases({ activity: "write", bytes: 200 })).toEqual({ phase: "live::Writing a file", phrases: ["Writing a file"] });
  });

  it("says commands, searches, reading, thinking and replying in plain words", () => {
    expect(turnNowPhrases({ activity: "command" })?.phrases[0]).toBe("Running a command");
    expect(turnNowPhrases({ activity: "web" })?.phrases[0]).toBe("Searching the web");
    expect(turnNowPhrases({ activity: "read", file: "notes.md" })?.phrases[0]).toBe("Reading notes.md");
    expect(turnNowPhrases({ activity: "thinking" })?.phrases[0]).toBe("Thinking");
    expect(turnNowPhrases({ activity: "reply" })?.phrases[0]).toBe("Writing a reply");
    expect(turnNowPhrases({ activity: "tool", tool: "mcp__agents__publish_page" })?.phrases[0]).toBe("Publishing a page");
  });

  it("falls back to the running chip, then to nothing, so the line is its timer alone", () => {
    expect(turnNowPhrases(null, activity("Bash: pnpm test"))?.phrases[0]).toBe("Running a command");
    expect(turnNowPhrases(null, activity("Bash", { ok: true }))).toBeNull();
    expect(turnNowPhrases(null, activity("make_invoice"))).toBeNull();
    expect(turnNowPhrases({ activity: "tool", tool: "make_invoice" })).toBeNull();
    expect(turnNowPhrases(null)).toBeNull();
  });

  it("names the command, the search and the page the server read from the call, with the whole command for the hover", () => {
    const command = turnNowPhrases({ activity: "command", itemId: "c", target: "scrape.py", detail: "cd ~/biber && python3 scrape.py --pages 40" });
    expect(command).toEqual({ phase: "step:command:scrape.py", phrases: ["Running scrape.py"], hover: "cd ~/biber && python3 scrape.py --pages 40" });
    expect(turnNowPhrases({ activity: "web", target: "Biber Dammbau" })?.phrases).toEqual(["Searching the web for “Biber Dammbau”"]);
    expect(turnNowPhrases({ activity: "fetch", target: "linkedin.com" })?.phrases).toEqual(["Reading linkedin.com"]);
  });

  it("names a running chip by the step stored with it, before the server's English narration", () => {
    const chip = activity("Bash", { spoken: "running a command", step: { activity: "command", target: "pnpm test", detail: "cd web && pnpm test" } });
    expect(turnNowPhrases(null, chip)).toMatchObject({ phrases: ["Running pnpm test"], hover: "cd web && pnpm test" });
    expect(activityStepLabel({ name: "Write", step: { activity: "write", target: "report.md" } })).toBe("Writing report.md");
    expect(turnNowPhrases(null, activity("Bash", { ok: true, step: { activity: "command", target: "pnpm test" } }))).toBeNull();
  });

  it("shows no size under a kilobyte", () => {
    expect(formatProgressSize(1023)).toBeUndefined();
    expect(formatProgressSize(1024)).toBe("1 KB");
    expect(formatProgressSize(undefined)).toBeUndefined();
  });
});
