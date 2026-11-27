import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { activityQuery, describeEntry, formatValue, whoLabel, type ActivityEntry } from "@/lib/activity";
import { setLocale } from "@/lib/i18n";
import { ActivityRow } from "./ActivitySection";

afterEach(() => setLocale("en"));

const visibility: ActivityEntry = {
  type: "admin", at: "2026-09-21T09:00:00.000Z", who: "boss@example.test", what: "visibility", action: "visibility.update",
  target: { kind: "bot", id: "b1", name: "Payroll" }, changed: ["visibility"], before: { visibility: "everyone" }, after: { visibility: { people: ["ada@example.test"] } },
};
const approval: ActivityEntry = {
  type: "approval", at: "2026-09-20T11:00:00.000Z", who: "ada@example.test", what: "user-approved", source: "user", bot: "Ops", tool: "Bash", summary: "echo hi", threadId: "t1",
};

describe("activity helpers", () => {
  it("builds the query the list and the CSV share, leaving empty filters out", () => {
    expect(activityQuery({ who: "", what: "all", from: "", to: "" })).toBe("");
    expect(activityQuery({ who: " ada ", what: "visibility", from: "2026-09-01", to: "2026-09-30" }))
      .toBe("?who=ada&what=visibility&from=2026-09-01&to=2026-09-30");
  });

  it("says what happened in the reader's words", () => {
    expect(describeEntry(visibility)).toBe("Changed who can see a bot: Payroll");
    expect(describeEntry(approval)).toBe("Approved: Bash in Ops");
    expect(describeEntry({ ...visibility, action: "future.thing", target: undefined })).toBe("future.thing");
    expect(whoLabel("Command line")).toBe("Command line");
    expect(whoLabel("")).toBe("—");
    expect(formatValue({ people: ["ada@example.test"] })).toBe('{"people":["ada@example.test"]}');
    expect(formatValue(null)).toBe("—");
  });
});

describe("activity row", () => {
  it("shows who did what and offers the changed values", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { entry: visibility }));
    expect(html).toContain("boss@example.test");
    expect(html).toContain("Changed who can see a bot: Payroll");
    expect(html).toContain("Changed: visibility");
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows an answered card with its summary", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { entry: approval }));
    expect(html).toContain("Approved: Bash in Ops");
    expect(html).toContain("echo hi");
    expect(html).not.toContain("aria-expanded");
  });
});
