import { describe, expect, it } from "vitest";

import { nextMemberIds } from "./room-members";

const pick = (...ids: string[]) => new Set(ids);

describe("nextMemberIds", () => {
  it("keeps the existing roster in place so the room's lead does not move", () => {
    expect(nextMemberIds(["lead", "second"], pick("lead", "second"), ["second", "lead"])).toEqual(["lead", "second"]);
  });

  it("appends newly ticked bots after the members already in the room", () => {
    expect(nextMemberIds(["lead"], pick("lead", "scout", "archivist"), ["archivist", "lead", "scout"])).toEqual([
      "lead",
      "archivist",
      "scout",
    ]);
  });

  it("drops members that were unticked", () => {
    expect(nextMemberIds(["lead", "second"], pick("second"), ["lead", "second"])).toEqual(["second"]);
  });

  it("ignores ticked ids that are not offered in the list", () => {
    expect(nextMemberIds(["lead"], pick("lead", "ghost"), ["lead"])).toEqual(["lead"]);
  });

  it("returns nothing when every member is unticked", () => {
    expect(nextMemberIds(["lead"], pick(), ["lead"])).toEqual([]);
  });
});
