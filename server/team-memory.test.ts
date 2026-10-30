import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TeamMemory, TeamMemoryConflict, TEAM_MEMORY_PROMPT_MAX_BYTES } from "./team-memory.ts";
import { ensureSections, changeEmptySection, sectionMemoryKey, SECTION_CONTEXTS_FILE } from "./section-context.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
let memory: TeamMemory;
const source = { botId: "b1", botName: "Scout", threadId: "t1", at: 1_757_000_000_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-team-memory-"));
  memory = new TeamMemory(join(dir, "team-memory.json"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("propose", () => {
  it.each(["{broken", '{"version":1,"sections":{"Team":[{"invalid":true}]}}'])("preserves an unreadable existing file instead of replacing it: %s", (bytes) => {
    const file = join(dir, "team-memory.json");
    writeFileSync(file, bytes);
    const reopened = new TeamMemory(file);
    expect(reopened.list("")).toEqual([]);
    expect(() => reopened.propose("", { kind: "term", name: "new", detail: "cannot overwrite" }, source)).toThrow(/could not be read/);
    expect(reopened.list("")).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it.each(["constructor", "__proto__"])("keeps prototype-like section names through updates, rollback and restart: %s", (section) => {
    expect(memory.list(section)).toEqual([]);
    const first = memory.propose(section, { kind: "term", name: "OMB", detail: "original" }, source);
    const file = join(dir, "team-memory.json");
    memory = new TeamMemory(file);
    expect(memory.list(section)[0].detail).toBe("original");
    expect(memory.update(section, first.entry.id, { detail: "updated" })?.detail).toBe("updated");
    expect(new TeamMemory(file).list(section)[0].detail).toBe("updated");
    renameSync(file, file + ".saved");
    mkdirSync(file);
    expect(() => memory.update(section, first.entry.id, { detail: "lost" })).toThrow();
    expect(memory.list(section)[0].detail).toBe("updated");
    expect(memory.list("")).toEqual([]);
  });

  it("keeps an approved person unchanged until the replacement is approved", () => {
    const first = memory.propose("", { kind: "person", name: "Alex", detail: "original" }, source);
    memory.resolve("", first.entry.id, "accept");
    const replacement = memory.propose("", { kind: "person", name: "Alex", detail: "replacement" }, { ...source, at: source.at + 1 });
    expect(replacement.status).toBe("proposed");
    expect(replacement.entry.id).not.toBe(first.entry.id);
    expect(memory.systemPrompt("")).toContain("Alex: original");
    expect(memory.systemPrompt("")).not.toContain("replacement");
    expect(new TeamMemory(join(dir, "team-memory.json")).systemPrompt("")).toContain("Alex: original");
    memory.resolve("", replacement.entry.id, "accept");
    expect(memory.systemPrompt("")).toContain("Alex: replacement");
    expect(memory.list("").filter(entry => entry.status === "accepted")).toHaveLength(1);
  });

  it("masks a secret a bot put into an entry before it is stored or shown", () => {
    const key = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0".repeat(3);
    const proposed = memory.propose("", { kind: "place", name: "Billing API", detail: `the key is ${key}`, aliases: [] }, source);
    expect(proposed.entry.detail).not.toContain(key);
    expect(readFileSync(join(dir, "team-memory.json"), "utf8")).not.toContain(key);
  });

  it("rejects aliases that would make persisted entries unreadable", () => {
    expect(() => memory.propose("", { kind: "term", name: "OMB", detail: "app", aliases: ["x".repeat(121)] }, source)).toThrow(/aliases/);
    expect(memory.list("")).toEqual([]);
  });

  it("rolls memory back when a mutation cannot be saved", () => {
    const first = memory.propose("", { kind: "term", name: "OMB", detail: "original" }, source);
    const file = join(dir, "team-memory.json");
    renameSync(file, file + ".saved");
    mkdirSync(file);
    expect(() => memory.update("", first.entry.id, { detail: "lost" })).toThrow();
    expect(memory.list("")[0].detail).toBe("original");
    expect(() => memory.propose("", { kind: "term", name: "new", detail: "lost" }, source)).toThrow();
    expect(memory.list("")).toHaveLength(1);
    expect(() => memory.remove("", first.entry.id)).toThrow();
    expect(memory.list("")).toHaveLength(1);
  });
  it("holds every kind outside shared prompts until reviewed", () => {
    const place = memory.propose("", { kind: "place", name: "Launch plan", detail: "Notion page in the Marketing space" }, source);
    expect(place.status).toBe("proposed");
    const term = memory.propose("", { kind: "term", name: "MCHQ", detail: "MissionControlHQ, our old name" }, source);
    expect(term.status).toBe("proposed");
    const person = memory.propose("", { kind: "person", name: "Ayush", detail: "Founder, handles sales", aliases: ["Ayu"] }, source);
    expect(person.status).toBe("proposed");
    const decision = memory.propose("", { kind: "decision", name: "Ship Android first", detail: "Decided in the Monday sync" }, source);
    expect(decision.status).toBe("proposed");
    expect(memory.list("").map((entry) => [entry.name, entry.status])).toEqual([
      ["Launch plan", "proposed"],
      ["MCHQ", "proposed"],
      ["Ayush", "proposed"],
      ["Ship Android first", "proposed"],
    ]);
    expect(memory.systemPrompt("")).toBe("");
    memory.resolve("", term.entry.id, "accept");
    expect(memory.systemPrompt("")).toContain("MCHQ");
    expect(memory.systemPrompt("")).not.toContain("Launch plan");
  });

  it("keeps accepted terms and places until their selected replacement is reviewed", () => {
    const first = memory.propose("", { kind: "place", name: "Launch plan", detail: "old page" }, source);
    memory.resolve("", first.entry.id, "accept");
    const again = memory.propose("", { kind: "place", name: "launch plan", detail: "new page" }, source);
    expect(again.status).toBe("proposed");
    const other = memory.propose("", { kind: "place", name: "launch plan", detail: "another pending revision" }, source);
    expect(memory.systemPrompt("")).toContain("old page");
    expect(memory.systemPrompt("")).not.toContain("new page");
    memory.resolve("", other.entry.id, "reject");
    memory.resolve("", again.entry.id, "accept");
    expect(memory.list("")).toHaveLength(1);
    expect(memory.list("")[0].detail).toBe("new page");
  });

  it("keeps sections apart, and records who said it", () => {
    memory.propose("Work", { kind: "term", name: "OKR", detail: "quarterly goals" }, source);
    expect(memory.list("")).toEqual([]);
    expect(memory.list("Work")[0].source).toEqual(source);
  });

  it("refuses junk", () => {
    expect(() => memory.propose("", { kind: "person", name: "", detail: "x" }, source)).toThrow(/name/);
    expect(() => memory.propose("", { kind: "rumor" as never, name: "x", detail: "x" }, source)).toThrow(/kind/);
    expect(() => memory.propose("", { kind: "term", name: "x".repeat(200), detail: "x" }, source)).toThrow(/name/);
  });
});

describe("undoAccept", () => {
  it("removes an addition that applied on its own and brings back the fact it replaced, once", () => {
    const original = memory.propose("", { kind: "person", name: "Alex", detail: "original" }, source).entry;
    memory.resolve("", original.id, "accept");
    const replacement = memory.propose("", { kind: "person", name: "Alex", detail: "replacement" }, source).entry;
    memory.resolve("", replacement.id, "accept");
    const revision = memory.list("").find((entry) => entry.id === replacement.id)!.revision!;
    expect(memory.undoAccept("", replacement.id, revision)).toBe(true);
    expect(memory.list("").map((entry) => [entry.detail, entry.status])).toEqual([["original", "accepted"]]);
    expect(memory.undoAccept("", replacement.id, revision)).toBe(false);
  });

  it("changes nothing once the entry was edited since", () => {
    const added = memory.propose("", { kind: "term", name: "OMB", detail: "first" }, source).entry;
    memory.resolve("", added.id, "accept");
    const revision = memory.list("")[0]!.revision!;
    memory.update("", added.id, { detail: "a person's edit" });
    expect(memory.undoAccept("", added.id, revision)).toBe(false);
    expect(memory.list("")[0]).toMatchObject({ detail: "a person's edit", status: "accepted" });
  });
});

describe("resolve, update, remove", () => {
  it("rejects edits that collide with another accepted fact", () => {
    const a = memory.propose("", { kind: "term", name: "Alex", detail: "term" }, source);
    const place = memory.propose("", { kind: "place", name: "Alex", detail: "place" }, source);
    memory.resolve("", place.entry.id, "accept");
    expect(() => memory.update("", a.entry.id, { kind: "place" })).toThrow(/already exists/);
    expect(memory.list("")[0].kind).toBe("term");
  });
  it("accepts or drops a proposal exactly once", () => {
    const { entry } = memory.propose("", { kind: "person", name: "Bhanu", detail: "CTO" }, source);
    expect(memory.resolve("", entry.id, "accept")).toEqual({ claimed: true, state: "accepted" });
    expect(memory.list("")[0].status).toBe("accepted");
    expect(memory.resolve("", entry.id, "accept")).toEqual({ claimed: true, state: "already_settled" });
    const { entry: dropped } = memory.propose("", { kind: "decision", name: "Drop Telegram", detail: "not our surface" }, source);
    expect(memory.resolve("", dropped.id, "reject")).toEqual({ claimed: true, state: "rejected" });
    expect(memory.list("").some((candidate) => candidate.id === dropped.id)).toBe(false);
    expect(memory.resolve("", "nope", "accept")).toEqual({ claimed: false });
  });

  it("lets the person edit and delete, and keeps the file private", () => {
    const { entry } = memory.propose("", { kind: "term", name: "OMB", detail: "OpenMausBot" }, source);
    const edited = memory.update("", entry.id, { detail: "OpenMausBot, the app", aliases: ["OpenMaus"] });
    expect(edited?.detail).toBe("OpenMausBot, the app");
    expect(edited?.aliases).toEqual(["OpenMaus"]);
    expect(memory.remove("", entry.id)).toBe(true);
    expect(memory.remove("", entry.id)).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(dir, "team-memory.json")).mode & 0o777).toBe(0o600);
  });

  it("survives a restart", () => {
    memory.propose("", { kind: "term", name: "OMB", detail: "OpenMausBot" }, source);
    const reopened = new TeamMemory(join(dir, "team-memory.json"));
    expect(reopened.list("")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "team-memory.json"), "utf8")).version).toBe(2);
  });
});

