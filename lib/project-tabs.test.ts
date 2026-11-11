import { describe, expect, test } from "vitest";
import { tabFromQuery } from "./project-tabs";

describe("project tab names", () => {
  test("current names open their tab", () => {
    for (const tab of ["issues", "code", "assets", "vault", "feedback", "settings"] as const) expect(tabFromQuery(tab)).toEqual({ tab });
  });
  test("old Repo and Pull requests links open Code at the matching section", () => {
    expect(tabFromQuery("repo")).toEqual({ tab: "code", section: "commits" });
    expect(tabFromQuery("pulls")).toEqual({ tab: "code", section: "pulls" });
    expect(tabFromQuery("board")).toEqual({ tab: "issues" });
    expect(tabFromQuery("team")).toEqual({ tab: "settings" });
  });
  test("anything else opens Issues", () => {
    for (const value of [null, "", "nope", "toString", "__proto__"]) expect(tabFromQuery(value)).toEqual({ tab: "issues" });
  });
});
