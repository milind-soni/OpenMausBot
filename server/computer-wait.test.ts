import { describe, expect, it } from "vitest";

import { CONTROL_BUSY, CONTROL_BUSY_OPENING, CONTROL_CALL_LATE, CONTROL_NOT_READY, CONTROL_NOT_READY_OPENING, CONTROL_WAITED, CONTROL_WAITED_HELD } from "./control-client.ts";
import {
  computerBusyText,
  computerFreeAfterText,
  computerParkedRefusal,
  computerQueuedText,
  computerParkedText,
  computerStoppedWaitingText,
  computerWaitDuration,
  computerWaitingText,
  isComputerParkedRefusal,
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
      "Waiting for its turn on this computer — 3rd in queue — Engineering Room is using it. Starts automatically when the turns ahead finish.",
    );
    expect(computerWaitingText(null, { position: 2, estimateMs: 90_000 })).toBe(
      "Waiting for its turn on this computer — 2nd in queue. Starts automatically when the turns ahead finish; recent waits here have taken 2 minutes.",
    );
    expect(computerWaitingText({ name: "Ada" }, { position: 4, estimateMs: 500 })).toBe(
      "Waiting for its turn on this computer — 4th in queue — Ada is using it. Starts automatically when the turns ahead finish; recent waits here have taken under a second.",
    );
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

describe("what a waiting turn's model reads", () => {
  const longest = "under a second";
  it("says another thread holds it, with its queue place and timings, and never who", () => {
    expect(computerBusyText({ position: 1, heldForMs: 120_000, estimateMs: 180_000 })).toBe(
      "Another thread is using this computer. This call was not performed. No screen or app state was checked. " +
      "This turn is 1st in line (the other thread has had it 2 minutes; recent waits 3 minutes) and gets it automatically. To keep waiting, take a screenshot.",
    );
  });

  it("promises no automatic seat when the turn is not in the queue", () => {
    const text = computerBusyText({ heldForMs: 5_000 });
    expect(text.startsWith(CONTROL_BUSY_OPENING)).toBe(true);
    expect(text).toContain("The other thread has had it 5 seconds. To check again");
    expect(text).not.toContain("automatically");
    expect(computerBusyText({ heldForMs: 120_000, estimateMs: 180_000 })).toContain("The other thread has had it 2 minutes; recent waits 3 minutes.");
    expect(computerBusyText({})).not.toContain("(");
  });

  it("reports a queue place without claiming anyone holds the computer", () => {
    const text = computerQueuedText({ position: 2, estimateMs: 3_000 });
    expect(text).toBe(
      "This computer is not ready for this turn yet, so this call was NOT performed. This turn is 2nd in line (recent waits 3 seconds) and gets it automatically. " +
      "No screen or app state was checked. To keep waiting, take a screenshot.",
    );
    expect(text.startsWith(CONTROL_NOT_READY_OPENING)).toBe(true);
    expect(text).not.toContain("Another thread");
  });

  it("parks without a holder, a failure, or a promise to continue", () => {
    const text = computerParkedRefusal(30 * 60_000);
    expect(text).toBe("This turn waited 30 minutes for this computer without getting it, so this call was NOT performed. Stop calling the computer tools now; nothing is broken.");
    expect(isComputerParkedRefusal(text)).toBe(true);
    expect(isComputerParkedRefusal(computerParkedRefusal(1_000))).toBe(true);
    expect(isComputerParkedRefusal("This turn waited 5 seconds for the application window to appear.")).toBe(false);
  });

  it("fits the 300 characters a saved-steps fallback hands the model, at its longest", () => {
    const facts = { position: 12, heldForMs: 500, estimateMs: 500 };
    expect(computerWaitDuration(500)).toBe(longest);
    for (const text of [computerBusyText(facts), computerBusyText({ heldForMs: 500, estimateMs: 500 }), computerQueuedText(facts), computerParkedRefusal(59 * 60_000), CONTROL_BUSY, CONTROL_NOT_READY, CONTROL_WAITED, CONTROL_WAITED_HELD, CONTROL_CALL_LATE]) {
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });
});
