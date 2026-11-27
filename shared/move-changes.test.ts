import { describe, expect, it } from "vitest";
import { defaultMoveChoice, moveChanges, moveOffers, type MoveFacts, type MoveLending } from "./move-changes.ts";

const none: MoveFacts = { folder: null, folders: 0, engine: null, tools: [], skills: [], hidden: [], teammates: [] };
const off: MoveLending = { paused: false, folderLent: false, terminal: false, together: "unavailable" };
const nothing = { folder: false, commands: false, together: false };
const kinds = (facts: Partial<MoveFacts>, lending: Partial<MoveLending> = {}, choice = nothing) => moveChanges({ ...none, ...facts }, { ...off, ...lending }, choice).map((line) => line.kind);

describe("what moving a bot to My Cloud changes for it", () => {
  it("says nothing for a bot with nothing on this computer", () => {
    expect(moveChanges(none, off, nothing)).toEqual([]);
  });

  it("names its teammates only when it hands work to some, and says whether work still reaches them", () => {
    expect(kinds({ teammates: [] })).toEqual([]);
    expect(moveChanges({ ...none, teammates: ["Proofreader"] }, off, nothing)).toEqual([{ kind: "teammates", names: ["Proofreader"], reach: false }]);
    expect(moveChanges({ ...none, teammates: ["Proofreader"] }, { ...off, together: "on" }, nothing)[0]).toMatchObject({ reach: true });
    expect(moveChanges({ ...none, teammates: ["Proofreader"] }, { ...off, together: "off" }, { ...nothing, together: true })[0]).toMatchObject({ reach: true });
  });

  it("says where its working folder stands: lent already, lent by the choice, paused, or out of reach", () => {
    const folder = { folder: "~/code/app", folders: 1 };
    const line = (lending: Partial<MoveLending>, choice = nothing) => moveChanges({ ...none, ...folder }, { ...off, ...lending }, choice).find((entry) => entry.kind === "folder");
    expect(line({ folderLent: true })).toEqual({ kind: "folder", folder: "~/code/app", reach: "lent" });
    expect(line({}, { ...nothing, folder: true })).toMatchObject({ reach: "lent" });
    expect(line({})).toMatchObject({ reach: "not-lent" });
    expect(line({ paused: true, folderLent: true }, { ...nothing, folder: true })).toMatchObject({ reach: "paused" });
    expect(kinds({ folder: null })).not.toContain("folder");
  });

  it("names a local model engine only when it runs on one", () => {
    expect(moveChanges({ ...none, engine: "Ollama" }, off, nothing)).toEqual([{ kind: "engine", engine: "Ollama" }]);
    expect(kinds({ engine: null })).toEqual([]);
  });

  it("says commands are off for a bot that works in a folder or uses tools that start programs, until they're lent", () => {
    expect(kinds({ folder: "~/a", folders: 1 })).toEqual(["folder", "commands"]);
    expect(moveChanges({ ...none, tools: ["git-mcp"] }, off, nothing)).toEqual([{ kind: "commands", tools: ["git-mcp"] }]);
    expect(kinds({ tools: ["git-mcp"] }, { terminal: true })).toEqual([]);
    expect(kinds({ tools: ["git-mcp"] }, {}, { ...nothing, commands: true })).toEqual([]);
    expect(kinds({ tools: ["git-mcp"] }, { terminal: true, paused: true })).toEqual(["commands"]);
    expect(kinds({})).not.toContain("commands");
  });

  it("names skills that read folders lending never opens, only while commands aren't lent: with them a skill reads what it needs", () => {
    expect(moveChanges({ ...none, skills: ["weekly-digest"], hidden: ["~/.claude"] }, off, nothing)).toEqual([{ kind: "skills", skills: ["weekly-digest"], hidden: ["~/.claude"] }]);
    expect(kinds({ skills: [] })).toEqual([]);
    expect(kinds({ skills: ["weekly-digest"], hidden: ["~/.claude"] }, { terminal: true })).toEqual([]);
    expect(kinds({ skills: ["weekly-digest"], hidden: ["~/.claude"] }, {}, { ...nothing, commands: true })).toEqual([]);
    expect(kinds({ skills: ["weekly-digest"], hidden: ["~/.claude"] }, { terminal: true, paused: true })).toContain("skills");
  });

  it("puts what a person misses most first", () => {
    expect(kinds({ folder: "~/a", folders: 1, engine: "Ollama", tools: ["x"], skills: ["s"], hidden: ["~/.codex"], teammates: ["T"] }))
      .toEqual(["teammates", "folder", "engine", "commands", "skills"]);
  });
});

describe("what the move step offers, and how it opens", () => {
  const facts: MoveFacts = { ...none, folder: "~/code/app", folders: 1, teammates: ["T"] };
  it("offers the folder only when it isn't lent yet, commands only while they're off, and the link only while it's off", () => {
    expect(moveOffers(facts, { ...off, together: "off" })).toEqual({ folder: true, commands: true, together: true });
    expect(moveOffers(facts, { ...off, folderLent: true, terminal: true, together: "on" })).toEqual({ folder: false, commands: false, together: false });
    expect(moveOffers(facts, { ...off, together: "unavailable" }).together).toBe(false);
    expect(moveOffers({ ...facts, teammates: [] }, { ...off, together: "off" }).together).toBe(false);
    expect(moveOffers(none, off)).toEqual({ folder: false, commands: false, together: false });
  });
  it("offers nothing to lend while lending is paused", () => {
    expect(moveOffers(facts, { ...off, paused: true })).toMatchObject({ folder: false, commands: false });
  });
  it("opens with the working folder lent, as moves did before, and with commands and the link off", () => {
    expect(defaultMoveChoice(facts, off)).toEqual({ folder: true, commands: false, together: false });
    expect(defaultMoveChoice(facts, { ...off, folderLent: true })).toEqual({ folder: false, commands: false, together: false });
    expect(defaultMoveChoice(none, off)).toEqual({ folder: false, commands: false, together: false });
  });
});
