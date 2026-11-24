import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderWorkflowSkillMd, WORKFLOW_FILE, type Workflow } from "../../shared/skill-burger/format.ts";
import { burgerSource } from "../../shared/skill-burger/saved.ts";
import { librarySkillDirectory, readSkillLibraryIndex } from "../skill-library.ts";
import { installSkill, listSkills, setSkillEnabled } from "../skills.ts";
import { findWorkflowSkill, listWorkflowSkills, migrateBotBurgers, readWorkflowSkill, removeWorkflowSkill, renameWorkflowSkill, saveWorkflowSkill, saverOf, workflowSkillsPrompt } from "./store.ts";

const workflow: Workflow = {
  version: 1,
  summary: "Email the weekly sales sheet to Priya",
  args: { recipient: { default: "priya@example.com", label: "recipient email" } },
  steps: [
    { id: "s1", kind: "app", app: "googlesheets", tool: "GOOGLESHEETS_BATCH_GET", label: "Read from Google Sheets", args: { spreadsheet_id: "1AbC" } },
    { id: "s2", kind: "ai", deterministic: false, label: "Write the body", prompt: "Write it.", input: { $step: "s1" } },
    { id: "s3", kind: "app", app: "gmail", tool: "GMAIL_SEND_EMAIL", label: "Send email", args: { recipient_email: { $arg: "recipient" }, body: { $step: "s2" } } },
  ],
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "burger-"));
  const bot = `burger-bot-${Math.random().toString(36).slice(2, 10)}`;
  return { root, bot, botIds: [bot] };
};

/** A burger the way one bot kept it as its own skill, before burgers were for every chat. */
function oldBotBurger(bot: string, name: string, saved: Workflow = workflow) {
  installSkill(bot, burgerSource(bot), [{ path: "SKILL.md", content: renderWorkflowSkillMd(name, saved) }, { path: WORKFLOW_FILE, content: JSON.stringify(saved) }]);
  setSkillEnabled(bot, name, true);
}

