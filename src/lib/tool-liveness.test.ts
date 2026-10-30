import { describe, expect, it } from "vitest";
import { liveToolIds, type ToolRunMessage } from "./tool-liveness";

describe("liveToolIds", () => {
  const toolMsg = (id: string, at: number, extra: Partial<ToolRunMessage> = {}): ToolRunMessage => ({
    id,
    at,
    role: "bot",
    kind: "activity",
    ...extra,
  });

  it("returns empty set when run is undefined or not busy", () => {
    const msgs = [toolMsg("t1", 100)];
    expect(liveToolIds(msgs, undefined).size).toBe(0);
    expect(liveToolIds(msgs, { busy: false, turnStartedAt: 50 }).size).toBe(0);
  });

  it("returns empty set when turnStartedAt is missing or invalid", () => {
    const msgs = [toolMsg("t1", 100)];
    expect(liveToolIds(msgs, { busy: true, turnStartedAt: null }).size).toBe(0);
    expect(liveToolIds(msgs, { busy: true, turnStartedAt: undefined }).size).toBe(0);
    expect(liveToolIds(msgs, { busy: true, turnStartedAt: Number.NaN }).size).toBe(0);
  });

  it("excludes tools created before turnStartedAt", () => {
    const msgs = [
      toolMsg("old-tool", 40),
      toolMsg("live-tool", 60),
    ];
    const live = liveToolIds(msgs, { busy: true, turnStartedAt: 50 });
    expect(live.has("old-tool")).toBe(false);
    expect(live.has("live-tool")).toBe(true);
  });

  it("excludes non-activity messages", () => {
    const msgs: ToolRunMessage[] = [
      { id: "text-msg", at: 60, role: "bot", kind: "text" },
      toolMsg("tool-msg", 60),
    ];
    const live = liveToolIds(msgs, { busy: true, turnStartedAt: 50 });
    expect(live.has("text-msg")).toBe(false);
    expect(live.has("tool-msg")).toBe(true);
  });

  it("excludes tools marked terminal or with turnCompletedAt", () => {
    const msgs = [
      toolMsg("terminal-tool", 60, { turnTerminal: true }),
      toolMsg("completed-tool", 70, { turnCompletedAt: 80 }),
      toolMsg("active-tool", 90),
    ];
    const live = liveToolIds(msgs, { busy: true, turnStartedAt: 50 });
    expect(live.has("terminal-tool")).toBe(false);
    expect(live.has("completed-tool")).toBe(false);
    expect(live.has("active-tool")).toBe(true);
  });

  it("excludes tools belonging to a turn that has completed or terminated", () => {
    const msgs = [
      toolMsg("t1", 60, { turnId: "turn-1" }),
      { id: "term-1", at: 70, role: "bot" as const, kind: "text", turnId: "turn-1", turnTerminal: true },
      toolMsg("t2", 80, { turnId: "turn-2" }),
    ];
    const live = liveToolIds(msgs, { busy: true, turnStartedAt: 50 });
    expect(live.has("t1")).toBe(false);
    expect(live.has("t2")).toBe(true);
  });
});
