import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { noteTurnEvent, resetTurnLive, silentSince, turnLive } from "./turn-status";

let seq = 0;
const note = (event: Partial<RuntimeEvent>, threadId = "t") =>
  noteTurnEvent({ eventId: `e${++seq}`, provider: "claudeAgent", threadId, createdAt: "2026-10-23T12:00:00.000Z", turnId: "turn-1", ...event } as RuntimeEvent);

afterEach(() => {
  resetTurnLive();
  vi.restoreAllMocks();
});

describe("a thread's silence", () => {
  it("restarts at every frame, even one that changes nothing on the line", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    note({ type: "content.delta", streamKind: "assistant_text", delta: "a" } as Partial<RuntimeEvent>);
    const status = turnLive("t");
    clock.mockReturnValue(5_000);
    note({ type: "content.delta", streamKind: "assistant_text", delta: "b" } as Partial<RuntimeEvent>);
    expect(silentSince("t")).toBe(5_000);
    expect(turnLive("t"), "the line's state is untouched, so nothing re-renders").toBe(status);
  });

  it("before any frame, counts from when the window first asked, however often it asks", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(silentSince("t")).toBe(1_000);
    clock.mockReturnValue(90_000);
    expect(silentSince("t")).toBe(1_000);
  });
});

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

  it("says it is summarizing earlier messages until the summary is done, and leaves anything newer on the line", () => {
    note({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    note({ type: "context.summarizing", active: true, turnId: undefined } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toMatchObject({ turnId: "turn-1", ended: false, status: { activity: "summarizing" } });
    note({ type: "context.summarizing", active: false, turnId: undefined } as Partial<RuntimeEvent>);
    expect(turnLive("t").status, "a finished or stopped summary clears the line").toBeNull();
    expect(turnLive("t").ended, "a summary after the turn ended (Compact button) leaves it ended").toBe(true);
    note({ type: "context.summarizing", active: true, turnId: undefined } as Partial<RuntimeEvent>);
    note({ type: "turn.started", turnId: "turn-2" } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toEqual({ turnId: "turn-2", ended: false, status: null });
    note({ type: "content.delta", streamKind: "reasoning_text", delta: "x", turnId: "turn-2" } as Partial<RuntimeEvent>);
    note({ type: "context.summarizing", active: false, turnId: undefined } as Partial<RuntimeEvent>);
    expect(turnLive("t").status, "a late end leaves the turn's own status").toEqual({ activity: "thinking" });
    expect(turnLive("t").ended, "a summary inside a running turn leaves it running").toBe(false);
  });

  it("carries what a call works on, how it is doing and its last output, and changes only when one of them does", () => {
    note({ type: "item.started", itemType: "tool", itemId: "c", title: "Bash" } as Partial<RuntimeEvent>);
    note({ type: "turn.progress", activity: "command", itemId: "c", target: "scrape.py", detail: "python3 scrape.py" } as Partial<RuntimeEvent>);
    const named = turnLive("t");
    expect(named.status).toEqual({ activity: "command", itemId: "c", target: "scrape.py", detail: "python3 scrape.py" });
    note({ type: "turn.progress", activity: "command", itemId: "c", target: "scrape.py", detail: "python3 scrape.py" } as Partial<RuntimeEvent>);
    expect(turnLive("t")).toBe(named);
    note({ type: "turn.progress", activity: "command", itemId: "c", target: "scrape.py", detail: "python3 scrape.py", quiet: { kind: "busy" } } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toMatchObject({ quiet: { kind: "busy" } });
    note({ type: "turn.progress", activity: "command", itemId: "c", target: "scrape.py", quiet: { kind: "output", at: 5 }, tail: ["page 12 of 40"] } as Partial<RuntimeEvent>);
    expect(turnLive("t").status).toMatchObject({ quiet: { kind: "output", at: 5 }, tail: ["page 12 of 40"] });
    note({ type: "thread.token-usage.updated", input: 1, output: 1 } as Partial<RuntimeEvent>);
    expect(turnLive("t").status, "a token count says nothing about the call").toMatchObject({ target: "scrape.py" });
  });

  it("keeps threads apart and returns the same snapshot until something shown changes", () => {
    note({ type: "content.delta", streamKind: "assistant_text", delta: "a" } as Partial<RuntimeEvent>, "x");
    const first = turnLive("x");
    note({ type: "content.delta", streamKind: "assistant_text", delta: "b" } as Partial<RuntimeEvent>, "x");
    expect(turnLive("x")).toBe(first);
    expect(turnLive("y")).toEqual({ ended: false, status: null });
  });
});
