import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTeamGroups } from "./team-groups.ts";

const ADA = "ada@acme.test", BOB = "bob@acme.test";

describe("a team's groups of people", () => {
  it("keeps members unique and lowercased, takes a person out of every group, and reads back what it saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-team-groups-"));
    const groups = createTeamGroups(dir);
    const finance = groups.put(null, { name: " Finance ", members: [" Bob@Acme.test ", BOB, ADA] })!;
    groups.put(null, { name: "Support", members: [BOB] });
    expect(finance).toMatchObject({ name: "Finance", members: [ADA, BOB] });
    expect(groups.leave(BOB).length).toBe(2);
    expect(groups.leave(BOB)).toEqual([]);
    expect(createTeamGroups(dir).list().map((group) => [group.name, group.members])).toEqual([["Finance", [ADA]], ["Support", []]]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("changes nothing when the file can't be written, so the change can be tried again", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-team-groups-"));
    const groups = createTeamGroups(dir);
    groups.put(null, { name: "Finance", members: [BOB] });
    chmodSync(dir, 0o500);
    try {
      expect(() => groups.leave(BOB)).toThrow();
      expect(groups.list()[0]!.members).toEqual([BOB]);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(groups.leave(BOB)).toHaveLength(1);
  });
});
