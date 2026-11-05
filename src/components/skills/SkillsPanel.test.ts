import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillWire } from "@/lib/skills";

const fixture = vi.hoisted(() => ({
  state: { bots: [] as Array<{ id: string; name: string }>, config: {} as { team?: unknown } },
  dispatch: (() => {}) as (action: unknown) => void,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));

const { fromLabel, matchesSkill, skillTitle, whoLabel } = await import("@/lib/skills");
const { skillFlag, skillFrom } = await import("../../../shared/skill-catalog");
const { PanelTabs, takeTabSwitch } = await import("./PanelTabs");
const { SkillsBody, SkillText, WhoMenu } = await import("./SkillsPanel");

const skill = (name: string, more: Partial<SkillWire> = {}): SkillWire =>
  ({ id: `library:${name}`, name, description: `${name} helper`, from: { kind: "github", where: "acme/skills" }, who: "all", bots: ["pepper", "scout"], removable: true, ...more });
const name = (id: string) => ({ pepper: "Pepper", scout: "Scout" } as Record<string, string>)[id];
type Element = ReactElement<Record<string, unknown>>;
const body = (skills: SkillWire[] | null) => renderToStaticMarkup(createElement(SkillsBody, {
  skills: { skills, error: "", busy: false, refresh: async () => {}, setWho: async () => true, setForBot: async () => true, remove: async () => true },
  onAdd: () => {},
}));

beforeEach(() => {
  fixture.state = { bots: [{ id: "pepper", name: "Pepper" }, { id: "scout", name: "Scout" }], config: {} };
  fixture.dispatch = vi.fn();
});

describe("how a skill reads", () => {
  it("names a skill in words, where it came from, and who can use it", () => {
    expect(skillTitle({ name: "weekly-report" })).toBe("Weekly report");
    expect(skillTitle({ name: "review-pr" })).toBe("Review PR");
    expect(skillTitle({ name: "pdf-forms" })).toBe("PDF forms");
    expect(skillTitle({ name: "mcp" })).toBe("MCP");
    expect(skillTitle({ name: "fix-ui-and-api-docs" })).toBe("Fix UI and API docs");
    expect(skillTitle({ name: "prepare-draft" })).toBe("Prepare draft");
    expect(skillTitle({ name: "s3-upload" })).toBe("s3-upload");
    expect(fromLabel({ kind: "tool", tool: "codex" }, name)).toBe("From Codex");
    expect(fromLabel({ kind: "learned", botId: "pepper" }, name)).toBe("Learned by Pepper");
    expect(fromLabel({ kind: "learned", botId: "gone" }, name)).toBe("Learned by a bot");
    expect(whoLabel("all", [], name, false)).toBe("All bots");
    expect(whoLabel("all", [], name, true)).toBe("Everyone in the team");
    expect(whoLabel("bots", ["scout"], name, false)).toBe("Scout");
    expect(whoLabel("bots", ["scout", "pepper"], name, false)).toBe("2 bots");
    expect(whoLabel("bots", [], name, false)).toBe("Off");
    expect(matchesSkill(skill("weekly-report"), "WEEKLY rep")).toBe(true);
    expect(matchesSkill(skill("weekly-report"), "invoice")).toBe(false);
  });

  it("reads a stored source and a scan warning as the page names them", () => {
    expect(skillFrom("github.com/acme/skills@main/weekly")).toEqual({ kind: "github", where: "acme/skills" });
    expect(skillFrom("https://raw.githubusercontent.com/acme/skills/main/x/SKILL.md")).toEqual({ kind: "github", where: "acme/skills" });
    expect(skillFrom("learn:weekly notes", "pepper")).toEqual({ kind: "learned", botId: "pepper" });
    expect(skillFrom("org:acme/sales@1.0.0")).toEqual({ kind: "team" });
    expect(skillFrom("written:bot settings")).toEqual({ kind: "written" });
    expect(skillFrom("package:starter")).toEqual({ kind: "link", where: "package:starter" });
    expect(skillFlag([])).toBeUndefined();
    expect(skillFlag(["scripts/run.sh: pipes a download straight into a shell (curl|sh) — never enable"])).toBe("pipe");
    expect(skillFlag(["something new"])).toBe("other");
  });
});

describe("the Skills tab", () => {
  it("says what a skill is with one Add skill while there are none, and shows search only past eight", () => {
    const empty = body([]);
    expect(empty).toContain("A skill teaches your bots how to do one thing");
    expect(empty).toContain("Add skill");
    expect(empty).not.toContain("data-skills-list");
    const eight = body(Array.from({ length: 8 }, (_, index) => skill(`skill-${index}`)));
    expect(eight).toContain("data-skills-list");
    expect(eight).not.toContain("data-skills-search");
    expect(body(Array.from({ length: 9 }, (_, index) => skill(`skill-${index}`)))).toContain("data-skills-search");
  });

  it("shows a flagged skill's reason in one line, and never the words SKILL.md", () => {
    const html = renderToStaticMarkup(createElement(SkillText, { skill: skill("installer", { who: "off", bots: [], flag: "pipe" }) }));
    expect(html).toContain("Installer");
    expect(html).toContain("From GitHub");
    expect(html).toContain("Off until you check it: it runs a script straight from the internet.");
    expect(body([skill("installer", { flag: "changed" })])).not.toContain("SKILL.md");
  });

  it("offers All bots, Choose bots… and Off in the row's one menu, with the team's words on a Team Cloud", () => {
    const calls: string[] = [];
    const menu = (row: SkillWire) => WhoMenu({ skill: row, onAll: () => calls.push("all"), onChoose: () => calls.push("choose"), onOff: () => calls.push("off") }) as Element;
    const items = (row: SkillWire) => menu(row).props.items as Array<{ key: string; label: string; checked: boolean; onSelect: () => void }>;
    expect(items(skill("weekly")).map((item) => [item.label, item.checked])).toEqual([["All bots", true], ["Choose bots…", false], ["Off", false]]);
    expect(items(skill("weekly", { who: "bots", bots: ["scout"] })).map((item) => item.checked)).toEqual([false, true, false]);
    expect(items(skill("weekly", { who: "off", bots: [] })).map((item) => item.checked)).toEqual([false, false, true]);
    expect(menu(skill("weekly", { who: "bots", bots: ["scout"] })).props.shown).toBe("Scout");
    for (const item of items(skill("weekly"))) item.onSelect();
    expect(calls).toEqual(["all", "choose", "off"]);
    fixture.state.config = { team: { name: "Acme" } };
    expect(items(skill("weekly"))[0]!.label).toBe("Everyone in the team");
    expect(menu(skill("weekly")).props.shown).toBe("Everyone in the team");
  });
});

describe("Apps and Skills on one screen", () => {
  it("switches between the two tabs in place", () => {
    const tabs = PanelTabs({ current: "apps", titleId: "plugins-title" }) as Element;
    const [apps, skills] = (tabs.props.children as Element[]).filter(isValidElement) as Element[];
    expect(apps!.props).toMatchObject({ role: "tab", "aria-selected": true, id: "plugins-title" });
    expect(skills!.props).toMatchObject({ role: "tab", "aria-selected": false });
    (apps!.props.onClick as () => void)();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(takeTabSwitch()).toBe(false);
    (skills!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "skills" });
    expect(takeTabSwitch()).toBe(true);
    expect(takeTabSwitch()).toBe(false);
  });
});
