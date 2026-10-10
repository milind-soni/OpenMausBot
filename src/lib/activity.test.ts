import { describe, expect, it } from "vitest";

import { groupActivityByDay, outcomeChip, type ActivityRow } from "./activity";

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  at: "2026-09-07T09:00:00.000Z",
  threadId: "t1",
  tool: "Bash",
  app: null,
  label: "Ran a command",
  outcome: "ran",
  ...overrides,
});

describe("groupActivityByDay", () => {
  it("keeps newest-first order and groups rows under their local day", () => {
    // Local-time dates: the grouping is by the viewer's day, so the fixture
    // must not depend on the machine's offset from UTC.
    const local = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const rows = [
      row({ at: local(7, 18) }),
      row({ at: local(7, 9) }),
      row({ at: local(5, 9) }),
    ];
    const groups = groupActivityByDay(rows, new Date(2026, 8, 7, 20));
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([
      ["Today", 2],
      ["Sat 5 Sep", 1],
    ]);
  });

  it("calls the previous day Yesterday", () => {
    const groups = groupActivityByDay([row({ at: new Date(2026, 8, 6, 12).toISOString() })], new Date(2026, 8, 7, 20));
    expect(groups[0].label).toBe("Yesterday");
  });

  it("returns no groups for no rows", () => {
    expect(groupActivityByDay([], new Date())).toEqual([]);
  });
});

describe("outcomeChip", () => {
  it("gives every outcome a short word and a tone", () => {
    expect(outcomeChip("ran")).toEqual({ text: "Ran", tone: "ok" });
    expect(outcomeChip("failed")).toEqual({ text: "Failed", tone: "danger" });
    expect(outcomeChip("running")).toEqual({ text: "Running", tone: "accent" });
    expect(outcomeChip("allowed")).toEqual({ text: "Allowed", tone: "ok" });
    expect(outcomeChip("denied")).toEqual({ text: "Denied", tone: "danger" });
    expect(outcomeChip("waiting")).toEqual({ text: "Needs you", tone: "warn" });
  });
});