describe("systemPrompt", () => {
  it("is empty with nothing accepted, and lists accepted entries by kind otherwise", () => {
    expect(memory.systemPrompt("")).toBe("");
    const term = memory.propose("", { kind: "term", name: "MCHQ", detail: "MissionControlHQ" }, source);
    const place = memory.propose("", { kind: "place", name: "Launch plan", detail: "Notion, Marketing space" }, source);
    const { entry } = memory.propose("", { kind: "person", name: "Ayush", detail: "Founder", aliases: ["Ayu"] }, source);
    memory.propose("", { kind: "decision", name: "Ship Android first", detail: "Monday sync" }, source);
    const beforeAccept = memory.systemPrompt("");
    expect(beforeAccept).not.toContain("Ayush");
    expect(beforeAccept).toBe("");
    memory.resolve("", term.entry.id, "accept");
    memory.resolve("", place.entry.id, "accept");
    memory.resolve("", entry.id, "accept");
    const prompt = memory.systemPrompt("");
    expect(prompt).toContain("Ayush (also: Ayu): Founder");
    expect(prompt).toContain("MCHQ: MissionControlHQ");
    expect(prompt).toContain("Launch plan: Notion, Marketing space");
    expect(prompt).not.toContain("Ship Android first");
    expect(prompt).toContain("propose_team_memory");
  });

  it("stays under its byte budget, newest first when it has to cut", () => {
    // 400 accepted terms written as one saved file: accepting each in turn was 800 saves, past the Windows runners' timeout.
    const entries = Array.from({ length: 400 }, (_, i) => ({
      id: `term-${i}`, kind: "term", name: `Term ${i}`, detail: "d".repeat(60), aliases: [], status: "accepted",
      source: { ...source, at: source.at + i }, updatedAt: source.at + i,
    }));
    writeFileSync(join(dir, "team-memory.json"), JSON.stringify({ version: 1, sections: { "": entries } }));
    const prompt = new TeamMemory(join(dir, "team-memory.json")).systemPrompt("");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(TEAM_MEMORY_PROMPT_MAX_BYTES + 400);
    expect(prompt).toContain("Term 399");
    expect(prompt).not.toContain("Term 0:");
  });
});

