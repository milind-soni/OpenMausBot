import { describe, expect, it } from "vitest";
import { runLogText, timelineEvents } from "../src/lib/taskTimeline.ts";

describe("execution timeline", () => {
  it("derives only persisted, observable events and preserves failures", () => {
    const events = timelineEvents([
      { id: "start", role: "user", kind: "text", text: "Research this", at: 1 },
      { id: "tool", role: "bot", kind: "activity", tool: { name: "browser.search", ok: true }, at: 2 },
      { id: "screen", role: "bot", kind: "screen", png: "x", at: 3 },
      { id: "failure", role: "bot", kind: "activity", tool: { name: "error: blocked", ok: false }, at: 4 },
      { id: "response", role: "bot", kind: "text", text: "I could not complete it.", at: 5 },
    ]);
    expect(events).toMatchObject([
      { kind: "task", state: "observed" },
      { label: "browser.search", kind: "tool", state: "complete" },
      { kind: "screen", state: "observed" },
      { label: "blocked", kind: "tool", state: "failed" },
      { kind: "result", state: "complete" },
    ]);
  });

  it("shows a pending activity as running until its completion patch arrives", () => {
    const start = { id: "tool", role: "bot" as const, kind: "activity" as const, tool: { name: "browser.search" }, at: 2 };
    expect(timelineEvents([start])).toMatchObject([{ label: "browser.search", state: "running" }]);
    expect(timelineEvents([{ ...start, tool: { name: "browser.search", ok: true } }])).toMatchObject([
      { label: "browser.search", state: "complete" },
    ]);
  });

  it("does not call every later user reply a new task", () => {
    const events = timelineEvents([
      { id: "task", role: "user", kind: "text", text: "Research this", at: 1 },
      { id: "reply", role: "bot", kind: "text", text: "What should I compare?", at: 2 },
      { id: "answer", role: "user", kind: "text", text: "Price and privacy.", at: 3 },
    ]);
    expect(events.map((event) => event.label)).toEqual(["Task started", "Response recorded", "User input"]);
  });

  it("shows recorded commands and redacts older unsanitized activity", () => {
    const events = timelineEvents([
      { id: "u", role: "user", kind: "text", text: "Private user instructions", at: 1 },
      { id: "tool", role: "bot", kind: "activity", tool: { name: "Bash --password private-value", summary: "pnpm control:omb doctor --token fixture-secret", ok: false }, at: 2 },
      { id: "answer", role: "bot", kind: "text", text: "Private bot reply", at: 3 },
    ]);
    expect(events[1]).toMatchObject({ state: "failed", command: "pnpm control:omb doctor --token «redacted 14 chars»" });
    const text = runLogText(events);
    expect(text).toContain("failed · Bash");
    expect(text).toContain("1970-01-01T00:00:00.002Z");
    expect(text).not.toContain("private-value");
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("Private user");
    expect(text).not.toContain("Private bot");
  });

  it("does not invent commands or results for an unfinished tool", () => {
    const events = timelineEvents([{ id: "t", role: "bot", kind: "activity", tool: { name: "Read" }, at: 0 }]);
    expect(events[0]).toMatchObject({ label: "Read", state: "running" });
    expect(events[0].command).toBeUndefined();
    expect(runLogText([])).toBe("");
  });
});
