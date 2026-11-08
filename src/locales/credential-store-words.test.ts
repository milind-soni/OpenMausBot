import { expect, it } from "vitest";

import { locales } from "./index";

it("has the unreadable-credential-store notice for a PC in every language, without calling it a Mac", () => {
  const packs = Object.entries(locales) as Array<[string, Record<string, string | undefined>]>;
  expect(packs.length).toBeGreaterThan(10);
  for (const [language, pack] of packs) {
    expect(pack["connectors.stalePc"], language).toBeTruthy();
    expect(pack["connectors.stalePc"], language).not.toMatch(/Mac/);
  }
});
