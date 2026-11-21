import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTeamPeople } from "./team-people.ts";

const dirs: string[] = [];
const dir = () => { const made = mkdtempSync(join(tmpdir(), "omb-team-people-")); dirs.push(made); return made; };
afterEach(() => { for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true }); });

describe("the people a Team Cloud bot can report to", () => {
  it("are everyone the Admin paired, kept across a restart, by address", () => {
    const at = dir();
    const people = createTeamPeople(at);
    people.seen(" Ada@Acme.test ", "admin");
    people.seen("bob@acme.test", "member");
    expect(createTeamPeople(at).list().map((person) => [person.email, person.role])).toEqual([["ada@acme.test", "admin"], ["bob@acme.test", "member"]]);
    expect(people.has("ADA@acme.test")).toBe(true);
    expect(people.has("cleo@acme.test")).toBe(false);
  });

  it("stop offering someone the Admin said left, until they are paired again", () => {
    const at = dir();
    const people = createTeamPeople(at);
    people.seen("bob@acme.test", "member");
    people.left("bob@acme.test");
    const reread = createTeamPeople(at);
    expect(reread.list()).toEqual([]);
    expect([reread.has("bob@acme.test"), reread.gone("bob@acme.test")]).toEqual([false, true]);
    reread.seen("bob@acme.test", "member");
    expect([reread.has("bob@acme.test"), reread.gone("bob@acme.test")]).toEqual([true, false]);
  });

  it("say who joined, changed role or left, not each pairing", () => {
    const people = createTeamPeople(dir());
    const changes: string[] = [];
    people.onChange((email, change) => changes.push(`${email} ${change}`));
    people.seen("ada@acme.test", "member");
    people.seen("ada@acme.test", "member");
    people.seen("ada@acme.test", "admin");
    people.left("ada@acme.test");
    people.left("ada@acme.test");
    people.seen("ada@acme.test", "admin");
    expect(changes).toEqual(["ada@acme.test joined", "ada@acme.test role", "ada@acme.test left", "ada@acme.test joined"]);
  });
});
