import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTeamWelcomeStore } from "./team-welcome.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const PERSON = `p_${"a".repeat(22)}`;
let dir: string | null = null;
afterEach(async () => { if (dir) await removeTempDir(dir); dir = null; });

it("keeps one Announcements read mark per person, the newest, beside their other hints", () => {
  dir = mkdtempSync(join(tmpdir(), "team-welcome-"));
  const store = createTeamWelcomeStore(dir);
  store.save(PERSON, { hints: ["cloud-welcome-done", "teams-2026-11", "announcements-read-1763380800000"] });
  store.save(PERSON, { hints: ["announcements-read-1763467200000"] });
  expect(store.read(PERSON).hints).toEqual(["cloud-welcome-done", "teams-2026-11", "announcements-read-1763467200000"]);
  store.save(PERSON, { hints: ["announcements-read-1763300000000"] });
  expect(store.read(PERSON).hints, "an older one changes nothing").toEqual(["cloud-welcome-done", "teams-2026-11", "announcements-read-1763467200000"]);
  for (let index = 0; index < 80; index++) store.save(PERSON, { hints: [`announcements-read-${1763467200001 + index}`] });
  expect(store.read(PERSON).hints, "never fills the record").toEqual(["cloud-welcome-done", "teams-2026-11", "announcements-read-1763467200080"]);
});
