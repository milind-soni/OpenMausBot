import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SkillAssignmentState } from "../shared/skill-request.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { skillManagementRequest } from "./host/skill-management-request.ts";
import { installLibrarySkill, libraryManagementRevision, readSkillLibraryIndex, setLibrarySkillEveryBot, setLibrarySkillReviewState, skillsLibraryRoot } from "./skill-library.ts";
import { installSkill, listSkills } from "./skills.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = () => ({ instanceId: "fixture", model: "fixture" });
const text = (name: string) => `---\nname: ${name}\ndescription: Fixture audit.\n---\nRead references/details.md.\n`;
const digest = (root: string): string => {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name).update(entry.isDirectory() ? digest(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
};

function fixture() {
  const name = `audit-${randomUUID()}`;
  const store = new Store(selection);
  const chief = store.createBot({ name: "Chief", section: name });
  const target = store.createBot({ name: "Target", section: name });
  store.setChiefOfStaff(chief.id);
  store.patchBotProfile(chief.id, { assignedSkills: [name] });
  store.patchBotProfile(target.id, { assignedSkills: ["unrelated-stale", "keep-this-too"] });
  const cfg = { features: { skillsLibrary: true }, fixture: name } as unknown as AppConfig;
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(cfg));
  const installed = installLibrarySkill({ name, instructions: text(name), source: "fixture-provenance", reviewState: "approved",
    files: [{ path: "references/details.md", content: "Preserve these details.\n" }, { path: "assets/data.bin", content: new Uint8Array([0, 255, 12]) }] });
  expect(installed).not.toHaveProperty("error");
  const host = createSkillsLibraryHost({ store, cfg, appendSkillRequestCard: () => { throw Error("management must not stage a skill write"); } });
  const listing = () => {
    const [status, body] = host.assignmentListing(chief, target.id);
    expect(status).toBe(200);
    return body.library as SkillAssignmentState[];
  };
  const state = (skillName = name) => listing().find((skill) => skill.name === skillName)!;
  const manage = (action: "share" | "assign" | "unassign", revision = state().management_revision, skillName = name, from = chief, direct: "full-access" | null = "full-access") =>
    skillManagementRequest(host, from, chief.threadId, { action, skill_name: skillName, target_bot_id: target.id, base_revision: revision }, direct);
  const snapshot = () => [readFileSync(join(DATA_DIR, "bots.json"), "utf8"), readFileSync(join(DATA_DIR, "config.json"), "utf8"), digest(skillsLibraryRoot()), JSON.stringify(store.bots)];
  return { name, store, chief, target, host, state, listing, manage, snapshot };
}

it.each(["share", "assign"] as const)("%s preserves other assignments, package, provenance and permissions, with persisted readback", (action) => {
  const f = fixture();
  const packageBefore = digest(skillsLibraryRoot());
  const configBefore = readFileSync(join(DATA_DIR, "config.json"), "utf8");
  const before = { ...f.target };
  const [status, receipt] = f.manage(action);
  expect(status).toBe(200);
  expect(receipt).toMatchObject({ state: "applied", result: { assignedSkills: ["unrelated-stale", "keep-this-too", f.name], skill: { assigned: true, available: true, scope: "selected_bots" } } });
  expect((receipt.result as { skill: unknown }).skill).toEqual(f.state());
  expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(f.target.assignedSkills);
  expect(f.target).toEqual({ ...before, assignedSkills: [...before.assignedSkills!, f.name] });
  expect(digest(skillsLibraryRoot())).toBe(packageBefore);
  expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).toBe(configBefore);
  const [removed, result] = f.manage("unassign");
  expect(removed).toBe(200);
  expect((result.result as { skill: unknown }).skill).toEqual(f.state());
  expect(f.target.assignedSkills).toEqual(before.assignedSkills);
  expect(f.state()).toMatchObject({ assigned: false, available: false });
});

