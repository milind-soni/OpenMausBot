import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamComputers, teamComputerAssignment, teamComputerCreate, teamComputerOwner } from "./team-computers.ts";

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-team-computers-"));
  directories.push(directory);
  const file = join(directory, "team-computers.json");
  const environmentId = randomUUID();
  return { file, environmentId, registry: new TeamComputers(file, environmentId) };
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("named team computer ownership", () => {
  it("persists unassigned identities before provisioning and retries without a second owner", () => {
    const { registry, file, environmentId } = fixture();
    const requestId = randomUUID();
    const created = registry.create("Design desktop", requestId);
    expect(created).toMatchObject({ id: requestId, name: "Design desktop", section: null });
    expect(teamComputerOwner(requestId)).toBe(`computer_${requestId}`);
    expect(registry.create("Design desktop", requestId)).toEqual(created);
    expect(() => registry.create("Different name", requestId)).toThrow(/different computer/);
    registry.setProblem(requestId, "Provider unavailable");
    const restarted = new TeamComputers(file, environmentId);
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.get(requestId)?.problem).toBe("Provider unavailable");
    expect(restarted.create("Design desktop", requestId)).toEqual({ ...created, problem: "Provider unavailable" });
    expect(restarted.list()).toHaveLength(1);
    restarted.setProblem(requestId);
    expect(new TeamComputers(file, environmentId).get(requestId)?.problem).toBeUndefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("has one computer per team and requires explicit unassignment before moving", () => {
    const { registry, file, environmentId } = fixture();
    const one = registry.create("One");
    const two = registry.create("Two");
    registry.assign(one.id, "Design");
    expect(() => registry.assign(two.id, "Design")).toThrow(/already has/);
    expect(() => registry.assign(one.id, "Engineering")).toThrow(/Unassign/);
    registry.assign(one.id, null);
    registry.assign(two.id, "Design");
    registry.assign(one.id, "Engineering");
    expect(new TeamComputers(file, environmentId).forSection("Design")?.id).toBe(two.id);
  });

  it("distinguishes General from unassigned and treats prototype team names as data", () => {
    const { registry } = fixture();
    const one = registry.create("One");
    const two = registry.create("Two");
    expect(registry.forSection(undefined)).toBeUndefined();
    registry.assign(one.id, "");
    registry.assign(two.id, "__proto__");
    expect(registry.forSection(undefined)?.id).toBe(one.id);
    expect(registry.forSection("__proto__")?.id).toBe(two.id);
  });

  it("only Auto without explicit VPS inherits; permission choices and Chief grants do not", () => {
    const { registry } = fixture();
    const computer = registry.create("Shared desktop");
    registry.assign(computer.id, "Design");
    expect(registry.forBot({ section: "Design" })?.id).toBe(computer.id);
    expect(registry.forBot({ section: "Design", cloudBackend: "box" })?.id).toBe(computer.id);
    for (const mode of ["cloud", "local", "vm", "off", "browser"]) {
      expect(registry.forBot({ section: "Design", computer: mode })).toBeUndefined();
    }
    expect(registry.forBot({ section: "Design", cloudBackend: "vps" })).toBeUndefined();
    expect(registry.forBot({ section: "Other" })).toBeUndefined();
  });

  it("requires explicit cost and sharing acknowledgements at the API boundary", () => {
    expect(teamComputerCreate.safeParse({ requestId: randomUUID(), name: "One" }).success).toBe(false);
    expect(teamComputerCreate.safeParse({ requestId: randomUUID(), name: "One", acknowledgeCost: true, boxId: "foreign" }).success).toBe(false);
    expect(teamComputerCreate.safeParse({ requestId: randomUUID(), name: "One", acknowledgeCost: true }).success).toBe(true);
    expect(teamComputerAssignment.safeParse({ section: "Design" }).success).toBe(false);
    expect(teamComputerAssignment.safeParse({ section: null, acknowledgeSharedAccess: true }).success).toBe(true);
  });

  it.each(["{bad", "[]", JSON.stringify({ version: 2, computers: [] })])("fails closed for malformed durable data %s", contents => {
    const { file, environmentId } = fixture();
    writeFileSync(file, contents);
    const registry = new TeamComputers(file, environmentId);
    expect(() => registry.list()).toThrow(/could not be loaded/);
    expect(() => registry.create("Replacement")).toThrow(/could not be loaded/);
    expect(() => registry.forBot({ section: "Design" })).toThrow(/could not be loaded/);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("rejects duplicate identities, team assignments and another workspace's registry", () => {
    const { file, registry, environmentId } = fixture();
    registry.create("One");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, computers: [saved.computers[0], saved.computers[0]] }));
    expect(() => new TeamComputers(file, environmentId).list()).toThrow(/duplicate computer/);
    writeFileSync(file, JSON.stringify({ ...saved, computers: [
      { ...saved.computers[0], section: "Design" },
      { ...saved.computers[0], id: randomUUID(), section: "Design" },
    ] }));
    expect(() => new TeamComputers(file, environmentId).list()).toThrow(/more than one/);
    writeFileSync(file, JSON.stringify(saved));
    expect(() => new TeamComputers(file, randomUUID()).list()).toThrow(/another workspace/);
  });

  it("does not follow a registry symlink or return writable internal entries", () => {
    const { file, registry, environmentId } = fixture();
    const original = registry.create("One");
    registry.list()[0]!.section = "Unconsented";
    expect(registry.get(original.id)?.section).toBeNull();
    const link = `${file}.link`;
    symlinkSync(file, link);
    expect(() => new TeamComputers(link, environmentId).list()).toThrow(/unsafe registry/);
  });
});
