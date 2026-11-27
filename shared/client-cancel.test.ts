import { describe, expect, it } from "vitest";

import {
  STOPPED_TURN_NAME,
  assistantTranscript,
  errorTranscript,
  isCancelledTranscriptRow,
  isClientCancellation,
  isStoppedTurnName,
} from "./client-cancel.ts";

const CANCELLED = "The request was cancelled by the client.";

describe("isClientCancellation", () => {
  it.each([
    CANCELLED,
    "The request was canceled by the client.",
    "the request was cancelled by the client",
    "  The request was cancelled by the client.  ",
    "context canceled",
    "context canceled.",
    "Context Canceled",
    `context canceled${CANCELLED}`,
    `context canceled ${CANCELLED}`,
    "The operation was aborted",
    "The operation was aborted.",
    "This operation was aborted",
    "operation was aborted.",
    "Request was aborted.",
    "The request was aborted.",
    "The user aborted a request.",
    `provider returned a completion error: ${CANCELLED}`,
    `provider returned a streaming completion error: ${CANCELLED}`,
    "provider returned a completion error: context canceled",
    "provider returned a streaming completion error: This operation was aborted.",
  ])("matches a client abort: %s", (text) => {
    expect(isClientCancellation(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "rate limited",
    "Not logged in · Please run /login",
    "HTTP 500",
    `${CANCELLED} Please try again`,
    `Could not cancel the subscription`,
    `HTTP 500: ${CANCELLED}`,
    "provider returned a completion error: rate limited",
    `provider returned a completion error: ${CANCELLED} extra`,
    "The user aborted a request and the tool failed",
    "Request was aborted by the server",
    "The operation was aborted because the tool timed out",
    "signal is aborted without reason",
    "provider returned an error: " + CANCELLED,
  ])("leaves a real failure alone: %s", (text) => {
    expect(isClientCancellation(text)).toBe(false);
  });
});

describe("transcript mapping", () => {
  it("turns a client abort into a stop and keeps every other reply and error", () => {
    expect(assistantTranscript(CANCELLED)).toEqual({ kind: "stopped" });
    expect(assistantTranscript("Here is the plan.")).toEqual({ kind: "text", text: "Here is the plan." });
    expect(errorTranscript(CANCELLED)).toEqual({ kind: "stopped" });
    expect(errorTranscript("rate limited")).toEqual({ kind: "error", message: "rate limited" });
    expect(errorTranscript(`provider returned a completion error: ${CANCELLED}`)).toEqual({ kind: "stopped" });
  });

  it("names the stored stop so a phone that prints the tool name shows a word", () => {
    expect(STOPPED_TURN_NAME).toBe("stopped: Stopped");
    expect(isStoppedTurnName(STOPPED_TURN_NAME)).toBe(true);
    expect(isStoppedTurnName("Bash")).toBe(false);
  });
});

describe("isCancelledTranscriptRow", () => {
  const row = (patch: Parameters<typeof isCancelledTranscriptRow>[0]) => isCancelledTranscriptRow(patch);

  it("reads a legacy assistant bubble and a legacy error row as a stop", () => {
    expect(row({ role: "bot", kind: "text", text: CANCELLED })).toBe(true);
    expect(row({ role: "bot", kind: "activity", tool: { name: `error: ${CANCELLED}` } })).toBe(true);
    expect(row({ role: "bot", kind: "activity", tool: { name: STOPPED_TURN_NAME } })).toBe(true);
  });

  it("does not hide a person's message, a real error, or a bubble that also has files", () => {
    expect(row({ role: "user", kind: "text", text: CANCELLED })).toBe(false);
    expect(row({ role: "bot", kind: "text", text: "rate limited" })).toBe(false);
    expect(row({ role: "bot", kind: "activity", tool: { name: "error: rate limited" } })).toBe(false);
    expect(row({ role: "bot", kind: "text", text: `${CANCELLED} See the logs.` })).toBe(false);
    expect(row({ role: "bot", kind: "text", text: CANCELLED, attachments: [{ kind: "image" }] })).toBe(false);
    expect(row({ role: "bot", kind: "options", text: CANCELLED })).toBe(false);
  });
});