describe("saved burgers", () => {
  it("saves a run for every chat and every bot, remembering the bot it was made with and who saved it", () => {
    const { root, bot, botIds } = fixture();
    const saved = saveWorkflowSkill({ workflow, origin: bot, savedBy: "ada@acme.test", botIds, root });
    if ("error" in saved) throw new Error(saved.error);
    expect(saved).toMatchObject({ name: "email-the-weekly-sales-sheet-to", botId: bot, args: ["recipient"] });
    expect(saved.layers.map((layer) => [layer.kind, layer.app])).toEqual([["app", "googlesheets"], ["ai", undefined], ["app", "gmail"]]);
    expect(readSkillLibraryIndex(root)[saved.name]).toMatchObject({ everyBot: true, reviewState: "approved", tags: ["workflow"], source: `skill-burger:${bot}`, files: [WORKFLOW_FILE] });
    expect(JSON.parse(readFileSync(join(librarySkillDirectory(root, saved.name), WORKFLOW_FILE), "utf8"))).toEqual(workflow);
    expect(listSkills(bot)).toEqual([]);
    expect(saverOf(saved.name, root)).toBe("ada@acme.test");
    expect(readWorkflowSkill(saved.name, root)).toMatchObject({ workflow });
    expect(workflowSkillsPrompt("any-other-bot", root)).toContain(`- ${saved.name}: ${workflow.summary} Read`);
    // Any bot finds it to run.
    expect(findWorkflowSkill("any-other-bot", saved.name, root)).toMatchObject({ workflow });
    expect(listWorkflowSkills(root).map((skill) => skill.name)).toEqual([saved.name]);
  });

  it("refuses a taken or malformed name and a workflow that isn't one", () => {
    const { root, bot, botIds } = fixture();
    saveWorkflowSkill({ workflow, name: "sales-email", origin: bot, botIds, root });
    expect(saveWorkflowSkill({ workflow, name: "sales-email", origin: bot, botIds, root })).toMatchObject({ taken: true });
    expect(saveWorkflowSkill({ workflow, name: "Sales Email", origin: bot, botIds, root })).toHaveProperty("error");
    expect(saveWorkflowSkill({ workflow: { ...workflow, steps: [] }, origin: bot, botIds, root })).toHaveProperty("error");
    expect(saveWorkflowSkill({ workflow, origin: bot, botIds, root })).toMatchObject({ name: "sales-email" });
  });

  it("renames in place, keeping who saved it, and undoes a save, but never a copy that changed since", () => {
    const { root, bot, botIds } = fixture();
    const saved = saveWorkflowSkill({ workflow, origin: bot, savedBy: "ada@acme.test", botIds, root });
    if ("error" in saved) throw new Error(saved.error);
    const renamed = renameWorkflowSkill({ name: saved.name, to: "weekly-sales", botIds, root });
    if ("error" in renamed || "stale" in renamed) throw new Error("rename failed");
    expect(readWorkflowSkill("weekly-sales", root)?.text).toContain("name: weekly-sales");
    expect(saverOf("weekly-sales", root)).toBe("ada@acme.test");
    expect(saverOf(saved.name, root)).toBeUndefined();
    expect(removeWorkflowSkill("weekly-sales", "0".repeat(64), root)).toEqual({ stale: true });
    expect(removeWorkflowSkill("weekly-sales", renamed.sha256, root)).toEqual({ removed: true });
    expect(listWorkflowSkills(root)).toEqual([]);

    const again = saveWorkflowSkill({ workflow, origin: bot, botIds, root });
    if ("error" in again) throw new Error(again.error);
    writeFileSync(join(librarySkillDirectory(root, again.name), WORKFLOW_FILE), "{}");
    expect(listWorkflowSkills(root)).toEqual([]);
    expect(removeWorkflowSkill(again.name, again.sha256, root)).toEqual({ stale: true });
  });

  it("moves each bot's own burgers into every chat once, keeping both on a name clash and overwriting nothing", () => {
    const { root, bot } = fixture();
    const other = `${bot}-b`;
    const changed: Workflow = { ...workflow, summary: "Email the sales sheet to Sam" };
    // One already used in every chat holds the name the first bot's burger has.
    const there = saveWorkflowSkill({ workflow: changed, name: "sales-email", origin: other, botIds: [], root });
    if ("error" in there) throw new Error(there.error);
    oldBotBurger(bot, "sales-email");
    oldBotBurger(other, "weekly-numbers", changed);
    expect(findWorkflowSkill(bot, "sales-email", root)).toMatchObject({ workflow: changed });

    const moved = migrateBotBurgers([bot, other], root);
    expect(moved).toEqual([{ botId: bot, from: "sales-email", to: "sales-email-2" }, { botId: other, from: "weekly-numbers", to: "weekly-numbers" }]);
    expect(listSkills(bot)).toEqual([]);
    expect(listSkills(other)).toEqual([]);
    expect(readWorkflowSkill("sales-email", root)?.workflow).toEqual(changed);
    expect(readWorkflowSkill("sales-email-2", root)?.workflow).toEqual(workflow);
    expect(listWorkflowSkills(root).map((skill) => [skill.name, skill.botId]).sort()).toEqual([["sales-email", other], ["sales-email-2", bot], ["weekly-numbers", other]]);
    // Again: nothing left to move, nothing written twice.
    expect(migrateBotBurgers([bot, other], root)).toEqual([]);
    expect(listWorkflowSkills(root)).toHaveLength(3);
    // A move cut off after writing (the bot's copy still there) only takes the bot's copy away on the next start.
    oldBotBurger(bot, "sales-email-2");
    expect(migrateBotBurgers([bot], root)).toEqual([{ botId: bot, from: "sales-email-2", to: "sales-email-2" }]);
    expect(listWorkflowSkills(root)).toHaveLength(3);
  });
});

it("saving the same run again from the same bot gives back the burger it already saved", () => {
  const root = mkdtempSync(join(tmpdir(), "burger-"));
  const bot = `burger-bot-${Math.random().toString(36).slice(2, 10)}`;
  const first = saveWorkflowSkill({ workflow, origin: bot, botIds: [bot], root });
  const again = saveWorkflowSkill({ workflow, origin: bot, botIds: [bot], root });
  expect(again).toEqual(first);
  expect(listWorkflowSkills(root)).toHaveLength(1);
});