it("keeps memory and pending cards through rename, but never reuses a deleted identity", () => {
  ensureSections(["Memory editing"]);
  const originalKey = sectionMemoryKey("Memory editing");
  const { entry } = memory.propose("Memory editing", { kind: "decision", name: "Colour", detail: "Amber" }, source);
  changeEmptySection("Memory editing", "Memory post");
  expect(sectionMemoryKey("Memory post")).toBe(originalKey);
  expect(memory.resolveProposal(entry.id, "accept")).toMatchObject({ state: "accepted" });
  expect(memory.systemPrompt("Memory post")).toContain("Amber");
  ensureSections(["Memory editing"]);
  expect(memory.list("Memory editing")).toEqual([]);
  changeEmptySection("Memory post", null);
  ensureSections(["Memory post"]);
  expect(memory.list("Memory post")).toEqual([]);
  expect(new TeamMemory(join(dir, "team-memory.json")).list("Memory post")).toEqual([]);
});

it("rejects stale edits, deletion and pending replacements while retaining the old text", () => {
  const { entry } = memory.propose("", { kind: "decision", name: "Colour", detail: "Blue", key: "tapa/colour" }, source);
  memory.resolve("", entry.id, "accept");
  const old = memory.list("")[0];
  const next = memory.propose("", { kind: "decision", name: "Colour", detail: "Amber", key: "tapa/colour" }, source);
  memory.update("", old.id, { detail: "Green" }, old.revision);
  expect(() => memory.update("", old.id, { detail: "Stale" }, old.revision)).toThrow(TeamMemoryConflict);
  expect(() => memory.remove("", old.id, old.revision)).toThrow(TeamMemoryConflict);
  expect(() => memory.resolve("", next.entry.id, "accept")).toThrow(TeamMemoryConflict);
  expect(memory.list("")[0].history?.[0].detail).toBe("Blue");
});

