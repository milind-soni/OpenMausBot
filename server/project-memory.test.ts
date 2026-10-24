import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectMemory, ProjectMemoryError, readProjectMemoryProjects, type ProjectMemoryContext, type ProjectMemoryProject } from "./project-memory.ts";
import { TeamMemory, TeamMemoryConflict } from "./team-memory.ts";

let dir: string;
let file: string;
let memory: TeamMemory;
let service: ProjectMemory;
let contexts: Record<string, ProjectMemoryContext>;
let projects: ProjectMemoryProject[];
let sections: string[];
let keys: Record<string, string>;
const caller = { botId: "bot-alpha", threadId: "thread-alpha" };
const other = { botId: "bot-beta", threadId: "thread-beta" };
const fact = { operation: "remember", kind: "decision", name: "Synthetic canary", detail: "Canary amber 74", key: "acceptance/canary" };

function openService() {
  return new ProjectMemory({ memory, projects: () => projects, context: source => contexts[source.botId],
    sections: () => sections, sectionKey: section => keys[section], now: () => 1_792_625_000_000 });
}

function status(action: () => unknown, expected: number) {
  try { action(); throw new Error("Expected a project-memory error"); }
  catch (error) { expect(error).toBeInstanceOf(ProjectMemoryError); expect((error as ProjectMemoryError).status).toBe(expected); }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-project-memory-")));
  file = join(dir, "team-memory.json");
  memory = new TeamMemory(file);
  for (const name of ["alpha", "beta", "alpha-sibling"]) mkdirSync(join(dir, name));
  sections = ["Project Alpha", "Project Beta"];
  keys = { "Project Alpha": "team:alpha-stable", "Project Beta": "team:beta-stable" };
  contexts = {
    [caller.botId]: { ...caller, botName: "Alpha Engineer", section: sections[0], cwd: join(dir, "alpha"), canApply: true,
      messageId: "message-native", turnId: "turn-native", assignmentId: "assignment-native", rootJobId: "root-native" },
    [other.botId]: { ...other, botName: "Beta Engineer", section: sections[1], cwd: join(dir, "beta"), canApply: true },
  };
  projects = [{ id: "project-alpha", sectionKey: keys[sections[0]], root: join(dir, "alpha"), memberBotIds: [caller.botId] },
    { id: "project-beta", sectionKey: keys[sections[1]], root: join(dir, "beta"), memberBotIds: [other.botId] }];
  service = openService();
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("native project-memory projection", () => {
  it.each([601, 826, 1168])("explains a %i-character rejected detail without leaking or truncating it", length => {
    service.request(caller, fact);
    const before = readFileSync(file, "utf8");
    const detail = "PRIVATE_NOTE_".padEnd(length, "x");
    let rejected: ProjectMemoryError | undefined;
    try { service.request(caller, { ...fact, detail }); }
    catch (error) { rejected = error as ProjectMemoryError; }
    expect(rejected).toMatchObject({ status: 400, code: "invalid" });
    expect(rejected?.message).toContain("detail");
    expect(rejected?.message).toContain("600");
    expect(rejected?.message).toContain(String(length));
    expect(rejected?.message).not.toContain("PRIVATE_NOTE_");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("accepts a 600-character detail without truncation and returns the same revision on recall", () => {
    const detail = "x".repeat(600);
    const saved = service.request(caller, { ...fact, detail });
    if (!("entry" in saved) || !saved.entry) throw new Error("Expected saved entry");
    expect(saved.entry.detail).toBe(detail);
    expect(service.request(caller, { operation: "recall", entryId: saved.entry.id, revision: saved.entry.revision }))
      .toMatchObject({ entries: [{ detail, revision: saved.entry.revision }] });
  });

  it("identifies missing remember fields without returning submitted values", () => {
    expect(() => service.request(caller, { operation: "remember" })).toThrow(/kind/);
    expect(() => service.request(caller, { operation: "remember", kind: "decision", name: "PRIVATE_NOTE" })).toThrow(/detail/);
  });

  it("does not echo unknown field names in validation diagnostics", () => {
    try { service.request(caller, { ...fact, PRIVATE_UNKNOWN_KEY: "PRIVATE_VALUE" }); }
    catch (error) {
      expect((error as Error).message).not.toMatch(/PRIVATE_UNKNOWN_KEY|PRIVATE_VALUE/);
      expect((error as ProjectMemoryError).code).toBe("invalid");
      return;
    }
    throw new Error("Expected rejection");
  });

  it("retains trusted provenance and returns an explicitly untrusted noncanonical projection", () => {
    const written = service.request(caller, fact);
    expect(written).toMatchObject({ schema: "openmaus.project-memory.v1", canonical: false, promoted: false,
      untrusted_context: true, state: "remembered", project: { id: "project-alpha", sectionKey: "team:alpha-stable" },
      entry: { status: "accepted", detail: fact.detail, source: { ...caller, messageId: "message-native", turnId: "turn-native",
        project: { id: "project-alpha", assignmentId: "assignment-native", rootJobId: "root-native" } } } });
    expect(written).toHaveProperty("contentHash", expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(service.request(caller, { operation: "recall", query: "amber" })).toMatchObject({ state: "recalled", entries: [{ detail: fact.detail }] });
    expect(memory.list("Project Alpha")).toEqual([]);
    expect(memory.systemPrompt("Project Alpha")).toBe("");
    expect(memory.list("project-alpha")).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(3);
  });

  it("allows another explicitly admitted member in the same current native project", () => {
    service.request(caller, fact);
    contexts[other.botId].section = "Project Alpha";
    contexts[other.botId].cwd = projects[0].root;
    projects[0].memberBotIds.push(other.botId);
    expect(service.request(other, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
  });

  it("returns no cross-project fact for a guessed id and refuses cross-project deletion", () => {
    const written = service.request(caller, fact);
    if (!("entry" in written) || !written.entry) throw new Error("Expected saved entry");
    const original = readFileSync(file, "utf8");
    expect(service.request(other, { operation: "recall", query: "amber" })).toMatchObject({ entries: [] });
    expect(service.request(other, { operation: "recall", entryId: written.entry.id })).toMatchObject({ entries: [] });
    status(() => service.request(other, { operation: "forget", entryId: written.entry.id, revision: written.entry.revision }), 404);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("recalls an authorized current revision and returns no result for a stale or foreign pin", () => {
    const written = service.request(caller, fact);
    if (!("entry" in written) || !written.entry) throw new Error("Expected saved entry");
    const pinned = { operation: "recall", entryId: written.entry.id, revision: written.entry.revision };
    expect(service.request(caller, pinned)).toMatchObject({ no_relevant_memory: false,
      entries: [{ id: written.entry.id, revision: written.entry.revision, detail: fact.detail }] });
    expect(service.request(caller, { ...pinned, revision: "0".repeat(64) })).toMatchObject({ no_relevant_memory: true, entries: [] });
    expect(service.request(other, pinned)).toMatchObject({ no_relevant_memory: true, entries: [] });
    service.request(caller, { ...fact, detail: "Current corrected canary" });
    expect(service.request(caller, pinned)).toMatchObject({ no_relevant_memory: true, entries: [] });
  });

  it.each(["invalid", "0".repeat(63), "0".repeat(65), "A".repeat(64)])("rejects an invalid recall revision %j", revision => {
    status(() => service.request(caller, { operation: "recall", revision }), 400);
  });

  it.each(["projectId", "scope", "path", "source", "fromBotId", "fromThreadId", "sectionKey", "cwd"])("rejects a model-supplied %s on both reads and writes", key => {
    status(() => service.request(caller, { ...fact, [key]: "forged" }), 400);
    status(() => service.request(caller, { operation: "recall", [key]: "forged" }), 400);
    expect(memory.list({ projectId: "0".repeat(64) })).toEqual([]);
  });

  it("refuses caller substitution even if a different bot or thread exists", () => {
    status(() => service.request({ botId: caller.botId, threadId: other.threadId }, fact), 403);
    contexts[caller.botId] = { ...contexts[caller.botId], botId: other.botId };
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("rechecks explicit membership and native section membership on every read and write", () => {
    service.request(caller, fact);
    projects[0].memberBotIds = [other.botId];
    status(() => service.request(caller, { operation: "recall" }), 403);
    status(() => service.request(caller, fact), 403);
    projects[0].memberBotIds = [caller.botId];
    contexts[caller.botId].section = "Project Beta";
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("retains scope across a native section rename and retires it after deletion/recreation", () => {
    service.request(caller, fact);
    sections[0] = "Renamed Alpha";
    keys[sections[0]] = keys["Project Alpha"];
    contexts[caller.botId].section = sections[0];
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
    sections.splice(0, 1);
    status(() => service.request(caller, { operation: "recall" }), 403);
    sections.push("Renamed Alpha");
    keys["Renamed Alpha"] = "team:replacement-id";
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("refuses undriven writes without a proposal and still permits authorized reads", () => {
    service.request(caller, fact);
    const original = readFileSync(file, "utf8");
    contexts[caller.botId].canApply = false;
    status(() => service.request(caller, fact), 403);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
  });

  it("refuses a room audience with an unadmitted or reassigned native member", () => {
    service.request(caller, fact);
    contexts[caller.botId].audience = [{ botId: caller.botId, section: "Project Alpha" }, { botId: other.botId, section: "Project Alpha" }];
    status(() => service.request(caller, { operation: "recall" }), 403);
    projects[0].memberBotIds.push(other.botId);
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
    contexts[caller.botId].audience![1].section = "Project Beta";
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("rechecks trusted working directory changes and its path component boundary", () => {
    service.request(caller, fact);
    contexts[caller.botId].cwd = join(dir, "alpha-sibling");
    status(() => service.request(caller, { operation: "recall" }), 403);
    contexts[caller.botId].cwd = join(dir, "beta");
    status(() => service.request(caller, fact), 403);
    const nested = join(dir, "alpha", "src");
    mkdirSync(nested);
    contexts[caller.botId].cwd = nested;
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
    contexts[caller.botId].cwd = join(dir, "missing");
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("rejects lexical traversal and relative working directory aliases", () => {
    for (const cwd of [`${dir}/alpha/../alpha`, "alpha", `${dir}/alpha/.`, `${dir}/alpha/`]) {
      contexts[caller.botId].cwd = cwd;
      status(() => service.request(caller, { operation: "recall" }), 403);
    }
  });

  it("rejects symlinked roots, working directories and nested path components", () => {
    const alias = join(dir, "alpha-link");
    symlinkSync(projects[0].root, alias);
    contexts[caller.botId].cwd = alias;
    status(() => service.request(caller, { operation: "recall" }), 403);
    projects[0].root = alias;
    status(() => service.request(caller, fact), 403);
    projects[0].root = join(dir, "alpha");
    symlinkSync(join(dir, "beta"), join(dir, "alpha", "escape"));
    contexts[caller.botId].cwd = join(dir, "alpha", "escape");
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("refuses overlapping grants and malformed or duplicate project policies", () => {
    projects.push({ ...projects[0], id: "ambiguous" });
    status(() => service.request(caller, { operation: "recall" }), 403);
    projects[2].id = projects[0].id;
    status(() => service.request(caller, fact), 503);
    projects.splice(2, 1);
    projects[0].root = "";
    status(() => service.request(caller, { operation: "recall" }), 503);
  });

  it("does not transfer existing notes to a repointed project root", () => {
    service.request(caller, fact);
    projects[0].root = join(dir, "beta");
    contexts[caller.botId].cwd = projects[0].root;
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [] });
  });

  it("retains the accepted source and scope after reopening the native memory file", () => {
    const written = service.request(caller, fact);
    if (!("entry" in written) || !written.entry) throw new Error("Expected saved entry");
    memory = new TeamMemory(file);
    service = openService();
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ id: written.entry.id,
      revision: written.entry.revision, detail: written.entry.detail, source: written.entry.source }] });
    expect(service.request(other, { operation: "recall" })).toMatchObject({ entries: [] });
    projects[0].memberBotIds = [other.botId];
    service = openService();
    status(() => service.request(caller, { operation: "recall" }), 403);
  });

  it("provides a revision-bound reversible receipt and refuses a stale deletion", () => {
    const written = service.request(caller, fact);
    if (!("undo" in written)) throw new Error("Expected undo receipt");
    const replacement = service.request(caller, { ...fact, detail: "Corrected synthetic canary" });
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: "Corrected synthetic canary" }] });
    status(() => service.request(caller, written.undo), 404);
    if (!("undo" in replacement)) throw new Error("Expected replacement receipt");
    expect(() => service.request(caller, { ...replacement.undo, revision: "0".repeat(64) })).toThrow(TeamMemoryConflict);
    expect(service.request(caller, replacement.undo)).toMatchObject({ state: "forgotten" });
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [] });
  });

  it("redacts credential-shaped text before durable storage and recall", () => {
    const secret = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0".repeat(3);
    service.request(caller, { ...fact, detail: `Synthetic secret ${secret}` });
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    expect(JSON.stringify(service.request(caller, { operation: "recall" }))).not.toContain(secret);
  });

  it("keeps project and section data intact when a native atomic save fails", () => {
    service.request(caller, fact);
    memory.propose("Team unchanged", { kind: "term", name: "Team note", detail: "ordinary team behavior" }, { ...caller, botName: "Alpha", at: 1 });
    renameSync(file, file + ".saved");
    mkdirSync(file);
    expect(() => service.request(caller, { ...fact, detail: "Must not persist" })).toThrow();
    expect(service.request(caller, { operation: "recall" })).toMatchObject({ entries: [{ detail: fact.detail }] });
    expect(memory.list("Team unchanged")).toMatchObject([{ detail: "ordinary team behavior" }]);
  });

  it("preserves damaged native memory rather than replacing it", () => {
    writeFileSync(file, "{damaged");
    memory = new TeamMemory(file);
    service = openService();
    expect(() => service.request(caller, fact)).toThrow(/could not be read/);
    expect(readFileSync(file, "utf8")).toBe("{damaged");
  });

  it.each([0, 26, 1.5, "12"])("rejects an invalid recall limit %j", limit => {
    status(() => service.request(caller, { operation: "recall", limit }), 400);
  });

  it("loads only a private regular owner policy and rereads revocation", () => {
    const policy = join(dir, "project-memory-policy.json");
    expect(readProjectMemoryProjects(policy)).toEqual([]);
    writeFileSync(policy, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
    expect(readProjectMemoryProjects(policy)).toEqual(projects);
    writeFileSync(policy, JSON.stringify({ version: 1, projects: [] }));
    expect(readProjectMemoryProjects(policy)).toEqual([]);
    chmodSync(policy, 0o644);
    if (process.platform !== "win32") status(() => readProjectMemoryProjects(policy), 503);
    rmSync(policy);
    const target = join(dir, "private-policy.json");
    writeFileSync(target, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
    symlinkSync(target, policy);
    status(() => readProjectMemoryProjects(policy), 503);
  });
});
