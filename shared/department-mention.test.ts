import { describe, expect, it } from "vitest";
import { departmentMentions, taggableDepartments } from "./department-mention";

const maya = { id: "maya", name: "Maya", section: "Research" };
const theo = { id: "theo", name: "Theo", section: " Research " };
const nora = { id: "nora", name: "Nora", section: "Design" };
const lead = { id: "lead", name: "Design Lead", section: "Design" };
const solo = { id: "solo", name: "Solo" };
const ghost = { id: "ghost", name: "Ghost", section: "Ops", hidden: true };
const members = [maya, theo, nora, lead, solo, ghost];

describe("department tags", () => {
  it("lists each department that has a visible member", () => {
    expect(taggableDepartments(members)).toEqual([
      { name: "Research", members: [maya, theo] },
      { name: "Design", members: [nora, lead] },
      { name: "General", members: [solo] },
    ]);
  });

  it("gives a name to the member that has it", () => {
    const research = { id: "research", name: "research", section: "Design" };
    expect(taggableDepartments([maya, research]).map((department) => department.name)).toEqual(["Design"]);
    expect(departmentMentions("@Research status", [maya, research])).toEqual([]);
  });

  it("reaches each member of a tagged department once, in any case", () => {
    expect(departmentMentions("@research status, then @Research again", members)).toEqual([maya, theo]);
    expect(departmentMentions("@Design and @General", members)).toEqual([nora, lead, solo]);
    expect(departmentMentions("@Ops status", members)).toEqual([]);
  });

  it("prefers a longer bot name and rejects a longer word", () => {
    expect(departmentMentions("@Design Lead status", members)).toEqual([]);
    expect(departmentMentions("@Designers status", members)).toEqual([]);
    expect(departmentMentions("mail@Design /@Design", members)).toEqual([]);
    expect(departmentMentions("【@Design】 status", members)).toEqual([nora, lead]);
  });

  it("reads a name with punctuation in it", () => {
    const scout = { id: "scout", name: "Scout", section: "AI/ML" };
    expect(departmentMentions("@AI/ML status", [scout, solo])).toEqual([scout]);
  });
});