it("replaces a keyed decision even when its name changes and preserves its history", () => {
  const first = memory.propose("", { kind: "decision", name: "Blue treatment", detail: "Use blue", key: "tapa/colour" }, source);
  memory.resolve("", first.entry.id, "accept");
  const second = memory.propose("", { kind: "decision", name: "Orange approved", detail: "Use orange", key: "tapa/colour" }, source);
  memory.resolve("", second.entry.id, "accept");
  expect(memory.search("", "blue")).toEqual([]);
  expect(memory.list("")).toHaveLength(1);
  expect(memory.list("")[0].history?.[0].detail).toBe("Use blue");
  expect(memory.list("", true).find(entry => entry.id === first.entry.id)?.status).toBe("superseded");
});

it("keeps pending replacement revisions valid through a server restart", () => {
  const first = memory.propose("", { kind: "decision", name: "Colour", detail: "Blue" }, source);
  memory.resolve("", first.entry.id, "accept");
  const replacement = memory.propose("", { kind: "decision", name: "Colour", detail: "Amber" }, source);
  const reopened = new TeamMemory(join(dir, "team-memory.json"));
  expect(reopened.resolve("", replacement.entry.id, "accept")).toMatchObject({ state: "accepted" });
  expect(reopened.list("")[0].detail).toBe("Amber");
});

it("discloses omitted notes, keeps pinned rules first and searches every accepted entry", () => {
  for (let i = 0; i < 20; i++) {
    const { entry } = memory.propose("", { kind: "term", name: `Rule ${i}`, detail: `${i === 0 ? "critical " : ""}${"x".repeat(550)}` }, { ...source, at: i });
    memory.resolve("", entry.id, "accept");
  }
  const old = memory.list("")[0];
  memory.update("", old.id, { pinned: true }, old.revision);
  const selection = memory.promptSelection("");
  expect(selection.loadedIds).toContain(old.id);
  expect(selection.loadedIds.length).toBeLessThan(selection.total);
  expect(selection.text).toContain("Some notes are not loaded");
  expect(Buffer.byteLength(selection.text)).toBeLessThanOrEqual(TEAM_MEMORY_PROMPT_MAX_BYTES);
  expect(memory.search("", "Rule 1", 25).length).toBeGreaterThan(0);
});

