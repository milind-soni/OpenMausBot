import { describe, expect, it } from "vitest";
import { timelineEvents, type TimelineMessage } from "./taskTimeline";

const old: TimelineMessage = { id: "old", role: "bot", kind: "activity", at: 10, turnId: "old-turn", tool: { name: "Bash", summary: "npm run build" } };
const live: TimelineMessage = { ...old, id: "live", at: 110, turnId: "live-turn" };

describe("tool run identity", () => {
  it("marks missing historical receipts unverified without mutating raw tools", () => {
    expect(timelineEvents([old])[0].state).toBe("unverified");
    expect(old.tool?.ok).toBeUndefined();
  });

  it("keeps only tools from the actual live turn running", () => {
    expect(timelineEvents([old, live], { busy: true, turnStartedAt: 100 }).map((e) => e.state)).toEqual(["unverified", "running"]);
  });

  it("does not infer liveness from busy without a run boundary", () => {
    expect(timelineEvents([old], { busy: true })[0].state).toBe("unverified");
  });

  it("honors a terminal receipt for that turn while a newer turn runs", () => {
    const terminal: TimelineMessage = { id: "terminal", at: 120, role: "bot", kind: "text", text: "Done", turnId: "live-turn", turnTerminal: true };
    expect(timelineEvents([old, live, terminal], { busy: true, turnStartedAt: 100 })[1].state).toBe("unverified");
  });

  it("preserves explicit tool outcomes", () => {
    expect(timelineEvents([{ ...old, tool: { name: "Bash", ok: true } }, { ...live, tool: { name: "Read", ok: false } }]).map((e) => e.state)).toEqual(["complete", "failed"]);
  });
});
