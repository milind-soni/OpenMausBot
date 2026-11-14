import { describe, expect, it } from "vitest";

import en from "./en.json";

const english = en as Record<string, string>;

// "Team" names the organization a Team Cloud belongs to, so the sidebar's groups of bots are departments.
const DEPARTMENT_COPY = [
  "sidebar.section.", "sidebar.bot.moveToSection", "sidebar.newChannel.context", "team.", "teamSettings.", "teamShare.",
  "teamMemory.", "teamLibrary.share", "teamImport.newSection", "teamImport.backupCopies", "botAccess.teams.", "newBot.team",
  "botPanel.page.team", "botPanel.page.chiefTeams", "permissions.chief.", "composer.mention.team", "canvas.", "canvasComputers.",
  "mapComposer.placeholder", "place.view.autoTeam.line",
];
const TEAM_MAP = new Set(["canvas.title", "canvas.addToMap", "canvas.region"]);
const words = (text: string) => text.replace(/\{\w+\}/g, "");

describe("the sidebar's groups of bots", () => {
  it("are called departments, never teams", () => {
    const keys = Object.keys(english).filter((key) => DEPARTMENT_COPY.some((prefix) => key.startsWith(prefix)) && !TEAM_MAP.has(key));
    expect(keys.filter((key) => /\bteams?\b/i.test(words(english[key]!)))).toEqual([]);
    for (const key of ["sidebar.section.moveToContext", "sidebar.section.newContext", "sidebar.bot.moveToSection", "team.create", "newBot.team"]) {
      expect(english[key], key).toMatch(/department/i);
    }
  });

  it("list only prefixes that exist", () => {
    const all = Object.keys(english);
    expect(DEPARTMENT_COPY.filter((prefix) => !all.some((key) => key.startsWith(prefix)))).toEqual([]);
    expect([...TEAM_MAP].filter((key) => !Object.hasOwn(english, key))).toEqual([]);
  });
});
