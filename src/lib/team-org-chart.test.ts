import { describe, expect, it } from "vitest";

import { buildOrgChart } from "./team-org-chart";

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member", you: true as const };
const bots = [
  { id: "ada-chief", name: "Ada's Chief", chiefOfStaff: true, reportsTo: ADA.email },
  { id: "lead", name: "Tech Lead", section: "Product A", createdBy: BOB.email, reportsTo: ADA.email },
  { id: "seo", name: "SEO", section: "SEO/SEA", createdBy: ADA.email },
  { id: "owl", name: "Owl", section: "Product A", createdBy: BOB.email },
  { id: "fox", name: "Fox", section: "Product A", createdBy: ADA.email, reportsTo: BOB.email },
  { id: "notes", name: "Notes", createdBy: BOB.email },
  { id: "cleo-bot", name: "Cleo's bot", createdBy: "cleo@acme.test" },
  { id: "stray", name: "Stray" },
  { id: "gone", name: "Archived", createdBy: BOB.email, hidden: true },
];

describe("who reports to whom", () => {
  it("puts this person first, each person's Chief on top and their bots by department, General first", () => {
    const [bob, ada] = buildOrgChart(bots, [ADA, BOB]);
    expect(bob!.person?.email).toBe(BOB.email);
    expect(bob!.chief).toBeNull();
    expect(bob!.departments.map((department) => [department.key, department.bots.map((bot) => bot.id)])).toEqual([["", ["notes"]], ["Product A", ["fox", "owl"]]]);
    expect(ada!.chief?.id).toBe("ada-chief");
    expect(ada!.departments.map((department) => [department.key, department.bots.map((bot) => bot.id)])).toEqual([["Product A", ["lead"]], ["SEO/SEA", ["seo"]]]);
  });

  it("gives an owner nobody listed a column of their own, and bots nobody owns one last column", () => {
    const columns = buildOrgChart(bots, [ADA, BOB]);
    expect(columns.map((column) => column.person?.name ?? null)).toEqual(["Bob", "Ada", "Cleo", null]);
    expect(columns.at(-1)!.departments.flatMap((department) => department.bots.map((bot) => bot.id))).toEqual(["stray"]);
    expect(columns.flatMap((column) => column.departments.flatMap((department) => department.bots.map((bot) => bot.id)))).not.toContain("gone");
  });

  it("still offers a column for a person with no bots yet, to drop one on", () => {
    const columns = buildOrgChart([], [ADA, BOB]);
    expect(columns.map((column) => [column.person?.email, column.departments.length])).toEqual([[BOB.email, 0], [ADA.email, 0]]);
  });
});
