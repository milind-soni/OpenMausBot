// Team memory: the people, places, decisions and terms every bot in a
// section shares. Every bot proposal waits for admin review; the person
// can edit or delete any of it.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TeamMemory, TEAM_MEMORY_PROMPT_MAX_BYTES } from "./team-memory.ts";
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

describe("resolve, update, remove", () => {
  it("rejects edits that collide with another accepted fact", () => {
    const a = memory.propose("", { kind: "term", name: "Alex", detail: "term" }, source);
    memory.propose("", { kind: "place", name: "Alex", detail: "place" }, source);
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
    expect(JSON.parse(readFileSync(join(dir, "team-memory.json"), "utf8")).version).toBe(1);
  });
});

describe("systemPrompt", () => {
  it("is empty with nothing accepted, and lists accepted entries by kind otherwise", () => {
    expect(memory.systemPrompt("")).toBe("");
    const term = memory.propose("", { kind: "term", name: "MCHQ", detail: "MissionControlHQ" }, source);
    const place = memory.propose("", { kind: "place", name: "Launch plan", detail: "Notion, Marketing space" }, source);
    const { entry } = memory.propose("", { kind: "person", name: "Ayush", detail: "Founder", aliases: ["Ayu"] }, source);
    memory.propose("", { kind: "decision", name: "Ship Android first", detail: "Monday sync" }, source); // still proposed
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
    // 400 accepted terms, ~75 bytes a line, well past the 6 000-byte budget.
    // They are written as one saved file, not proposed and accepted one at a
    // time: that was 800 fsync+rename saves of a growing JSON file (70 MB in
    // all), 4 s here and past the 20 s test timeout on the Windows runners.
    // The budget is systemPrompt's to keep, and it reads the loaded file.
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
