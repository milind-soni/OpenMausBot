import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BOT_SECTIONS, appSearchPhase, searchEmptyText, sectionMatches } from "./sections";

const section = (id: string) => {
  const entry = BOT_SECTIONS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no section ${id}`);
  return entry;
};
const found = (query: string, appNames: string[] = []) =>
  BOT_SECTIONS.filter((entry) => sectionMatches(entry, query.trim().toLowerCase(), appNames)).map((entry) => entry.id);

describe("bot settings search", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("finds Access by a connected app's name, and only when that app is connected", () => {
    expect(found("github", ["GitHub", "github"])).toContain("access");
    expect(found("github")).not.toContain("access");
    expect(sectionMatches(section("permissions"), "github", ["GitHub"])).toBe(false);
  });

  it("finds Access by the headings inside it in the person's language", () => {
    setLocale("zh");
    expect(found("应用")).toContain("access");
    expect(found("浏览器")).toContain("access");
    expect(found("权限")).toContain("permissions");
  });

  it("keeps the English keywords and shows everything for an empty search", () => {
    expect(found("composio")).toEqual(["access"]);
    expect(found("")).toHaveLength(BOT_SECTIONS.length);
  });

  it("says it is still looking while the connected apps load, and nothing matches only after", () => {
    expect(searchEmptyText("github", "loading")).toBe("Looking through connected apps…");
    expect(searchEmptyText("github", "ready")).toBe("Nothing matches “github”");
    expect(searchEmptyText("github", "unknown")).toBe("Nothing matches “github”");
  });

  it("keeps looking until the Email lookup has answered too", () => {
    expect(appSearchPhase({ phase: "ready", cardsSettled: true, emailSettled: false })).toBe("loading");
    expect(appSearchPhase({ phase: "unknown", cardsSettled: true, emailSettled: false })).toBe("loading");
    expect(appSearchPhase({ phase: "ready", cardsSettled: false, emailSettled: true })).toBe("loading");
    expect(appSearchPhase({ phase: "ready", cardsSettled: true, emailSettled: true })).toBe("ready");
    expect(appSearchPhase({ phase: "loading", cardsSettled: true, emailSettled: true })).toBe("loading");
  });
});