it("fails closed on unreadable team ownership without blocking prompt construction", () => {
  ensureSections(["Broken registry team"]);
  const { entry } = memory.propose("Broken registry team", { kind: "term", name: "Private", detail: "Do not guess ownership" }, source);
  memory.resolve("Broken registry team", entry.id, "accept");
  const original = readFileSync(SECTION_CONTEXTS_FILE, "utf8");
  try {
    writeFileSync(SECTION_CONTEXTS_FILE, "{broken");
    expect(memory.systemPrompt("Broken registry team")).toBe("");
    expect(() => memory.propose("Broken registry team", { kind: "term", name: "Lost", detail: "must not save" }, source)).toThrow(/could not be read/);
  } finally { writeFileSync(SECTION_CONTEXTS_FILE, original); }
  expect(memory.list("Broken registry team")[0].name).toBe("Private");
});


it("rejects duplicate accepted names under distinct keys without settling the proposal", () => {
  const first = memory.propose("", { kind: "decision", name: "Colour", detail: "Blue", key: "project/one" }, source).entry;
  memory.resolve("", first.id, "accept");
  const second = memory.propose("", { kind: "decision", name: "Colour", detail: "Orange", key: "project/two" }, source).entry;
  expect(() => memory.resolve("", second.id, "accept")).toThrow(/another key/);
  expect(memory.list("").find(entry => entry.id === second.id)?.status).toBe("proposed");
  expect(memory.list("").filter(entry => entry.status === "accepted")).toHaveLength(1);
});

it("accepts an edited pending replacement while preserving the accepted and proposed versions", () => {
  const first = memory.propose("", { kind: "decision", name: "Colour", detail: "Blue", key: "project/colour" }, source).entry;
  memory.resolve("", first.id, "accept");
  const second = memory.propose("", { kind: "decision", name: "Colour", detail: "Orange", key: "project/colour" }, source).entry;
  const edited = memory.update("", second.id, { detail: "Amber" }, second.revision)!;
  expect(edited.status).toBe("accepted");
  expect(edited.history?.map(version => version.detail)).toEqual(expect.arrayContaining(["Blue", "Orange"]));
  expect(memory.list("").filter(entry => entry.status === "accepted").map(entry => entry.detail)).toEqual(["Amber"]);
  const stale = memory.propose("", { kind: "decision", name: "Colour", detail: "Red", key: "project/colour" }, source).entry;
  memory.update("", edited.id, { detail: "Green" });
  expect(() => memory.update("", stale.id, { detail: "Pink" }, stale.revision)).toThrow(/changed after/);
  expect(memory.list("").find(entry => entry.id === stale.id)?.detail).toBe("Red");
});

it("requires every query term in shared search, including signed numbers", () => {
  const entry = memory.propose("", { kind: "decision", name: "Grade", detail: "Amber exposure -2", key: "project/grade" }, source).entry;
  memory.resolve("", entry.id, "accept");
  expect(memory.search("", "amber exposure")).toHaveLength(1);
  expect(memory.search("", "amber missing")).toHaveLength(0);
  expect(memory.search("", "exposure -2")).toHaveLength(1);
  expect(memory.search("", "exposure 2")).toHaveLength(0);
});

it("does not allocate section ownership during a read", () => {
  const before = readFileSync(SECTION_CONTEXTS_FILE, "utf8");
  expect(memory.systemPrompt("Read only fixture")).toBe("");
  sectionMemoryKey("Read only fixture");
  expect(readFileSync(SECTION_CONTEXTS_FILE, "utf8")).toBe(before);
});


it("keeps legacy label ownership stable when a write follows a read", () => {
  writeFileSync(SECTION_CONTEXTS_FILE, JSON.stringify({ version: 1, sections: ["Legacy team"], contexts: {} }));
  const old = { id: "legacy", kind: "decision", name: "Colour", detail: "Blue", aliases: [], status: "accepted", source, updatedAt: 1 };
  writeFileSync(join(dir, "team-memory.json"), JSON.stringify({ version: 2, sections: { "Legacy team": [old] } }));
  memory = new TeamMemory(join(dir, "team-memory.json"));
  expect(memory.list("Legacy team")[0].detail).toBe("Blue");
  memory.update("Legacy team", old.id, { detail: "Amber" });
  changeEmptySection("Legacy team", "Renamed legacy");
  expect(new TeamMemory(join(dir, "team-memory.json")).list("Renamed legacy")[0].detail).toBe("Amber");
  ensureSections(["Legacy team"]);
  expect(memory.list("Legacy team")).toEqual([]);
});
