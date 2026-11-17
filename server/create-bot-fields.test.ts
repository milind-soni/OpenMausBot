import { describe, expect, it } from "vitest";
import { createBotFields, type CopySource } from "./create-bot-fields.ts";

const selection = { instanceId: "claude", model: "claude-fixture" };
const bot = (id: string, section: string, extra: Partial<CopySource> = {}): CopySource =>
  ({ id, name: id, title: "Bug fixer", soul: "Fix bugs.", section, modelSelection: selection, ...extra });
const chief = bot("chief", "Work", { chiefOfStaff: true });

describe("createBotFields", () => {
  it("keeps the given fields when nothing is copied", () => {
    expect(createBotFields({ name: " Scout ", role: "Ops", instructions: "Work." }, chief, [chief]))
      .toEqual({ name: "Scout", role: "Ops", instructions: "Work.", soul: "Work." });
  });

  it("copies the soul, role and model of a bot the Chief looks after, then adds the handover", () => {
    const old = bot("old", "Work");
    expect(createBotFields({ name: "New", copyFromBotId: "old", instructions: "Start with PR 12." }, chief, [chief, old]))
      .toEqual({ name: "New", role: "Bug fixer", instructions: "Start with PR 12.", soul: "Fix bugs.\n\nStart with PR 12.", modelSelection: selection });
    expect(createBotFields({ name: "New", role: "Lead", copyFromBotId: "old" }, chief, [chief, old]))
      .toMatchObject({ role: "Lead", soul: "Fix bugs." });
  });

  it("refuses a bot outside the Chief's department, an archived bot and an unknown id", () => {
    const bots = [chief, bot("other", "Sales"), bot("gone", "Work", { hidden: true })];
    for (const copyFromBotId of ["other", "gone", "missing", 7]) {
      expect(createBotFields({ name: "New", copyFromBotId }, chief, bots)).toMatchObject({ status: 404 });
    }
  });

  it("refuses a copy whose soul would pass the size limit", () => {
    const big = bot("big", "Work", { soul: "x".repeat(24_000) });
    expect(createBotFields({ name: "New", copyFromBotId: "big", instructions: "more" }, chief, [chief, big])).toMatchObject({ status: 400 });
  });
});
