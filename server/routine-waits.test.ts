import { beforeEach, describe, expect, it } from "vitest";

import { clearHeldReasons, recordHeldReason, withHeldReason } from "./routine-held-reasons.ts";
import { settleAsk } from "./routine-waits.ts";
import type { RoutineRun } from "./routines.ts";

describe("routine-waits heldReason propagation", () => {
  beforeEach(() => {
    clearHeldReasons();
  });

  it("keeps the plain timeout error when no held reason was recorded", () => {
    const run = {
      asked: { requestId: "req-1", approval: true, subject: "for “Run mcp_computer_run_steps”", since: 1_000 },
      waitedMs: 0,
    } as RoutineRun;
    const resolved = withHeldReason({
      eventId: "e1",
      provider: "antigravityAgent",
      threadId: "t-1",
      createdAt: "2026-11-26T00:00:00Z",
      type: "request.resolved",
      requestId: "req-1",
      behavior: "deny",
      source: "timeout",
    });
    expect(settleAsk(run, resolved, 2_000)).toBe("Stopped: nobody answered the approval for “Run mcp_computer_run_steps”");
  });

  it("preserves the approval card held reason on routine timeout and clears it afterwards", () => {
    recordHeldReason("t-2", "req-2", "This sends something on your behalf, so it asks you first.");
    const run = {
      asked: { requestId: "req-2", approval: true, subject: "for “Run mcp_composio_GMAIL_SEND_EMAIL”", since: 1_000 },
      waitedMs: 0,
    } as RoutineRun;
    const resolved = withHeldReason({
      eventId: "e2",
      provider: "antigravityAgent",
      threadId: "t-2",
      createdAt: "2026-11-26T00:00:00Z",
      type: "request.resolved",
      requestId: "req-2",
      behavior: "deny",
      source: "timeout",
    });
    expect(settleAsk(run, resolved, 5_000)).toBe(
      "Stopped: nobody answered the approval for “Run mcp_composio_GMAIL_SEND_EMAIL” (This sends something on your behalf, so it asks you first.)",
    );
    const repeat = withHeldReason({
      eventId: "e3",
      provider: "antigravityAgent",
      threadId: "t-2",
      createdAt: "2026-11-26T00:01:00Z",
      type: "request.resolved",
      requestId: "req-2",
      behavior: "deny",
      source: "timeout",
    });
    expect((repeat as { heldReason?: string }).heldReason).toBeUndefined();
  });
});
