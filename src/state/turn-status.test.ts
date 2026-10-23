import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { noteTurnEvent, resetTurnLive, turnLive } from "./turn-status";

let seq = 0;
const note = (event: Partial<RuntimeEvent>, threadId = "t") =>
  noteTurnEvent({ eventId: `e${++seq}`, provider: "claudeAgent", threadId, createdAt: "2026-10-23T12:00:00.000Z", turnId: "turn-1", ...event } as RuntimeEvent);

afterEach(() => resetTurnLive());

describe("a thread's live turn", () => {
  it("knows nothing before any frame", () => {
    expect(turnLive("t")).toEqual({ ended: false, status: null });
    expect(turnLive(undefined)).toEqual({ ended: false, status: null });
  });

  it("follows a long Write from its first byte to its own chip, then lets the chip's end clear it", () => {
    note({ type: "turn.started" });
    note({ type: "turn.progress", activity: "write", itemId: "w", bytes: 0 } as Partial<RuntimeEvent>);
    note({ type: "turn.progress", activity: "write", itemId: "w", file: "index.html", bytes: 14_500 } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toEqual({ activity: "write", itemId: "w", file: "index.html", bytes: 14_500 });
    note({ type: "item.started", itemType: "tool", itemId: "w", title: "Write" } as Partial<RuntimeEvent>);
    expect(turnLive("t").status, "the call's own chip keeps its report").toMatchObject({ file: "index.html" });
    note({ type: "item.completed", itemType: "tool", itemId: "w", ok: true } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toMatchObject({ ended: false, status: null });
  });

  it("lets any other chip, a question or the bot's words replace the report", () => {
    note({ type: "turn.progress", activity: "write", itemId: "w", bytes: 9 } as Partial<RuntimeEvent>);
    note({ type: "item.started", itemType: "tool", itemId: "other", title: "Bash" } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toBeNull();
    note({ type: "content.delta", streamKind: "assistant_text", delta: "Done" } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toEqual({ activity: "reply" });
    note({ type: "item.completed", itemType: "assistant_text", text: "Done" } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toBeNull();
    note({ type: "content.delta", streamKind: "reasoning_text", delta: "hmm" } as Partial<RuntimeEvent>);
    note({ type: "request.opened", requestType: "permission", tool: "Bash", summary: "rm" } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toBeNull();
  });

  it("ends with the turn, and a newer turn starts it over", () => {
    note({ type: "turn.progress", activity: "command", itemId: "c" } as Partial<RuntimeEvent>);
    note({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toEqual({ turnId: "turn-1", ended: true, status: null });
    note({ type: "thread.token-usage.updated", input: 1, output: 1 } as Partial<RuntimeEvent>);
    expect(turnLive("t").ended, "a late frame of the ended turn does not reopen it").toBe(true);
    note({ type: "item.completed", itemType: "assistant_text", text: "late", turnId: "turn-2" } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toEqual({ turnId: "turn-2", ended: false, status: null });
  });

  it("keeps threads apart and returns the same snapshot until something shown changes", () => {
    note({ type: "content.delta", streamKind: "assistant_text", delta: "a" } as Partial<RuntimeEvent>, "x");
    const first = turnLive("x");
    note({ type: "content.delta", streamKind: "assistant_text", delta: "b" } as Partial<RuntimeEvent>, "x");
    expect(turnLive("x")).toBe(first);
    expect(turnLive("y")).toEqual({ ended: false, status: null });
  });
});