it.each(["share", "assign"] as const)("%s accepts the 200th assignment, rejects the 201st without writes and permits stale removal", (action) => {
  const f = fixture();
  const previous = Array.from({ length: 200 }, (_, index) => `stale-${index}`);
  f.store.patchBotProfile(f.target.id, { assignedSkills: previous.slice(1) });
  expect(f.manage(action)[0]).toBe(200);
  expect(f.target.assignedSkills).toEqual([...previous.slice(1), f.name]);
  expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(f.target.assignedSkills);
  const patch = vi.spyOn(f.store, "patchBotProfile");
  try {
    const assigned = f.snapshot();
    expect(f.manage(action)[0]).toBe(200);
    expect(f.snapshot()).toEqual(assigned);
    expect(patch).not.toHaveBeenCalled();
    f.store.patchBotProfile(f.target.id, { assignedSkills: previous });
    patch.mockClear();
    const full = f.snapshot();
    const revision = f.state().management_revision;
    expect(f.manage(action, "wrong")[0]).toBe(409);
    expect(f.manage(action, "wrong", f.name, f.target)[0]).toBe(403);
    expect(f.manage(action, revision, f.name, f.chief, null)[0]).toBe(403);
    expect(f.manage(action, revision)).toMatchObject([422, { state: "failed", error: expect.stringContaining("200") }]);
    expect(f.snapshot()).toEqual(full);
    expect(patch).not.toHaveBeenCalled();
    expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(previous);
    f.store.patchBotProfile(f.chief.id, { assignedSkills: [] });
    patch.mockClear();
    const inaccessible = f.snapshot();
    expect(f.manage(action, revision)[0]).toBe(409);
    const inaccessibleRevision = libraryManagementRevision(readSkillLibraryIndex()[f.name]!, []);
    expect(f.manage(action, inaccessibleRevision)).toMatchObject([422, { error: expect.stringContaining("Chief's access") }]);
    expect(f.manage(action, "wrong")[0]).toBe(409);
    expect(f.snapshot()).toEqual(inaccessible);
    expect(patch).not.toHaveBeenCalled();
    const stale = f.state(previous[0]);
    expect(f.manage("unassign", stale.management_revision, stale.name)[0]).toBe(200);
    expect(f.target.assignedSkills).toEqual(previous.slice(1));
    expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(previous.slice(1));
  } finally { patch.mockRestore(); }
});

it("lists and removes a missing library assignment without dropping any other stale names", () => {
  const f = fixture();
  const stale = f.state("unrelated-stale");
  expect(stale).toMatchObject({ in_library: false, assigned: true, available: false, scope: null });
  const before = digest(skillsLibraryRoot());
  expect(f.manage("unassign", stale.management_revision, stale.name)[0]).toBe(200);
  expect(f.target.assignedSkills).toEqual(["keep-this-too"]);
  expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(["keep-this-too"]);
  expect(digest(skillsLibraryRoot())).toBe(before);
  expect(f.manage("unassign", stale.management_revision, stale.name)[0]).toBe(409);
});

it("checks current Chief authority, visibility, peer scope, conversation and revision before any write", () => {
  const f = fixture();
  const revision = f.state().management_revision;
  const rejected = (run: () => unknown, expected: number) => {
    const before = f.snapshot();
    expect((run() as [number, unknown])[0]).toBe(expected);
    expect(f.snapshot()).toEqual(before);
  };
  rejected(() => f.manage("assign", "wrong"), 409);
  rejected(() => f.manage("assign", revision, f.name, f.chief, null), 403);
  f.store.patchBot(f.chief.id, { chiefOfStaff: false });
  rejected(() => f.manage("assign", revision), 403);
  rejected(() => f.host.assignmentListing(f.chief, f.target.id), 403);
  f.store.patchBot(f.chief.id, { chiefOfStaff: true, peers: [] });
  rejected(() => f.manage("share", revision), 403);
  f.store.patchBot(f.chief.id, { peers: undefined });
  for (const patch of [{ visibility: "admins" as const }, { hidden: true }, { section: "another-team" }]) {
    f.store.patchBot(f.target.id, patch);
    rejected(() => f.manage("assign", revision), 403);
    rejected(() => f.host.assignmentListing(f.chief, f.target.id), 403);
    f.store.patchBot(f.target.id, { visibility: undefined, hidden: false, section: f.name });
  }
  f.store.patchBot(f.chief.id, { managedSections: ["another-team"] });
  f.store.patchBot(f.target.id, { section: "another-team" });
  expect(f.manage("assign", revision)[0]).toBe(200);
  rejected(() => f.manage("unassign", revision), 409);
});

