import { describe, expect, it } from "vitest";

import { computerFreeText, computerStillBusyText, computerWaitEndedText, computerWaitingText } from "./computer-wait.ts";

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

  it("settles the same chip with what happened", () => {
    expect(computerFreeText()).toBe("Computer free — continuing");
    expect(computerWaitEndedText()).toBe("Stopped waiting for the computer");
  });

  it("names the holder and a way out when the wait gives up", () => {
    expect(computerStillBusyText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 30 * 60_000)).toBe(
      "Computer is still busy after 30 minutes — TCPR operator is still running TCPR 3 hour capacity refill. Stop that turn, or run this on another computer.",
    );
    expect(computerStillBusyText({ name: "Ada" }, 30 * 60_000)).toBe(
      "Computer is still busy after 30 minutes — Ada is still using it. Stop that turn, or run this on another computer.",
    );
    expect(computerStillBusyText(undefined, 45_000)).toBe("Computer is still busy after 45 seconds. Stop that turn, or run this on another computer.");
  });
});
