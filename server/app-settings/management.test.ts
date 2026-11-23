import { expect, it } from "vitest";
import type { BotRecord } from "../store.ts";
import { settingsScopeRefusal } from "./management.ts";

it("checks the Chief's department and audience for both individual and global settings", () => {
  const chief = { id: "maus", chiefOfStaff: true } as BotRecord;
  const atlas = { id: "atlas", section: "Research" } as BotRecord;
  const bots = [chief, atlas];
  const store = { bots, sections: ["Research"], bot: (id: string) => bots.find((bot) => bot.id === id) ?? null };
  const target = { botId: "atlas" };
  expect(settingsScopeRefusal(chief, "bots.skills", target, store)).toMatch(/outside/);
  expect(settingsScopeRefusal(chief, "skills.library", {}, store)).toMatch(/whole workspace/);
  chief.managedSections = ["Research"];
  expect(settingsScopeRefusal(chief, "bots.skills", target, store)).toBeNull();
  expect(settingsScopeRefusal(chief, "bots.name", target, store)).toBeNull();
  expect(settingsScopeRefusal(chief, "skills.library", {}, store)).toBeNull();
  atlas.visibility = "admins";
  expect(settingsScopeRefusal(chief, "bots.skills", target, store)).toMatch(/outside/);
  expect(settingsScopeRefusal(chief, "skills.library", {}, store)).toMatch(/whole workspace/);
  delete atlas.visibility;
  atlas.hidden = true;
  expect(settingsScopeRefusal(chief, "bots.skills", target, store)).toMatch(/outside/);
  expect(settingsScopeRefusal(chief, "bots.archived", target, store)).toBeNull();
  chief.hidden = true;
  expect(settingsScopeRefusal(chief, "skills.library", {}, store)).toMatch(/active/);
});