it("does not treat a maintainer label as Chief authority", () => {
  const f = fixture();
  f.store.patchBotProfile(f.chief.id, { assignedSkills: [f.name] });
  expect(f.manage("assign")[0]).toBe(200);
  const revision = f.state().management_revision;
  expect(f.host.transferMaintainer(f.chief, f.chief.threadId, f.name, f.target.id, revision, "full-access")[0]).toBe(200);
  const before = f.snapshot();
  expect(f.manage("unassign", f.state().management_revision, f.name, f.target)[0]).toBe(403);
  expect(f.host.transferMaintainer(f.target, f.target.threadId, f.name, f.chief.id, f.state().management_revision, "full-access")[0]).toBe(403);
  expect(f.snapshot()).toEqual(before);
});

it("does not expose or assign unrelated library skills the Chief cannot access", () => {
  const f = fixture();
  const other = `other-${randomUUID()}`;
  installLibrarySkill({ name: other, instructions: text(other), source: "another-audience", reviewState: "approved" });
  expect(f.listing().some((skill) => skill.name === other)).toBe(false);
  f.store.patchBotProfile(f.chief.id, { assignedSkills: [] });
  expect(f.listing().some((skill) => skill.name === f.name)).toBe(false);
  f.store.patchBotProfile(f.target.id, { assignedSkills: [...f.target.assignedSkills!, f.name] });
  const before = f.snapshot();
  expect(f.manage("assign")[0]).toBe(422);
  expect(f.snapshot()).toEqual(before);
  expect(f.manage("unassign")[0]).toBe(200);
});

it("unassigns every-bot skills without claiming to revoke their access or changing scope", () => {
  const f = fixture();
  setLibrarySkillEveryBot(f.name, true);
  expect(f.manage("assign")[0]).toBe(200);
  const before = digest(skillsLibraryRoot());
  const [status, receipt] = f.manage("unassign");
  expect(status).toBe(200);
  expect(receipt.summary).toContain("Every-bot access");
  const state = f.state();
  expect(state).toMatchObject({ scope: "all_bots", assigned: false, available: true });
  expect((receipt.result as { skill: unknown }).skill).toEqual(state);
  const general = f.host.harnessListing(f.target.id, f.host.listBotSkills(f.target)).find((skill) => skill.name === f.name)!;
  expect(general.enabled).toBe(true);
  expect(general.shared).toMatchObject({ scope: state.scope, assigned: state.assigned, enabled: state.enabled, management_revision: state.management_revision });
  expect(new Store(selection).bot(f.target.id)?.assignedSkills).toEqual(f.target.assignedSkills);
  expect(digest(skillsLibraryRoot())).toBe(before);
});

it.each(["private", "disabled", "tampered"])("refuses a %s skill but permits removal without rewriting it", (kind) => {
  const f = fixture();
  if (kind === "private") installSkill(f.target.id, "private-fixture", [{ path: "SKILL.md", content: text(f.name) }]);
  if (kind === "disabled") setLibrarySkillReviewState(f.name, "disabled");
  if (kind === "tampered") writeFileSync(join(skillsLibraryRoot(), "skills", f.name, "references/details.md"), "tampered");
  const privateBefore = listSkills(f.target.id);
  expect(f.state()).toMatchObject({ shadowed: kind === "private", enabled: kind === "private" });
  const before = f.snapshot();
  expect(f.manage("assign")[0]).toBe(422);
  expect(f.snapshot()).toEqual(before);
  f.store.patchBotProfile(f.target.id, { assignedSkills: [...f.target.assignedSkills!, f.name] });
  const packageBefore = digest(skillsLibraryRoot());
  expect(f.manage("unassign")[0]).toBe(200);
  expect(listSkills(f.target.id)).toEqual(privateBefore);
  expect(digest(skillsLibraryRoot())).toBe(packageBefore);
  expect(readSkillLibraryIndex()[f.name]?.reviewState).toBe(kind === "disabled" ? "disabled" : "approved");
});

it("keeps memory and disk assignments unchanged when the registry save fails", () => {
  const f = fixture();
  const before = f.snapshot();
  const save = vi.spyOn(f.store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots").mockImplementationOnce(() => { throw Error("disk full"); });
  try {
    expect(f.manage("assign")[0]).toBe(500);
    expect(f.snapshot()).toEqual(before);
  } finally { save.mockRestore(); }
});
