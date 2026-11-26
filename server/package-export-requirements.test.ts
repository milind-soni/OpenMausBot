import { describe, expect, it } from "vitest";

import { createBotPackageExport, createTeamPackageExport } from "./package-export.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string, optional: boolean | undefined): BotRecord => ({
  id, threadId: `thread-${id}`, name: id, color: "green", createdAt: 1, section: "Research",
  installedPackage: {
    id: `source-${id}`, name: id, release: "1.0.0",
    requiredApps: [{ slug: "github", label: "GitHub", reason: `${id} reads repositories.`, ...(optional === undefined ? {} : { optional }) }],
  },
} as BotRecord);

const exporters = [
  ["bot package", (bots: BotRecord[]) => createBotPackageExport({ name: "Research", bots, groups: [], routines: [] }).package],
  ["team package", (bots: BotRecord[]) => createTeamPackageExport({ team: "Research", bots, groups: [], routines: [], published: null }).document.package],
] as const;

describe.each(exporters)("%s requirements", (_name, exportPackage) => {
  it.each([false, undefined])("keeps a required app after an optional copy (%s)", (required) => {
    const bots = [bot("optional", true), bot("required", required)];
    const original = JSON.stringify(bots);
    const apps = exportPackage(bots).requirements.apps;
    expect(apps).toHaveLength(1);
    expect(apps[0]?.optional).not.toBe(true);
    expect(apps[0]?.reason).toBe("required reads repositories.");
    expect(JSON.stringify(bots)).toBe(original);
  });

  it.each([false, undefined])("keeps a required app before an optional copy (%s)", (required) => {
    const apps = exportPackage([bot("required", required), bot("optional", true)]).requirements.apps;
    expect(apps).toHaveLength(1);
    expect(apps[0]?.optional).not.toBe(true);
    expect(apps[0]?.reason).toBe("required reads repositories.");
  });

  it("keeps an app optional when every selected bot treats it as optional", () => {
    const apps = exportPackage([bot("first", true), bot("second", true)]).requirements.apps;
    expect(apps).toEqual([{ slug: "github", label: "GitHub", reason: "first reads repositories.", optional: true }]);
  });
});
