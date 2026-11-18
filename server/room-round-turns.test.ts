import { describe, expect, it } from "vitest";

import { finalTurnBlock, noteGroupTurn, roomRoundPasses, roomTurnsPerMember, turnsPerMemberPatch } from "./room-round-turns.ts";

function walk(round: string[], turns: number) {
  let spoken = new Set<string>();
  const first = spoken;
  const seen: Array<{ id: string; final: boolean; fresh: boolean }> = [];
  for (const id of roomRoundPasses(round, turns, (next) => { spoken = next; })) {
    seen.push({ id, final: finalTurnBlock(spoken) !== "", fresh: spoken !== first });
    noteGroupTurn(spoken, id);
  }
  return seen;
}

describe("turns per room member", () => {
  it("gives each member one turn and no final-turn line by default", () => {
    expect(roomTurnsPerMember(undefined)).toBe(1);
    expect(roomTurnsPerMember({})).toBe(1);
    expect(walk(["a", "b"], 1)).toEqual([
      { id: "a", final: false, fresh: false },
      { id: "b", final: false, fresh: false },
    ]);
  });

  it("walks the members once per turn, each pass with its own spoken set, and marks only the last pass final", () => {
    expect(walk(["a", "b"], 3).map(({ id, final }) => `${id}${final ? "!" : ""}`)).toEqual(["a", "b", "a", "b", "a!", "b!"]);
    expect(walk(["a"], 2)).toEqual([{ id: "a", final: false, fresh: false }, { id: "a", final: true, fresh: true }]);
  });

  it("stops every later pass when the caller breaks out", () => {
    const seen: string[] = [];
    for (const id of roomRoundPasses(["a", "b"], 3, () => {})) {
      seen.push(id);
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("tells a member on its last turn that it is final and to wrap up", () => {
    let last = new Set<string>();
    for (const _ of roomRoundPasses(["a"], 4, (next) => { last = next; }));
    expect(finalTurnBlock(last)).toContain("This is your final turn in this exchange (turn 4 of 4). Wrap up now");
    expect(finalTurnBlock(new Set())).toBe("");
  });

  it("reads only whole numbers from 1 to 5 from a stored room", () => {
    expect(roomTurnsPerMember({ turnsPerMember: 3 })).toBe(3);
    for (const turnsPerMember of [0, 6, 2.5, Number.NaN]) expect(roomTurnsPerMember({ turnsPerMember })).toBe(1);
  });

  it("checks the room PATCH field", () => {
    expect(turnsPerMemberPatch({ name: "Desk" }, {})).toEqual({});
    expect(turnsPerMemberPatch({ turnsPerMember: 5 }, {})).toEqual({ turnsPerMember: 5 });
    for (const turnsPerMember of [0, 6, 1.5, "2", null]) {
      expect(() => turnsPerMemberPatch({ turnsPerMember }, {})).toThrow("turnsPerMember must be a whole number from 1 to 5");
    }
    expect(() => turnsPerMemberPatch({ turnsPerMember: 2 }, { dm: true })).toThrow("direct-message channels");
  });
});
