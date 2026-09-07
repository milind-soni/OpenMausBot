// Team memory: the people, places, decisions and terms every bot in a
// section shares. Bots propose; places and terms land at once, people and
// decisions wait for a tap; the person can edit or delete any of it.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
  it("accepts a place or a term at once, and holds a person or a decision for the person", () => {
    const place = memory.propose("", { kind: "place", name: "Launch plan", detail: "Notion page in the Marketing space" }, source);
    expect(place.status).toBe("accepted");
    const term = memory.propose("", { kind: "term", name: "MCHQ", detail: "MissionControlHQ, our old name" }, source);
    expect(term.status).toBe("accepted");
    const person = memory.propose("", { kind: "person", name: "Ayush", detail: "Founder, handles sales", aliases: ["Ayu"] }, source);
    expect(person.status).toBe("proposed");
    const decision = memory.propose("", { kind: "decision", name: "Ship Android first", detail: "Decided in the Monday sync" }, source);
    expect(decision.status).toBe("proposed");
    expect(memory.list("").map((entry) => [entry.name, entry.status])).toEqual([
      ["Launch plan", "accepted"],
      ["MCHQ", "accepted"],
      ["Ayush", "proposed"],
      ["Ship Android first", "proposed"],
    ]);
  });

  it("updates an entry with the same name and kind instead of adding a twin", () => {
    memory.propose("", { kind: "place", name: "Launch plan", detail: "old page" }, source);
    const again = memory.propose("", { kind: "place", name: "launch plan", detail: "new page" }, source);
    expect(again.status).toBe("updated");
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
    memory.propose("", { kind: "term", name: "MCHQ", detail: "MissionControlHQ" }, source);
    memory.propose("", { kind: "place", name: "Launch plan", detail: "Notion, Marketing space" }, source);
    const { entry } = memory.propose("", { kind: "person", name: "Ayush", detail: "Founder", aliases: ["Ayu"] }, source);
    memory.propose("", { kind: "decision", name: "Ship Android first", detail: "Monday sync" }, source); // still proposed
    const beforeAccept = memory.systemPrompt("");
    expect(beforeAccept).not.toContain("Ayush");
    memory.resolve("", entry.id, "accept");
    const prompt = memory.systemPrompt("");
    expect(prompt).toContain("Ayush (also: Ayu): Founder");
    expect(prompt).toContain("MCHQ: MissionControlHQ");
    expect(prompt).toContain("Launch plan: Notion, Marketing space");
    expect(prompt).not.toContain("Ship Android first");
    expect(prompt).toContain("propose_team_memory");
  });

  it("stays under its byte budget, newest first when it has to cut", () => {
    for (let i = 0; i < 400; i++) {
      memory.propose("", { kind: "term", name: `Term ${i}`, detail: "d".repeat(60) }, { ...source, at: source.at + i });
    }
    const prompt = memory.systemPrompt("");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(TEAM_MEMORY_PROMPT_MAX_BYTES + 400);
    expect(prompt).toContain("Term 399");
    expect(prompt).not.toContain("Term 0:");
  });
});
