// Pure mapping functions of the multicaAgent driver: text → ticket fields,
// run status → canonical outcome, run message → canonical runtime event.
// These are the only parts worth unit-testing without a live factory.
import { describe, expect, it } from "vitest";

import {
  issueDescriptionFromText,
  issueIdFromCursor,
  issueTitleFromText,
  messageToEvents,
  runSettled,
} from "./multica.ts";

const base = {
  eventId: "ev-1",
  provider: "multicaAgent",
  threadId: "t1",
  turnId: "turn-1",
  createdAt: "2026-08-15T00:00:00Z",
};

describe("issueTitleFromText / issueDescriptionFromText", () => {
  it("takes the first line as title and the rest as the brief", () => {
    expect(issueTitleFromText("Landingpage X\nHero modernisieren\nCTA schärfen")).toBe("Landingpage X");
    expect(issueDescriptionFromText("Landingpage X\nHero modernisieren\nCTA schärfen")).toBe("Hero modernisieren\nCTA schärfen");
  });

  it("single-line text has no description", () => {
    expect(issueTitleFromText("Nur ein Titel")).toBe("Nur ein Titel");
    expect(issueDescriptionFromText("Nur ein Titel")).toBeUndefined();
  });

  it("falls back to a default title for empty input", () => {
    expect(issueTitleFromText("   ")).toBe("OpenMausBot task");
  });

  it("keeps the whole request when one long line has to be truncated", () => {
    // Regression: the title caps at 200 and the brief is "the lines after the
    // first", so a single long line used to lose everything past character
    // 200 — the agent received a cut-off sentence and nothing else.
    const long = `Baue die Startseite um: ${"x".repeat(250)} und dann noch der Rest`;
    expect(issueTitleFromText(long)).toHaveLength(200);
    expect(issueDescriptionFromText(long)).toBe(long);
    expect(issueDescriptionFromText(long)).toContain("und dann noch der Rest");
  });

  it("still puts only the tail in the brief when the title fits", () => {
    expect(issueDescriptionFromText("Kurzer Titel\nDetails hier")).toBe("Details hier");
  });
});

describe("issueIdFromCursor", () => {
  // The harness hands back session.started's sessionId verbatim, so the
  // cursor is a bare ticket id. Reading it as an envelope made every
  // follow-up turn open a new ticket instead of commenting on the open one.
  it("reads the bare ticket id the harness stores", () => {
    expect(issueIdFromCursor("349bb483-1c2d-4e5f-9a8b-7c6d5e4f3a2b")).toBe("349bb483-1c2d-4e5f-9a8b-7c6d5e4f3a2b");
  });

  it("opens a new ticket when there is no cursor yet", () => {
    expect(issueIdFromCursor(undefined)).toBeUndefined();
    expect(issueIdFromCursor(null)).toBeUndefined();
    expect(issueIdFromCursor("   ")).toBeUndefined();
  });

  it("still accepts an envelope, so a stored cursor keeps working", () => {
    expect(issueIdFromCursor({ issueId: "issue-7" })).toBe("issue-7");
    expect(issueIdFromCursor({})).toBeUndefined();
    expect(issueIdFromCursor({ issueId: 42 })).toBeUndefined();
  });
});

describe("runSettled", () => {
  it("returns null while the run is still going", () => {
    expect(runSettled({ id: "r1", status: "running" })).toBeNull();
    expect(runSettled({ id: "r1", status: "queued" })).toBeNull();
  });

  it("maps terminal success states", () => {
    expect(runSettled({ id: "r1", status: "completed" })).toEqual({ ok: true, stopReason: "completed" });
    expect(runSettled({ id: "r1", status: "succeeded" })).toEqual({ ok: true, stopReason: "succeeded" });
  });

  it("maps terminal failure states", () => {
    expect(runSettled({ id: "r1", status: "failed" })).toEqual({ ok: false, stopReason: "failed" });
    expect(runSettled({ id: "r1", status: "cancelled" })).toEqual({ ok: false, stopReason: "cancelled" });
  });
});

describe("messageToEvents", () => {
  it("streams text messages as content.delta", () => {
    const events = messageToEvents(base, { seq: 1, type: "text", content: "Ich baue die Hero-Sektion." });
    expect(events).toEqual([
      { ...base, type: "content.delta", streamKind: "assistant_text", delta: "Ich baue die Hero-Sektion." },
    ]);
  });

  it("surfaces tool_use as item.started and tool_result as item.completed", () => {
    const started = messageToEvents(base, { seq: 2, type: "tool_use", tool: "Bash" });
    expect(started).toEqual([{ ...base, type: "item.started", itemType: "tool", itemId: "m2", title: "Bash" }]);
    const done = messageToEvents(base, { seq: 3, type: "tool_result", tool: "Bash", output: "ok" });
    expect(done).toEqual([{ ...base, type: "item.completed", itemType: "tool", itemId: "m3", ok: true }]);
  });

  it("maps error messages to runtime.error", () => {
    const events = messageToEvents(base, { seq: 4, type: "error", content: "build failed" });
    expect(events).toEqual([{ ...base, type: "runtime.error", message: "build failed" }]);
  });

  it("ignores unknown message types", () => {
    expect(messageToEvents(base, { seq: 5, type: "heartbeat" })).toEqual([]);
  });
});
