import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { openCalendarPreferencesStore } from "./calendar-preferences.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("persists ordered selections atomically per user and connected account with owner-only permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-preferences-"));
  directories.push(directory);
  const path = join(directory, "dashboard-preferences.json");
  const store = openCalendarPreferencesStore(path);
  store.save("user-1", "account-1", ["family", "holidays", "family"]);
  store.save("user-1", "account-2", ["work"]);
  store.save("user-2", "account-1", ["school"]);

  if (process.platform !== "win32") {
    expect(lstatSync(path).mode & 0o077).toBe(0);
  }

  const reopened = openCalendarPreferencesStore(path);
  expect(reopened.selected("user-1", "account-1")).toEqual(["family", "holidays"]);
  expect(reopened.selected("user-1", "account-2")).toEqual(["work"]);
  expect(reopened.selected("user-2", "account-1")).toEqual(["school"]);
  reopened.save("user-1", "account-1", []);
  expect(openCalendarPreferencesStore(path).selected("user-1", "account-1")).toEqual([]);
});
