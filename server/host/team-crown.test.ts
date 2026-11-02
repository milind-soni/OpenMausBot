import { describe, expect, it } from "vitest";

import { teamCrownRefusal } from "./team-crown.ts";

const ada = "ada@acme.test";

describe("crowning a Chief of Staff on a team", () => {
  it("refuses any other bot someone owns, and says why in plain words", () => {
    expect(teamCrownRefusal(true, { name: "Payroll", createdBy: ada }, { chiefOfStaff: true }))
      .toBe("Payroll can't be made a Chief of Staff on a team: each person's own MausBot already looks after their bots and holds their inbox.");
    expect(teamCrownRefusal(true, { name: "Scout", reportsTo: ada }, { chiefOfStaff: true })).toMatch(/can't be made a Chief of Staff/);
  });

  it("lets a bot nobody owns be its department's Chief and a MausBot its person's, leaves an earlier crown alone, and ignores every other patch", () => {
    expect(teamCrownRefusal(true, { name: "Ops", section: "Ops" }, { chiefOfStaff: true })).toBeNull();
    expect(teamCrownRefusal(true, { name: "MausBot", defaultBot: { person: ada } }, { chiefOfStaff: true }), "the person's own MausBot is their Chief").toBeNull();
    expect(teamCrownRefusal(true, { name: "Payroll", createdBy: ada, chiefOfStaff: true }, { chiefOfStaff: true })).toBeNull();
    expect(teamCrownRefusal(true, { name: "Payroll", createdBy: ada }, { chiefOfStaff: false })).toBeNull();
    expect(teamCrownRefusal(true, { name: "Payroll", createdBy: ada }, { title: "Lead" })).toBeNull();
    expect(teamCrownRefusal(true, null, { chiefOfStaff: true })).toBeNull();
  });

  it("applies nowhere but a team", () => {
    expect(teamCrownRefusal(false, { name: "Payroll", createdBy: ada }, { chiefOfStaff: true })).toBeNull();
  });
});
