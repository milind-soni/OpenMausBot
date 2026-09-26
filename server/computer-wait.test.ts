import { describe, expect, it } from "vitest";

import {
  computerFreeAfterText,
  computerParkedText,
  computerStoppedWaitingText,
  computerWaitDuration,
  computerWaitingText,
} from "./computer-wait.ts";

describe("computer wait wording", () => {
  it("reads as a queue position behind a named turn, never as an error", () => {
    expect(computerWaitingText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" })).toBe(
      "Waiting for its turn on this computer — TCPR operator is running TCPR 3 hour capacity refill. Starts automatically when that finishes.",
    );
    // a holder with no thread title (a room, or a bot's untitled turn)
    expect(computerWaitingText({ name: "Engineering Room" })).toBe(
      "Waiting for its turn on this computer — Engineering Room is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText(undefined)).toBe("Waiting for its turn on this computer. Starts automatically when it is free.");
    for (const text of [computerWaitingText({ name: "Ada", task: "Refill" }), computerWaitingText(null)]) {
      expect(text).not.toMatch(/error|failed|blocked/i);
    }
  });

  it("resolves with a history line beside the untouched waiting chip", () => {
    expect(computerFreeAfterText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 65_000)).toBe(
      "Computer free — continuing after waiting 1 minute (TCPR operator · TCPR 3 hour capacity refill held it)",
    );
    expect(computerFreeAfterText({ name: "Engineering Room" }, 90_000)).toBe(
      "Computer free — continuing after waiting 2 minutes (Engineering Room held it)",
    );
    expect(computerFreeAfterText(undefined, 4_000)).toBe("Computer free — continuing after waiting 4 seconds");
    expect(computerStoppedWaitingText({ name: "Ada", task: "Refill" }, 2_500)).toBe(
      "Stopped waiting for the computer after 3 seconds — Ada is running Refill.",
    );
    expect(computerStoppedWaitingText(null, 800)).toBe("Stopped waiting for the computer after under a second.");
  });

  it("says the queue position, and an estimate only once history exists", () => {
    expect(computerWaitingText({ name: "Ada", task: "Refill" }, { position: 1 })).toBe(
      "Waiting for its turn on this computer — 1st in queue — Ada is running Refill. Starts automatically when that finishes.",
    );
    expect(computerWaitingText({ name: "Engineering Room" }, { position: 3 })).toBe(
      "Waiting for its turn on this computer — 3rd in queue — Engineering Room is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText(null, { position: 2, estimateMs: 90_000 })).toBe(
      "Waiting for its turn on this computer — 2nd in queue. Starts automatically when it is free; recent waits here have taken 2 minutes.",
    );
    expect(computerWaitingText({ name: "Ada" }, { position: 4, estimateMs: 500 })).toBe(
      "Waiting for its turn on this computer — 4th in queue — Ada is using it. Starts automatically when that finishes; recent waits here have taken under a second.",
    );
    // No queue fact (older callers) and no history yet: today's exact text.
    expect(computerWaitingText({ name: "Ada" })).toBe(
      "Waiting for its turn on this computer — Ada is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText({ name: "Ada", task: "Refill" }, {})).toBe(
      "Waiting for its turn on this computer — Ada is running Refill. Starts automatically when that finishes.",
    );
    for (const position of [11, 12, 13, 21, 22, 23]) {
      const suffix = position === 11 || position === 12 || position === 13 ? "th"
        : position % 10 === 1 ? "st" : position % 10 === 2 ? "nd" : "rd";
      expect(computerWaitingText(undefined, { position })).toContain(position + suffix + " in queue");
    }
  });

  it("phrases a wait duration honestly at every scale", () => {
    expect(computerWaitDuration(0)).toBe("under a second");
    expect(computerWaitDuration(999)).toBe("under a second");
    expect(computerWaitDuration(1_000)).toBe("1 second");
    expect(computerWaitDuration(59_499)).toBe("59 seconds");
    expect(computerWaitDuration(90_000)).toBe("2 minutes");
  });

  it("names the holder and says the work continues when the wait parks", () => {
    expect(computerParkedText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 30 * 60_000)).toBe(
      "Computer still busy after 30 minutes — TCPR operator is still running TCPR 3 hour capacity refill. Parked — it continues automatically when the computer is free.",
    );
    expect(computerParkedText({ name: "Ada" }, 30 * 60_000)).toBe(
      "Computer still busy after 30 minutes — Ada is still using it. Parked — it continues automatically when the computer is free.",
    );
    expect(computerParkedText(undefined, 45_000)).toBe(
      "Computer still busy after 45 seconds. Parked — it continues automatically when the computer is free.",
    );
  });
});
