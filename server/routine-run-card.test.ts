import { describe, expect, it } from "vitest";

import { routineRunFallbackText } from "./routine-run-card.ts";
import "./server-line-packs.ts";

const card = { runId: "run-1", routineId: "inbox", routineName: "Inbox digest", scheduledFor: 0 };

describe("the text of a routine run's card, for clients that show no cards", () => {
  it("says how the run stands, in the language of the conversation's person", () => {
    expect(routineRunFallbackText({ ...card, status: "failed", error: "Signed out" })).toBe("Routine “Inbox digest” failed\n\nSigned out");
    expect(routineRunFallbackText({ ...card, status: "failed", error: "Signed out" }, "de")).toBe("Routine „Inbox digest“ ist fehlgeschlagen\n\nSigned out");
    expect(routineRunFallbackText({ ...card, status: "queued", deferredAt: 1 }, "de")).toBe("Routine „Inbox digest“ ist zurückgestellt: das Ziel ist beschäftigt");
    expect(routineRunFallbackText({ ...card, status: "completed", goalStatus: "needs-input" })).toBe("Routine “Inbox digest” needs your input");
    expect(routineRunFallbackText({ ...card, status: "running" })).toBe("Routine “Inbox digest” running");
  });
});
