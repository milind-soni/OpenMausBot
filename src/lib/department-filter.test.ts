import { describe, expect, it } from "vitest";
import { botInDepartment, filterableDepartments, GENERAL_DEPARTMENT } from "./department-filter";
import type { Bot } from "@/state/store";

const bot = (id: string, section?: string, hidden?: boolean) => ({ id, section, hidden }) as unknown as Bot;

describe("department filter", () => {
  it("lists used departments in workspace order and flags General", () => {
    const bots = [bot("a", "Social"), bot("b"), bot("c", "Dev"), bot("d", "Ghost", true)];
    expect(filterableDepartments(bots, ["Dev", "Ghost", "Social", "Empty"])).toEqual({ names: ["Dev", "Social"], hasGeneral: true });
    expect(filterableDepartments([bot("a", "Dev")], ["Dev"]).hasGeneral).toBe(false);
  });
  it("matches bots to a department", () => {
    expect(botInDepartment(bot("a", "Dev"), "all")).toBe(true);
    expect(botInDepartment(undefined, "all")).toBe(true);
    expect(botInDepartment(bot("a", "Dev"), "Dev")).toBe(true);
    expect(botInDepartment(bot("a", "Dev"), "Social")).toBe(false);
    expect(botInDepartment(bot("a"), GENERAL_DEPARTMENT)).toBe(true);
    expect(botInDepartment(bot("a", "Dev"), GENERAL_DEPARTMENT)).toBe(false);
    expect(botInDepartment(undefined, "Dev")).toBe(false);
  });
});
