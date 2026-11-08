import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, parsePackageDocument } from "../shared/package-format.ts";
import { writeSkillFolder } from "./skill-folder.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const PUBLISHER = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN = "https://admin.example.com";

let home: string;
const homes: string[] = [];
const libraries: Array<{ dispose(): void }> = [];

function release(name: string, edit?: (document: any) => void) {
  const document: any = parsePackageDocument(fixture(name), { trust: "file" });
  document.package.publisher = { organization: "acme", name: "Acme Partners" };
  edit?.(document);
  const bytes = canonicalJson(document);
  return { document, bytes, sha256: sha(bytes) };
}

function entry(packageId: string, rel: { document: any; bytes: string; sha256: string }, patch: Record<string, unknown> = {}) {
  const pkg = rel.document.package;
  return {
    packageId,
    ref: `acme/${pkg.id}`,
    name: pkg.name,
    tagline: pkg.tagline,
    kind: pkg.agents.length ? "team" : "library",
    publisher: { organizationId: PUBLISHER, name: "Acme Partners", self: false },
    mode: "available",
    offAction: "keep",
    release: { version: pkg.release, sha256: rel.sha256, sizeBytes: Buffer.byteLength(rel.bytes), formatVersion: 2, publishedAt: 1_700_000_000_000, notes: pkg.notes ?? "" },
    withdrawnReleases: [],
    contents: { bots: pkg.agents.length, skills: pkg.skills?.entries.length ?? 0, presets: pkg.presets?.length ?? 0, rooms: pkg.rooms?.length ?? 0,
      routines: pkg.routines?.length ?? 0, connections: pkg.connections?.length ?? 0, botNames: pkg.agents.map((agent: any) => agent.name) },
    scanFindings: 0,
    ...patch,
  };
}

function catalog(packages: unknown[], extra: Record<string, unknown> = {}) {
  return { format: "openmaus.org-library", version: 1, libraryVersion: 3, organization: { id: ORG, name: "Customer Co" }, packages, ...extra };
}

function relay(body: unknown, overrides: Record<string, unknown> = {}) {
  const text = JSON.stringify(body);
  return { adminOrigin: ADMIN, organizationId: ORG, organizationName: "Customer Co", digest: sha(text), catalog: text, ...overrides };
}

function snapshot(): string {
  const copy = mkdtempSync(join(tmpdir(), "omb-org-library-crash-"));
  homes.push(copy);
  cpSync(home, copy, { recursive: true });
  return copy;
}

async function installation(from?: string) {
  if (from) {
    (await import("./message-db.ts")).closeMessageDb();
    home = from;
  } else {
    home = mkdtempSync(join(tmpdir(), "omb-org-library-"));
    homes.push(home);
  }
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OMB_DATA_DIR", join(home, ".openmausbot"));
  const { Store } = await import("./store.ts");
  const { RoutineManager } = await import("./routines.ts");
  const skills = await import("./skills.ts");
  const { replaceOrganizationSkill, recoverOrganizationSkillLinks } = await import("./org-skill-update.ts");
  const { setSkillUseGuard } = await import("./skill-use-guard.ts");
  let skillInUse = false;
  setSkillUseGuard(() => skillInUse);
  const workspace = await import("./workspace.ts");
  const sections = await import("./section-context.ts");
  const { saveImage } = await import("./attachments.ts");
  const { botAvatarUrlFromStoredPath } = await import("../shared/bot-avatar.ts");
  const { DATA_DIR } = await import("./config.ts");
  const { OrgLibrary, parseOrgLibraryCatalog } = await import("./org-library.ts");
  const parts = await import("./package-parts.ts");
  const presetStore = (await import("./presets.ts")).createPresetStore(join(DATA_DIR, "org-library", "presets.json"));
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: (groupId, botId) => (store.group(groupId ?? "")?.memberIds.includes(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
  });
  const mcp = { servers: {} as Record<string, unknown> };
  const importDeps = {
    store,
    routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled, installOrg: skills.installOrgSkill },
    memory: { writeIndex: workspace.writeMemoryFile, writeTopic: workspace.writeMemoryTopic },
    mcp: { servers: () => mcp.servers, refusal: () => undefined, persist: (next: Record<string, unknown>) => { mcp.servers = next; } },
    sections: { writeBrief: (section: string, text: string) => void sections.writeSectionContext(section, text) },
    images: { save: (bytes: Uint8Array, mime: string) => botAvatarUrlFromStoredPath(saveImage(Buffer.from(bytes), mime).path)! },
    defaultSelection: () => ({ instanceId: "claude", model: "default-model" }),
    presets: presetStore,
  };
  const posted: any[] = [];
  const stamps = vi.fn(skills.skillPackageStamps);
  const open = (over: { installOrg?: typeof skills.installOrgSkill; replaceOrg?: typeof replaceOrganizationSkill } = {}) => {
    const library = new OrgLibrary({
    dataDir: DATA_DIR,
    store,
    routines,
    skills: { list: skills.listSkills, stamps, setEnabled: skills.setSkillEnabled, installOrg: over.installOrg ?? skills.installOrgSkill,
      replaceOrg: over.replaceOrg ?? replaceOrganizationSkill, recoverOrg: recoverOrganizationSkillLinks },
    sections: { read: (section) => sections.readSectionContext(section)?.text ?? "", write: (section, text) => void sections.writeSectionContext(section, text) },
    presets: presetStore,
    postState: (message) => posted.push(structuredClone(message)),
    retryDelayMs: 25,
  });
    libraries.push(library);
    return library;
  };
  const writeBlob = (bytes: string | Buffer, name = sha(bytes)) => {
    mkdirSync(join(DATA_DIR, "org-library", "blobs"), { recursive: true });
    writeFileSync(join(DATA_DIR, "org-library", "blobs", `${name}.json`), bytes);
  };
  const statePath = join(DATA_DIR, "org-library", "state.json");
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  return { store, routines, skills, replaceOrganizationSkill, recoverOrganizationSkillLinks, setSkillInUse: (value: boolean) => { skillInUse = value; }, stamps, parts, sections, DATA_DIR, importDeps, mcp, posted, open, writeBlob, statePath, readState, parseOrgLibraryCatalog };
}

afterEach(async () => {
  for (const library of libraries.splice(0)) library.dispose();
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the catalog", () => {
  it("ignores unknown fields, drops a bad entry, and refuses a bad envelope", async () => {
    const app = await installation();
    const team = release("full-team.v2.json");
    const good = { ...entry(TEAM_ID, team), futureField: { anything: true } };
    const bad = { ...entry(LIBRARY_ID, team), release: { ...entry(LIBRARY_ID, team).release, sha256: "not-a-hash" } };
    const parsed = app.parseOrgLibraryCatalog({ ...catalog([good, bad]), futureEnvelope: 1 })!;
    expect(parsed.packages.map((candidate) => candidate.packageId)).toEqual([TEAM_ID]);
    expect(parsed.packages[0]).not.toHaveProperty("futureField");
    expect(parsed).not.toHaveProperty("futureEnvelope");
    expect(app.parseOrgLibraryCatalog({ ...catalog([good]), version: 2 })).toBeNull();
    expect(app.parseOrgLibraryCatalog({ ...catalog([good]), organization: { id: ORG, name: "Bad\u0007name" } })).toBeNull();
  });

  it("keeps the last catalog when a bad envelope, another organization or wrong bytes arrive", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    expect(library.applyRelay(relay(catalog([entry(TEAM_ID, team)])))).toEqual({ ok: true });
    await library.settled();
    expect(library.list().packages.map((candidate) => candidate.packageId)).toEqual([TEAM_ID]);

    expect(library.applyRelay(relay({ format: "something-else" })).ok).toBe(false);
    expect(library.applyRelay(relay(catalog([]), { organizationId: OTHER_ORG })).ok).toBe(false);
    expect(library.applyRelay(relay({ ...catalog([]), organization: { id: OTHER_ORG, name: "Other" } }, { organizationId: OTHER_ORG })).ok).toBe(true);
    await library.settled();
    expect(library.list().organization).toEqual({ id: OTHER_ORG, name: "Other" });
    expect(library.applyRelay(relay(catalog([entry(TEAM_ID, team)])))).toEqual({ ok: true });
    await library.settled();
    expect(library.applyRelay({ ...relay(catalog([])), digest: "0".repeat(64) }).ok).toBe(false);
    expect(library.applyRelay(relay(catalog([]), { adminOrigin: "http://admin.example.com" })).ok).toBe(false);
    expect(library.list().packages.map((candidate) => candidate.packageId)).toEqual([TEAM_ID]);
  });

  it("shows a newer format as needing an update and never reads its file", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    const newer = entry(TEAM_ID, team, { release: { ...entry(TEAM_ID, team).release, formatVersion: 3 } });
    library.applyRelay(relay(catalog([newer])));
    await library.settled();
    const readBlob = vi.spyOn(library, "readBlob");
    expect(library.list().packages[0]).toMatchObject({ blob: "unsupported", installed: null });
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 409, code: "newer_app_required", error: "Update OpenMausBot to add this package." });
    expect(readBlob).not.toHaveBeenCalled();
    expect(app.store.bots).toHaveLength(0);
  });

  it("hides entries switched off for this organization and refuses to add them", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team, { mode: "off" })])));
    await library.settled();
    expect(library.list().packages).toEqual([]);
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 404, code: "not_listed" });
  });
});

describe("release files", () => {
  it("refuses a file whose bytes do not match the catalog, and reports the failure", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes.replace("Sales desk", "Sales dusk"), team.sha256);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    expect(library.readBlob(team.sha256)).toBeNull();
    expect(library.list().packages[0]!.blob).toBe("unavailable");
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 503, code: "blob_unavailable" });
    expect(app.store.bots).toHaveLength(0);
    expect(app.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "failed", reason: "blob_unavailable" }]);

    app.writeBlob(team.bytes);
    expect(library.list().packages[0]!.blob).toBe("ready");
  });

  it("refuses a file its catalog entry does not describe", async () => {
    const app = await installation();
    const library = app.open();
    const forged = release("full-team.v2.json", (document) => { document.package.publisher = { organization: "someone", name: "Someone" }; });
    app.writeBlob(forged.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, forged)])));
    await library.settled();
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 422, code: "invalid_package" });
    expect(app.store.bots).toHaveLength(0);
    expect(app.posted.at(-1).packages[0]).toMatchObject({ state: "failed", reason: "invalid_package" });
  });
});

describe("adding from the shelf on a Starter Cloud", () => {
  it("answers 409 at the limit, adds nothing, reports no broken package, and adds it once there is room", async () => {
    const app = await installation();
    for (let i = 0; i < 5; i++) app.store.createBot({ name: `Bot ${i}` });
    const { createBotLimit } = await import("./host/starter-bot-limit.ts");
    let starter = true;
    const deps = { ...app.importDeps, botLimit: createBotLimit({ starter: () => starter, bots: () => app.store.bots }) };
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const before = app.store.bots.length;
    app.posted.length = 0;

    expect(library.add(TEAM_ID, deps)).toMatchObject({ ok: false, status: 409, code: "bot_limit", error: expect.stringContaining("upgrade this Cloud") });
    await library.settled();
    expect(app.store.bots).toHaveLength(before);
    expect(app.posted.flatMap((report: { packages: Array<{ state: string }> }) => report.packages).filter((row) => row.state === "failed")).toEqual([]);
    expect(app.readState().adding ?? {}).toEqual({});

    starter = false;
    const added = library.add(TEAM_ID, deps);
    expect(added).toMatchObject({ ok: true, status: 201 });
    expect(app.store.bots.length).toBe(before + 3);
  });
});

describe("the relay", () => {
  it("acknowledges before any work, then reconciles and reports", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    const started = Date.now();
    const body = catalog([entry(TEAM_ID, team)]);
    expect(library.applyRelay(relay(body))).toEqual({ ok: true });
    expect(app.posted).toEqual([]);
    expect(existsSync(app.statePath)).toBe(false);
    await library.settled();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(app.posted).toEqual([{ type: "openmausbot:managed-library-state", digest: sha(JSON.stringify(body)), packages: [] }]);
    expect(app.readState()).toMatchObject({ version: 1, source: { adminOrigin: ADMIN, organizationId: ORG }, appliedDigest: sha(JSON.stringify(body)), installs: {} });
  });
});

describe("adding from the shelf", () => {
  it("adds a team with skills on, routines paused, and every record stamped", async () => {
    const app = await installation();
    app.store.createBot({ name: "Scout" });
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    expect(library.list().packages[0]).toMatchObject({ blob: "ready", installed: null });

    const outcome = library.add(TEAM_ID, app.importDeps);
    if (!outcome.ok || outcome.value.alreadyAdded) throw new Error(JSON.stringify(outcome));
    expect(outcome.status).toBe(201);
    const result = outcome.value.result;
    const installId = createHash("sha256").update(`omb-install:v1\n${ADMIN}\n${ORG}\n${TEAM_ID}`).digest("hex").slice(0, 32);
    expect(result.installId).toBe(installId);
    const byKey = new Map(result.bots.map((bot) => [bot.installedPackage!.agentKey, app.store.bot(bot.id)!]));
    const scout = byKey.get("scout")!;
    expect(scout.name).toBe("Scout 2");
    for (const bot of byKey.values()) {
      expect(bot.installedPackage).toMatchObject({
        source: "org", installId, agentKey: expect.any(String), ref: "acme/sales-desk", sha256: team.sha256, release: "1.3.0",
        publisher: { organizationId: PUBLISHER, slug: "acme", name: "Acme Partners" },
      });
      expect(Object.keys(bot.packageBase!).sort()).toEqual([...app.parts.AGENT_PARTS].sort());
      for (const value of Object.values(bot.packageBase!)) expect(value).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
      expect(bot.packageBase!.approval!.w).toBe(app.parts.partHash("ask"));
      expect(bot).not.toHaveProperty("approvalMode");
    }
    expect(scout.packageBase!.name).toEqual({ r: app.parts.partHash("Scout"), w: app.parts.partHash("Scout 2") });
    const lead = byKey.get("lead")!;
    for (const part of ["name", "title", "description", "soul", "look", "playbooks", "skills"] as const) {
      expect(lead.packageBase![part]!.w, part).toBe(lead.packageBase![part]!.r);
    }
    expect(byKey.get("lead")!.packageBase!.approval!.r).toBe(app.parts.partHash("auto"));

    expect(app.skills.listSkills(scout.id)).toEqual([
      expect.objectContaining({ name: "pricing-policy", enabled: true, source: "org:acme/sales-desk@1.3.0" }),
      expect.objectContaining({ name: "research-brief", enabled: true, source: "org:acme/sales-desk@1.3.0" }),
    ]);
    expect(app.skills.listSkills(scout.id)[0]).not.toHaveProperty("package");
    expect(app.skills.skillPackageStamps(scout.id)).toContainEqual({ name: "pricing-policy", enabled: true,
      stamp: { installId, key: "pricing-policy", release: "1.3.0", r: expect.stringMatching(hex), w: expect.stringMatching(hex) } });

    expect(result.routines).toHaveLength(2);
    expect(app.routines.listRoutines().every((routine) => !routine.enabled && !("installedPackage" in routine))).toBe(true);
    const stamps = app.routines.packageStamps();
    expect(stamps.map((routine) => routine.stamp.key).sort()).toEqual(["daily-digest", "weekly-review"]);
    for (const routine of stamps) {
      expect(routine.stamp.installId).toBe(installId);
      for (const part of app.parts.ROUTINE_PARTS) expect(routine.stamp.parts[part]).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
      for (const part of ["name", "prompt", "schedule"] as const) expect(routine.stamp.parts[part].w, part).toBe(routine.stamp.parts[part].r);
    }

    const room = app.store.group(result.groups[0]!.id)!;
    expect(room.installedPackage).toMatchObject({ installId, key: "desk", memberKeys: ["lead", "scout", "writer"] });
    for (const part of app.parts.ROOM_PARTS) expect(room.installedPackage!.parts[part]).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
    for (const part of ["name", "bulletin"] as const) expect(room.installedPackage!.parts[part].w, part).toBe(room.installedPackage!.parts[part].r);

    const install = app.readState().installs[installId];
    expect(install).toMatchObject({
      packageId: TEAM_ID, ref: "acme/sales-desk", release: "1.3.0", sha256: team.sha256, status: "installed", kind: "team",
      section: "Sales desk", bots: { lead: byKey.get("lead")!.id, scout: scout.id, writer: byKey.get("writer")!.id },
      rooms: { desk: room.id }, removedLocally: [],
      connections: { crm: { name: "crm", r: expect.stringMatching(hex), w: expect.stringMatching(hex) } },
    });
    for (const part of app.parts.TEAM_PARTS) expect(install.team.parts[part]).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
    for (const part of ["name", "brief"] as const) expect(install.team.parts[part].w, part).toBe(install.team.parts[part].r);
    expect(install.connections.crm.w).toBe(install.connections.crm.r);
    const [preset] = app.importDeps.presets.list();
    expect(preset).toMatchObject({ source: "org", installId, key: "support", ref: "acme/sales-desk", sha256: team.sha256 });
    expect(install.presets).toEqual({ support: { presetId: preset!.id, r: app.parts.partHash(team.document.package.presets[0]) } });
    expect(library.list().packages[0]!.installed).toEqual({ installId, release: "1.3.0", status: "installed" });
    expect(app.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "installed" }]);
  });

  it("adds once: a second Add, a lost state.json and a reconnect all find the same install", async () => {
    const app = await installation();
    let library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    const body = catalog([entry(TEAM_ID, team)]);
    library.applyRelay(relay(body));
    await library.settled();
    const first = library.add(TEAM_ID, app.importDeps);
    expect(first).toMatchObject({ ok: true, status: 201 });
    const bots = app.store.bots.length;
    const installId = (first as any).value.result.installId;
    expect(library.add(TEAM_ID, app.importDeps)).toEqual({ ok: true, status: 200, value: { alreadyAdded: true, installId } });
    expect(app.store.bots).toHaveLength(bots);
    const presets = app.readState().installs[installId].presets;
    expect(Object.keys(presets)).toEqual(["support"]);

    library.dispose();
    unlinkSync(app.statePath);
    library = app.open();
    library.applyRelay(relay(body));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ packageId: TEAM_ID, status: "installed", section: "Sales desk", presets });
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 200, value: { alreadyAdded: true } });
    expect(app.store.bots).toHaveLength(bots);
    expect(app.store.groups).toHaveLength(1);

    library.applyRelay(null);
    expect(library.list()).toEqual({ organization: null, packages: [] });
    expect(app.store.bots).toHaveLength(bots);
    library.applyRelay(relay(body));
    await library.settled();
    expect(library.list().packages[0]!.installed).toMatchObject({ installId, status: "installed" });
  });

  it("switches off a withdrawn release's skills, pauses its routines, and reports it once", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const scout = added.value.result.bots.find((bot: any) => bot.installedPackage.agentKey === "scout");
    const daily = app.routines.packageStamps().find((routine) => routine.stamp.key === "daily-digest")!;
    app.routines.update(daily.routineId, { enabled: true });

    const withdrawn = entry(TEAM_ID, team, { release: null, withdrawnReleases: [{ version: "1.3.0", sha256: team.sha256 }] });
    library.applyRelay(relay(catalog([withdrawn])));
    await library.settled();
    expect(app.skills.listSkills(scout.id).every((skill) => !skill.enabled)).toBe(true);
    expect(app.routines.listRoutines().every((routine) => !routine.enabled)).toBe(true);
    const installId = added.value.result.installId;
    expect(app.readState().installs[installId].status).toBe("withdrawn");
    expect(app.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "withdrawn", reason: "withdrawn_by_publisher" },
    ]);
    expect(library.list().packages[0]!.installed).toMatchObject({ status: "withdrawn" });

    app.skills.setSkillEnabled(scout.id, "research-brief", true);
    library.applyRelay(relay(catalog([withdrawn], { libraryVersion: 4 })));
    await library.settled();
    expect(app.skills.listSkills(scout.id).find((skill) => skill.name === "research-brief")!.enabled).toBe(true);
    library.applyRelay(relay(catalog([], { libraryVersion: 5 })));
    await library.settled();
    expect(app.store.bots).toHaveLength(3);
  });

  it("marks an install removed once the person deletes its last record", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    const [first, ...rest] = added.value.result.bots;
    app.store.deleteBot(first.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[added.value.result.installId].status).toBe("installed");
    for (const bot of rest) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[added.value.result.installId].status).toBe("removed");
    expect(app.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "removed", reason: "removed_locally" },
    ]);
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 201 });
  });

  it("marks a team removed when only an offered skill it gave another bot is left", async () => {
    const app = await installation();
    const own = app.store.createBot({ name: "Helper" });
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const installId = added.value.result.installId;
    expect(library.addOfferedSkill(own.id, installId, "objection-handling")).toMatchObject({ ok: true, status: 201 });

    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const bot of added.value.result.bots) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ status: "removed", bots: {}, rooms: {}, routines: {} });
    expect(library.list().packages[0]!.installed).toMatchObject({ status: "removed" });
    expect(app.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "removed", reason: "removed_locally" },
    ]);
    expect(app.skills.listSkills(own.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true })]);
    const again = library.add(TEAM_ID, app.importDeps) as any;
    expect(again).toMatchObject({ ok: true, status: 201 });
    expect(again.value.result.bots).toHaveLength(3);
    expect(app.readState().installs[installId]).toMatchObject({ status: "installed" });
  });

  it("switches off an offered skill a removed team left behind when its release is withdrawn, once", async () => {
    const app = await installation();
    const own = app.store.createBot({ name: "Helper" });
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const installId = added.value.result.installId;
    library.addOfferedSkill(own.id, installId, "objection-handling");
    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const bot of added.value.result.bots) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("removed");

    const withdrawn = entry(TEAM_ID, team, { release: null, withdrawnReleases: [{ version: "1.3.0", sha256: team.sha256 }] });
    library.applyRelay(relay(catalog([withdrawn])));
    await library.settled();
    expect(app.skills.listSkills(own.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: false })]);
    expect(app.readState().installs[installId]).toMatchObject({ status: "removed", withdrawnHandled: team.sha256 });
    expect(app.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "removed", reason: "removed_locally" },
    ]);
    app.skills.setSkillEnabled(own.id, "objection-handling", true);
    library.applyRelay(relay(catalog([withdrawn], { libraryVersion: 4 })));
    await library.settled();
    expect(app.skills.listSkills(own.id)[0]!.enabled).toBe(true);
  });

  it("removes a team the app stopped adding halfway, so it can be added again whole", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    const body = catalog([entry(TEAM_ID, team)]);
    library.applyRelay(relay(body));
    await library.settled();
    // The app stops as the first routine is about to be written: bots, group chat and brief are on disk.
    let crash: string | null = null;
    const deps = {
      ...app.importDeps,
      routines: {
        create: (input: any) => {
          crash ??= snapshot();
          return app.routines.create(input);
        },
        remove: (id: string) => app.routines.remove(id),
        stampInstalledPackage: (id: string, stamp: any) => app.routines.stampInstalledPackage(id, stamp),
      },
    };
    const installId = (library.add(TEAM_ID, deps) as any).value.result.installId;
    library.dispose();

    const crashed = await installation(crash!);
    expect(crashed.store.bots).toHaveLength(3);
    expect(crashed.store.groups).toHaveLength(1);
    expect(crashed.readState().adding[installId]).toMatchObject({ packageId: TEAM_ID, release: "1.3.0",
      expect: { bots: ["lead", "scout", "writer"], rooms: ["desk"], routines: ["daily-digest", "weekly-review"], leader: "lead" } });
    expect(crashed.readState().installs).toEqual({});

    const restarted = crashed.open();
    expect(crashed.store.bots).toEqual([]);
    expect(crashed.store.groups).toEqual([]);
    expect(crashed.routines.listRoutines()).toEqual([]);
    expect(crashed.store.sections).not.toContain("Sales desk");
    expect(crashed.sections.readSectionContext("Sales desk")).toBeNull();
    expect(crashed.readState()).toMatchObject({ installs: {}, adding: {} });
    restarted.applyRelay(relay(body));
    await restarted.settled();
    expect(crashed.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "failed", reason: "import_failed" },
    ]);
    expect(restarted.list().packages[0]!.installed).toBeNull();

    const again = restarted.add(TEAM_ID, crashed.importDeps) as any;
    expect(again).toMatchObject({ ok: true, status: 201, value: { result: { section: "Sales desk" } } });
    expect(crashed.store.bots).toHaveLength(3);
    expect(crashed.store.groups).toHaveLength(1);
    expect(crashed.routines.listRoutines()).toHaveLength(2);
    expect(crashed.store.bots.find((bot) => bot.installedPackage?.agentKey === "lead")!.chiefOfStaff).toBe(true);
    expect(crashed.sections.readSectionContext("Sales desk")!.text).toContain("49 per seat");
    expect(crashed.readState()).toMatchObject({ installs: { [installId]: { status: "installed" } }, adding: {} });
    expect(crashed.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "installed" }]);
    restarted.dispose();
  });

  it("removes a team the app stopped adding just before its leader was set", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    // Every bot, group chat and routine is written; the leader, the importer's last write, is not.
    let crash: string | null = null;
    let stamped = 0;
    const deps = {
      ...app.importDeps,
      routines: {
        create: (input: any) => app.routines.create(input),
        remove: (id: string) => app.routines.remove(id),
        stampInstalledPackage: (id: string, stamp: any) => {
          const done = app.routines.stampInstalledPackage(id, stamp);
          if (++stamped === 2) crash = snapshot();
          return done;
        },
      },
    };
    library.add(TEAM_ID, deps);
    library.dispose();

    const crashed = await installation(crash!);
    expect(crashed.routines.listRoutines()).toHaveLength(2);
    expect(crashed.store.bots.some((bot) => bot.chiefOfStaff)).toBe(false);
    crashed.open().dispose();
    expect(crashed.store.bots).toEqual([]);
    expect(crashed.store.groups).toEqual([]);
    expect(crashed.routines.listRoutines()).toEqual([]);
    expect(crashed.readState()).toMatchObject({ installs: {}, adding: {} });
  });

  it("keeps a team the app stopped adding only after its last record", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    const body = catalog([entry(TEAM_ID, team)]);
    library.applyRelay(relay(body));
    await library.settled();
    // The app stops right after the leader, the importer's last write, before the index is saved.
    let crash: string | null = null;
    const setChief = app.store.setChiefOfStaff.bind(app.store);
    vi.spyOn(app.store, "setChiefOfStaff").mockImplementation((...args) => {
      const changed = setChief(...args);
      crash ??= snapshot();
      return changed;
    });
    const installId = (library.add(TEAM_ID, app.importDeps) as any).value.result.installId;
    library.dispose();

    const crashed = await installation(crash!);
    expect(crashed.readState().adding[installId]).toBeDefined();
    const restarted = crashed.open();
    expect(crashed.store.bots).toHaveLength(3);
    expect(crashed.store.groups).toHaveLength(1);
    expect(crashed.routines.listRoutines()).toHaveLength(2);
    expect(crashed.readState()).toMatchObject({
      adding: {},
      installs: { [installId]: { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, status: "installed", kind: "team", section: "Sales desk" } },
    });
    expect(Object.keys(crashed.readState().installs[installId].bots).sort()).toEqual(["lead", "scout", "writer"]);
    expect(crashed.sections.readSectionContext("Sales desk")!.text).toContain("49 per seat");
    restarted.applyRelay(relay(body));
    await restarted.settled();
    expect(crashed.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "installed" }]);
    expect(restarted.add(TEAM_ID, crashed.importDeps)).toMatchObject({ ok: true, status: 200, value: { alreadyAdded: true } });
    expect(crashed.store.bots).toHaveLength(3);
    restarted.dispose();
  });

  it("registers a library package and offers its skills under Bot → Skills", async () => {
    const app = await installation();
    const bot = app.store.createBot({ name: "Helper" });
    const library = app.open();
    const skills = release("library-only.v2.json");
    app.writeBlob(skills.bytes);
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills)])));
    await library.settled();
    const outcome = library.add(LIBRARY_ID, app.importDeps) as any;
    expect(outcome).toMatchObject({ ok: true, status: 201 });
    expect(outcome.value.result.offeredSkills).toEqual(["objection-handling", "follow-up"]);
    expect(app.store.bots).toHaveLength(1);
    const installId = outcome.value.result.installId;
    expect(app.readState().installs[installId]).toMatchObject({ kind: "library", status: "installed", bots: {} });
    expect(library.add(LIBRARY_ID, app.importDeps)).toEqual({ ok: true, status: 200, value: { alreadyAdded: true, installId } });

    expect(library.offeredSkills(bot.id)).toEqual({
      organization: { id: ORG, name: "Customer Co" },
      skills: [
        expect.objectContaining({ installId, name: "objection-handling", publisher: "Acme Partners", packageName: "Sales skills", added: false }),
        expect.objectContaining({ installId, name: "follow-up", added: false }),
      ],
    });
    const added = library.addOfferedSkill(bot.id, installId, "follow-up");
    expect(added).toMatchObject({ ok: true, status: 201, value: { name: "follow-up", enabled: true, source: "org:acme/sales-skills@2.0.1" } });
    expect(library.addOfferedSkill(bot.id, installId, "follow-up")).toMatchObject({ ok: false, status: 409, code: "skill_exists" });
    expect(library.addOfferedSkill(bot.id, installId, "not-offered")).toMatchObject({ ok: false, status: 404 });
    expect(library.offeredSkills(bot.id).skills.find((skill) => skill.name === "follow-up")!.added).toBe(true);
    app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("installed");

    const other = app.store.createBot({ name: "Other" });
    library.addOfferedSkill(other.id, installId, "objection-handling");
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills, { release: null, withdrawnReleases: [{ version: "2.0.1", sha256: skills.sha256 }] })])));
    await library.settled();
    expect(app.skills.listSkills(other.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: false })]);
    expect(library.offeredSkills(other.id).skills).toEqual([]);
  });

  it("adopts a skills-only package as a skills-only package after a lost state.json", async () => {
    const app = await installation();
    const bot = app.store.createBot({ name: "Helper" });
    let library = app.open();
    const skills = release("library-only.v2.json");
    app.writeBlob(skills.bytes);
    const body = catalog([entry(LIBRARY_ID, skills)]);
    library.applyRelay(relay(body));
    await library.settled();
    const installId = (library.add(LIBRARY_ID, app.importDeps) as any).value.result.installId;
    library.addOfferedSkill(bot.id, installId, "follow-up");
    library.dispose();
    unlinkSync(app.statePath);

    library = app.open();
    library.applyRelay(relay(body));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ kind: "library", status: "installed", bots: {} });
    app.store.deleteBot(app.store.createBot({ name: "Passing" }).id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ kind: "library", status: "installed" });
    expect(library.offeredSkills(bot.id).skills.find((skill) => skill.name === "follow-up")).toMatchObject({ added: true });
  });
});

describe("parts the person deleted (removedLocally)", () => {
  async function addedTeam() {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    const body = catalog([entry(TEAM_ID, team)]);
    library.applyRelay(relay(body));
    await library.settled();
    const installId: string = (library.add(TEAM_ID, app.importDeps) as any).value.result.installId;
    const bot = (key: string) => app.store.bots.find((candidate) => candidate.installedPackage?.agentKey === key)!;
    const install = () => app.readState().installs[installId];
    return { app, library, team, body, installId, bot, install };
  }
  const afterStoreChange = async (library: { settled(): Promise<void> }) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
  };

  it("notes a deleted bot and keeps the team added", async () => {
    const { app, library, team, bot, install } = await addedTeam();
    app.store.deleteBot(bot("writer").id);
    await afterStoreChange(library);
    expect(install()).toMatchObject({ status: "installed", removedLocally: ["agent:writer"] });
    expect(Object.keys(install().bots).sort()).toEqual(["lead", "scout"]);
    expect(app.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "installed" }]);
    app.store.deleteBot(bot("scout").id);
    await afterStoreChange(library);
    expect(install()).toMatchObject({ status: "installed", removedLocally: ["agent:writer", "agent:scout", "routine:daily-digest"] });
  });

  it("notes a deleted group chat and a deleted routine", async () => {
    const { app, library, body, install } = await addedTeam();
    app.store.deleteGroup(app.store.groups[0]!.id);
    await afterStoreChange(library);
    expect(install()).toMatchObject({ status: "installed", removedLocally: ["room:desk"] });
    expect(install().rooms).toEqual({});
    // Deleting a routine is not a store change; the next relayed catalog's rebuild notes it.
    app.routines.remove(app.routines.packageStamps().find((routine) => routine.stamp.key === "weekly-review")!.routineId);
    library.applyRelay(relay(body));
    await library.settled();
    expect(install()).toMatchObject({ status: "installed", removedLocally: ["room:desk", "routine:weekly-review"] });
    expect(Object.keys(install().routines)).toEqual(["daily-digest"]);
  });

  it("notes each part once, however often the index is rebuilt", async () => {
    const { app, library, body, bot, install } = await addedTeam();
    app.store.deleteBot(bot("writer").id);
    await afterStoreChange(library);
    const saved = readFileSync(app.statePath, "utf8");
    for (const libraryVersion of [4, 5]) {
      library.applyRelay(relay(catalog(body.packages, { libraryVersion })));
      await library.settled();
    }
    expect(library.rebuild()).toBe(false);
    expect(install().removedLocally).toEqual(["agent:writer"]);
    expect(JSON.parse(readFileSync(app.statePath, "utf8")).installs).toEqual(JSON.parse(saved).installs);
  });

  it("keeps the list across a restart, and notes what went while the app was closed", async () => {
    const { app, library, bot, install, installId } = await addedTeam();
    app.store.deleteBot(bot("writer").id);
    await afterStoreChange(library);
    library.dispose();
    const before = readFileSync(app.statePath, "utf8");
    app.open().dispose();
    expect(readFileSync(app.statePath, "utf8")).toBe(before);
    expect(install().removedLocally).toEqual(["agent:writer"]);

    // Deleted with no library listening (the app stopped before its debounced rebuild).
    const state = app.readState();
    state.installs[installId].removedLocally.push("agent:scout");
    writeFileSync(app.statePath, JSON.stringify(state));
    app.store.deleteBot(bot("scout").id);
    app.open().dispose();
    expect(install()).toMatchObject({ status: "installed", removedLocally: ["agent:writer", "agent:scout", "routine:daily-digest"] });
  });

  it("notes every part of a team deleted at once, and a new Add starts the list again", async () => {
    const { app, library, install } = await addedTeam();
    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const id of app.store.bots.map((candidate) => candidate.id)) app.store.deleteBot(id);
    await afterStoreChange(library);
    expect(install()).toMatchObject({ status: "removed", bots: {}, rooms: {}, routines: {} });
    expect([...install().removedLocally].sort()).toEqual([
      "agent:lead", "agent:scout", "agent:writer", "room:desk", "routine:daily-digest", "routine:weekly-review",
    ]);
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 201 });
    expect(install()).toMatchObject({ status: "installed", removedLocally: [] });
  });

  it("drops a part from the list when it exists again", async () => {
    const { app, library, body, bot, install } = await addedTeam();
    const stamp = structuredClone(bot("writer").installedPackage!);
    app.store.deleteBot(bot("writer").id);
    await afterStoreChange(library);
    expect(install().removedLocally).toEqual(["agent:writer"]);
    const restored = app.store.createBot({ name: "Writer" });
    app.store.patchBot(restored.id, { installedPackage: stamp });
    library.applyRelay(relay(body));
    await library.settled();
    expect(install()).toMatchObject({ status: "installed", removedLocally: [], bots: { writer: restored.id } });
  });
});

describe("with no organization", () => {
  it("shows nothing, reads nothing, writes nothing and reports nothing", async () => {
    const app = await installation();
    app.store.createBot({ name: "Solo" });
    const library = app.open();
    expect(library.list()).toEqual({ organization: null, packages: [] });
    expect(library.offeredSkills()).toEqual({ organization: null, skills: [] });
    expect(library.installStatuses()).toEqual(new Map());
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.posted).toEqual([]);
    expect(existsSync(join(app.DATA_DIR, "org-library"))).toBe(false);
    expect(app.stamps).not.toHaveBeenCalled();
  });
});

describe("presets from the shelf", () => {
  it("adds a removed team again although a bot was made from its preset, without duplicating the preset", async () => {
    const app = await installation();
    const presets = await import("./presets.ts");
    const library = app.open();
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const installId = added.value.result.installId;
    const [row] = app.importDeps.presets.list();
    const made = app.store.createBot({ name: "Sky" });
    presets.applyPresetToBot(made.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    expect(app.store.bot(made.id)!.installedPackage).toMatchObject({ source: "org", installId, presetKey: "support" });
    const released = team.document.package.skills.entries.find((skill: { name: string }) => skill.name === "objection-handling").instructions;
    expect(app.skills.skillPackageStamps(made.id)).toEqual([{ name: "objection-handling", enabled: true, stamp: {
      installId, key: "objection-handling", release: "1.3.0", r: app.parts.partHash(released),
      w: app.parts.partHash(app.skills.readSkillFile(made.id, "objection-handling")), via: "preset",
    } }]);

    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const bot of added.value.result.bots) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("removed");

    const again = library.add(TEAM_ID, app.importDeps) as any;
    expect(again).toMatchObject({ ok: true, status: 201 });
    expect(again.value.result.bots).toHaveLength(3);
    expect(app.store.bot(made.id)).toBeTruthy();
    expect(app.importDeps.presets.list()).toEqual([expect.objectContaining({ id: row!.id, installId, key: "support" })]);
    expect(app.readState().installs[installId]).toMatchObject({ status: "installed", presets: { support: { presetId: row!.id } } });
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 200, value: { alreadyAdded: true } });
    expect(app.skills.skillPackageStamps(made.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true })]);
  });

  it("never adopts an install from a preset-made bot's stamped skill: a lost index comes back at the release that was added", async () => {
    const app = await installation();
    const presets = await import("./presets.ts");
    let library = app.open();
    const skills = release("library-only.v2.json");
    app.writeBlob(skills.bytes);
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills)])));
    await library.settled();
    const installId = (library.add(LIBRARY_ID, app.importDeps) as any).value.result.installId;
    const indexed = app.readState().installs[installId];
    const [row] = app.importDeps.presets.list();
    const made = app.store.createBot({ name: "Sky" });
    presets.applyPresetToBot(made.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    expect(app.skills.skillPackageStamps(made.id)).toEqual([expect.objectContaining({ stamp: expect.objectContaining({ installId, release: "2.0.1", via: "preset" }) })]);

    library.dispose();
    unlinkSync(app.statePath);
    const newer = release("library-only.v2.json", (document) => { document.package.release = "2.1.0"; });
    app.writeBlob(newer.bytes);
    library = app.open();
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, newer)])));
    await library.settled();
    expect(app.readState().installs[installId]).toEqual({ ...indexed, addedAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(library.lastReport()!.packages).toEqual([expect.objectContaining({ packageId: LIBRARY_ID, release: "2.0.1", sha256: skills.sha256, state: "installed" })]);
  });

  it("New bot follows the library's own install statuses, saved or not, and never its file", async () => {
    const app = await installation();
    const { createBotPresetRoutes } = await import("./routes/bot-presets.ts");
    const library = app.open();
    const route = createBotPresetRoutes({ presets: app.importDeps.presets, orgStatuses: () => library.installStatuses() });
    const offered = async () => {
      let answer: { status: number; body: any } | undefined;
      const json = (_res: unknown, status: number, body: unknown) => { answer = { status, body }; };
      await route({ path: "/api/bot-presets", method: "GET", res: {}, json } as any);
      expect(answer!.status).toBe(200);
      return answer!.body.presets.map((preset: { source: string; key: string }) => `${preset.source}:${preset.key}`);
    };
    const team = release("full-team.v2.json");
    app.writeBlob(team.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, team)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const installId = added.value.result.installId;
    expect(library.installStatuses()).toEqual(new Map([[installId, "installed"]]));
    expect(await offered()).toEqual(["org:support"]);
    const installedOnDisk = readFileSync(app.statePath, "utf8");

    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const bot of added.value.result.bots) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    const removedOnDisk = readFileSync(app.statePath, "utf8");
    writeFileSync(app.statePath, installedOnDisk);
    expect(library.installStatuses()).toEqual(new Map([[installId, "removed"]]));
    expect(await offered()).toEqual([]);

    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 201 });
    writeFileSync(app.statePath, removedOnDisk);
    expect(await offered()).toEqual(["org:support"]);
    unlinkSync(app.statePath);
    expect(await offered()).toEqual(["org:support"]);

    library.applyRelay(null);
    expect(library.installStatuses()).toEqual(new Map([[installId, "installed"]]));
    expect(await offered()).toEqual(["org:support"]);
  });

  it("adopts a presets package from its preset rows after its index is lost, and a withdrawal still reaches bots made from it", async () => {
    const app = await installation();
    const presets = await import("./presets.ts");
    let library = app.open();
    const skills = release("library-only.v2.json");
    app.writeBlob(skills.bytes);
    const body = catalog([entry(LIBRARY_ID, skills)]);
    library.applyRelay(relay(body));
    await library.settled();
    const outcome = library.add(LIBRARY_ID, app.importDeps) as any;
    expect(outcome).toMatchObject({ ok: true, status: 201 });
    const installId = outcome.value.result.installId;
    const indexed = app.readState().installs[installId];
    const [row] = app.importDeps.presets.list();
    expect(indexed.presets).toEqual({ support: { presetId: row!.id, r: app.parts.partHash(skills.document.package.presets[0]) } });
    const made = app.store.createBot({ name: "Sky" });
    presets.applyPresetToBot(made.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    expect(app.skills.listSkills(made.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true, source: "org:acme/sales-skills@2.0.1" })]);
    const mine = app.store.createBot({ name: "Mine" });
    presets.applyPresetToBot(mine.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    app.skills.removeSkill(mine.id, "objection-handling");
    app.skills.installSkill(mine.id, "https://example.com/mine", [{ path: "SKILL.md", content: "---\nname: objection-handling\ndescription: Mine.\n---\n\nMine.\n" }]);
    app.skills.setSkillEnabled(mine.id, "objection-handling", true);

    library.dispose();
    writeFileSync(app.statePath, "{not json");
    library = app.open();
    library.applyRelay(relay(body));
    await library.settled();
    expect(app.readState().installs[installId]).toEqual({ ...indexed, addedAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(library.add(LIBRARY_ID, app.importDeps)).toEqual({ ok: true, status: 200, value: { alreadyAdded: true, installId } });
    expect(app.importDeps.presets.list()).toHaveLength(1);
    expect(library.offeredSkills().skills.map((skill) => skill.name)).toEqual(["objection-handling", "follow-up"]);

    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills, { release: null, withdrawnReleases: [{ version: "2.0.1", sha256: skills.sha256 }] })])));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("withdrawn");
    expect(library.installStatuses().get(installId)).toBe("withdrawn");
    expect(presets.listBotPresets(app.importDeps.presets, library.installStatuses())).toEqual([]);
    expect(app.skills.listSkills(made.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: false })]);
    expect(app.skills.listSkills(mine.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true, source: "https://example.com/mine" })]);
    app.skills.setSkillEnabled(made.id, "objection-handling", true);
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills, { release: null, withdrawnReleases: [{ version: "2.0.1", sha256: skills.sha256 }] })], { libraryVersion: 4 })));
    await library.settled();
    expect(app.skills.listSkills(made.id)[0]!.enabled).toBe(true);
  });
});

describe("a newer release of an added team", () => {
  const NEXT = (document: any) => {
    const pkg = document.package;
    pkg.release = "1.4.0";
    const lead = pkg.agents.find((agent: any) => agent.key === "lead");
    lead.soul = "You run the desk. Quote the 2027 price list.";
    lead.title = "Desk lead";
    pkg.playbooks[0].instructions = `${pkg.playbooks[0].instructions} Then confirm the seat count.`;
    pkg.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += "\nSeats are 59 from January.";
    pkg.rooms[0].bulletin = "Cite sources. Lead answers first.";
    pkg.routines.find((routine: any) => routine.key === "daily-digest").prompt = "Summarise yesterday's deals, biggest first.";
    pkg.team.brief = "We sell a team plan at 59 per seat.";
  };

  async function addedTeam(over: Parameters<Awaited<ReturnType<typeof installation>>["open"]>[0] = {}, initial?: ReturnType<typeof release>) {
    const app = await installation();
    const library = app.open(over);
    const first = initial ?? release("full-team.v2.json");
    app.writeBlob(first.bytes);
    library.applyRelay(relay(catalog([entry(TEAM_ID, first)])));
    await library.settled();
    const added = library.add(TEAM_ID, app.importDeps) as any;
    const botOf = (key: string) => app.store.bots.find((bot) => bot.installedPackage?.agentKey === key)!;
    const routineOf = (key: string) => app.routines.packageStamps().find((routine) => routine.stamp.key === key)!;
    const update = async (next = release("full-team.v2.json", NEXT), patch: Record<string, unknown> = {}, write = true) => {
      if (write) app.writeBlob(next.bytes);
      library.applyRelay(relay(catalog([entry(TEAM_ID, next, patch)], { libraryVersion: 4 })));
      await library.settled();
      return next;
    };
    return { app, library, first, installId: added.value.result.installId as string, botOf, routineOf, update };
  }

  it("waits for an active task before updating and retries without another catalog", async () => {
    const { app, library, botOf, update, installId } = await addedTeam();
    const lead = botOf("lead");
    const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
    const task = ensureTaskWorkspaceWithSkills(lead.id, "active-task");
    const taskSkill = join(task, ".claude", "skills", "pricing-policy", "SKILL.md");
    const previous = readFileSync(taskSkill, "utf8");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    app.setSkillInUse(true);
    await update();
    expect(readFileSync(taskSkill, "utf8")).toBe(previous);
    expect(existsSync(oldDirectory)).toBe(true);
    expect(app.readState().installs[installId].release).toBe("1.3.0");
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toHaveProperty("error");
    app.setSkillInUse(false);
    await vi.waitFor(() => expect(app.readState().installs[installId].release).toBe("1.4.0"));
    await library.settled();
    // The old link remains usable even after the turn; a later turn refreshes it before dispatch.
    expect(readFileSync(taskSkill, "utf8")).toBe(previous);
    expect(existsSync(oldDirectory)).toBe(true);
    ensureTaskWorkspaceWithSkills(lead.id, "active-task");
    expect(readFileSync(taskSkill, "utf8")).toContain("Seats are 59 from January.");
    await vi.waitFor(() => expect(existsSync(oldDirectory)).toBe(false));
  });

  it("can apply another release while an old task link pins a previous revision", async () => {
    const { app, botOf, update, installId } = await addedTeam();
    const lead = botOf("lead");
    const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
    const task = ensureTaskWorkspaceWithSkills(lead.id, "old-task");
    const taskSkill = join(task, ".claude", "skills", "pricing-policy", "SKILL.md");
    const previous = readFileSync(taskSkill, "utf8"), oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    await update();
    const next = release("full-team.v2.json", (doc) => {
      NEXT(doc); doc.package.release = "1.5.0";
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += "\nSecond revision.";
    });
    await update(next);
    expect(app.readState().installs[installId].release).toBe("1.5.0");
    expect(readFileSync(taskSkill, "utf8")).toBe(previous);
    expect(existsSync(oldDirectory)).toBe(true);
    ensureTaskWorkspaceWithSkills(lead.id, "old-task");
    expect(readFileSync(taskSkill, "utf8")).toContain("Second revision.");
    await vi.waitFor(() => expect(existsSync(oldDirectory)).toBe(false));
  });

  it("refuses a new revision when the retained-revision cap is reached", async () => {
    const { app, botOf, update, installId } = await addedTeam();
    const lead = botOf("lead");
    const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
    const task = ensureTaskWorkspaceWithSkills(lead.id, "pinned-task");
    const taskSkill = join(task, ".claude", "skills", "pricing-policy", "SKILL.md");
    const original = readFileSync(taskSkill, "utf8");
    await update();
    const manifest = app.skills.orgSkillStorage.readManifest(lead.id), skill = manifest["pricing-policy"]!;
    const held = skill.pendingRetirements![0]!;
    skill.pendingRetirements = Array.from({ length: 32 }, () => ({ ...held }));
    app.skills.orgSkillStorage.writeManifest(lead.id, manifest);
    await update(release("full-team.v2.json", (doc) => {
      NEXT(doc); doc.package.release = "1.5.0";
      doc.package.skills.entries.find((entry: any) => entry.name === "pricing-policy").instructions += "\nAnother revision.";
    }));
    expect(app.readState().installs[installId].release).toBe("1.4.0");
    expect(app.skills.skillPackageStamps(lead.id).find((entry) => entry.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
    expect(readFileSync(taskSkill, "utf8")).toBe(original);
  });

  it("retries a failed native link switch even after the skill stamp was written", async () => {
    const { app, library, botOf, update, installId } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const link = join(app.DATA_DIR, "workspaces", lead.id, ".claude", "skills", "pricing-policy");
    rmSync(link); mkdirSync(link); writeFileSync(join(link, "keep.txt"), "user data");
    await update();
    expect(app.skills.skillPackageStamps(lead.id).find((skill) => skill.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
    expect(app.readState().installs[installId].release).toBe("1.3.0");
    expect(existsSync(oldDirectory)).toBe(true);
    expect(readFileSync(join(link, "keep.txt"), "utf8")).toBe("user data");
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toHaveProperty("error");
    // The owner removes the obstacle; no catalog or new release is relayed.
    rmSync(link, { recursive: true });
    await vi.waitFor(() => expect(app.readState().installs[installId].release).toBe("1.4.0"));
    await library.settled();
    expect(existsSync(oldDirectory)).toBe(false);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("Seats are 59 from January.");
  });

  it("recovers an interrupted link switch after restart without a new catalog", async () => {
    const { app, library, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const interrupted = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockReturnValue(false);
    await update();
    expect(existsSync(oldDirectory)).toBe(true);
    library.dispose(); interrupted.mockRestore();
    const restarted = await installation(home);
    restarted.open();
    expect(existsSync(oldDirectory)).toBe(false);
    expect(restarted.skills.skillPackageStamps(lead.id).find((skill) => skill.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
  });

  it("does not retire an old revision if the bot becomes busy during link synchronization", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const originalSync = app.skills.orgSkillStorage.syncSkillLinks;
    const changing = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockImplementation((...args) => {
      const result = originalSync(...args); app.setSkillInUse(true); return result;
    });
    await update();
    expect(existsSync(oldDirectory)).toBe(true);
    expect(app.skills.listSkills(lead.id).find((skill) => skill.name === "pricing-policy")!.warnings).toContainEqual(expect.stringContaining("waiting for safe link"));
    changing.mockRestore(); app.setSkillInUse(false);
    await vi.waitFor(() => expect(existsSync(oldDirectory)).toBe(false));
  });

  it("preserves a disabled state while a failed switch recovers", async () => {
    const { app, botOf, update, installId } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const interrupted = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockReturnValue(false);
    await update();
    expect(app.skills.setSkillEnabled(lead.id, "pricing-policy", false)).toMatchObject({ enabled: false });
    expect(existsSync(oldDirectory)).toBe(true);
    interrupted.mockRestore();
    await vi.waitFor(() => expect(app.readState().installs[installId].release).toBe("1.4.0"));
    expect(app.skills.listSkills(lead.id).find((skill) => skill.name === "pricing-policy")!.enabled).toBe(false);
    expect(existsSync(oldDirectory)).toBe(false);
  });

  it("keeps a pinned old task link until the turn ends, then removes it when the skill is disabled", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
    const task = ensureTaskWorkspaceWithSkills(lead.id, "disabled-task"), link = join(task, ".claude", "skills", "pricing-policy");
    const original = readFileSync(join(link, "SKILL.md"), "utf8");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    await update();
    app.setSkillInUse(true);
    expect(app.skills.setSkillEnabled(lead.id, "pricing-policy", false)).toMatchObject({ enabled: false });
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toBe(original);
    expect(existsSync(oldDirectory)).toBe(true);
    app.setSkillInUse(false);
    ensureTaskWorkspaceWithSkills(lead.id, "disabled-task");
    expect(existsSync(link)).toBe(false);
    await vi.waitFor(() => expect(existsSync(oldDirectory)).toBe(false));
    expect(app.skills.listSkills(lead.id).find((skill) => skill.name === "pricing-policy")!.enabled).toBe(false);
  });

  it("updates reference-only releases, restores the whole bundle on failure and preserves disabled state", async () => {
    const bundle = (version: string, content: string) => release("full-team.v2.json", (doc) => {
      doc.package.release = version;
      doc.package.skills.version = 2;
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [{ path: "references/pricing.md", content }];
    });
    let fail: "folder" | "manifest" | "tamper" | null = null;
    const first = bundle("1.3.0", "Old reference\n");
    const { app, botOf, update, installId } = await addedTeam({ replaceOrg: (botId, source, skill, stamp, expected) => {
      const options = fail === "folder" ? { writeFolder: (...parts: Parameters<typeof writeSkillFolder>) => {
        mkdirSync(parts[0]); writeFileSync(join(parts[0], "SKILL.md"), parts[1]); throw new Error("disk full");
      } }
        : fail === "manifest" ? { writeManifest: () => { throw new Error("disk full"); } }
          : fail === "tamper" ? { writeFolder: (...parts: Parameters<typeof writeSkillFolder>) => {
            writeSkillFolder(...parts);
            writeFileSync(join(parts[0], "references", "pricing.md"), "Unexpected content\n");
          } } : {};
      return app.replaceOrganizationSkill(botId, source, skill, stamp, expected, options);
    } }, first);
    const lead = botOf("lead");
    const path = join(app.DATA_DIR, "workspaces", lead.id, "skills", "pricing-policy", "references", "pricing.md");
    expect(readFileSync(path, "utf8")).toBe("Old reference\n");
    const stamp = app.skills.skillPackageStamps(lead.id).find((item) => item.name === "pricing-policy")!.stamp;
    expect(stamp.w).toBe(app.parts.partHash(app.parts.skillReleaseValue(first.document.package.skills.entries.find((s: any) => s.name === "pricing-policy"))));
    app.skills.setSkillEnabled(lead.id, "pricing-policy", false);
    const next = bundle("1.4.0", "New reference\n");
    for (const stage of ["folder", "manifest", "tamper"] as const) {
      fail = stage;
      await update(next);
      expect(readFileSync(path, "utf8")).toBe("Old reference\n");
      expect(readdirSync(join(app.DATA_DIR, "skill-state", lead.id, "org-skill-staging"))).toEqual([]);
      expect(app.readState().installs[installId].release).toBe("1.3.0");
      expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")!.enabled).toBe(false);
    }
    fail = null;
    await update(next);
    const directory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(readFileSync(join(directory, "references", "pricing.md"), "utf8")).toBe("New reference\n");
    expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")!.enabled).toBe(false);
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toEqual({ removed: true });
    expect(existsSync(directory)).toBe(false);
  });

  it("tracks binary-only release changes and keeps the old folder on failed updates or local edits", async () => {
    const bundle = (version: string, binary: string) => release("full-team.v2.json", (doc) => {
      doc.package.release = version;
      doc.package.skills.version = 3;
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [
        { path: "assets/example.bin", binary: { base64: binary } },
        { path: "scripts/render.sh", content: "#!/bin/sh\necho fixture\n", executable: true },
      ];
    });
    let fail = true;
    const { app, botOf, update } = await addedTeam({ replaceOrg: (botId, source, skill, stamp, expected) =>
      app.replaceOrganizationSkill(botId, source, skill, stamp, expected, fail ? { writeManifest: () => { throw new Error("fixture disk failure"); } } : {})
    }, bundle("1.3.0", "AP8="));
    const lead = botOf("lead");
    app.skills.setSkillEnabled(lead.id, "pricing-policy", false);
    const first = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(readFileSync(join(first, "assets", "example.bin"))).toEqual(Buffer.from([0, 255]));
    await update(bundle("1.4.0", "AAE="));
    expect(readFileSync(join(first, "assets", "example.bin"))).toEqual(Buffer.from([0, 255]));
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.3.0");
    fail = false;
    await update(bundle("1.4.0", "AAE="));
    const second = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(readFileSync(join(second, "assets", "example.bin"))).toEqual(Buffer.from([0, 1]));
    expect(readFileSync(join(second, "scripts", "render.sh"), "utf8")).toContain("echo fixture");
    expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")!.enabled).toBe(false);
    writeFileSync(join(second, "assets", "example.bin"), Buffer.from([0, 2]));
    await update(bundle("1.5.0", "AAM="));
    expect(readFileSync(join(second, "assets", "example.bin"))).toEqual(Buffer.from([0, 2]));
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
  });

  it("keeps the previous bundle and disabled state when publication crosses filesystems", async () => {
    const bundle = (version: string, content: string) => release("full-team.v2.json", (doc) => {
      doc.package.release = version;
      doc.package.skills.version = 2;
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [{ path: "references/pricing.md", content }];
    });
    let problem = "";
    const { app, botOf, update } = await addedTeam({ replaceOrg: (botId, source, skill, stamp, expected) => {
      const result = app.replaceOrganizationSkill(botId, source, skill, stamp, expected, { moveRevision: () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      } });
      if ("error" in result) problem = result.error;
      return result;
    } }, bundle("1.3.0", "old"));
    const lead = botOf("lead");
    const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
    const task = ensureTaskWorkspaceWithSkills(lead.id, "cross-fs-task");
    const taskReference = join(task, ".claude", "skills", "pricing-policy", "references", "pricing.md");
    app.skills.setSkillEnabled(lead.id, "pricing-policy", false);
    const root = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    await update(bundle("1.4.0", "new"));
    expect(problem).toContain("different filesystems");
    expect(readFileSync(join(root, "references", "pricing.md"), "utf8")).toBe("old");
    expect(readFileSync(taskReference, "utf8")).toBe("old");
    expect(app.skills.listSkills(lead.id).find((skill) => skill.name === "pricing-policy")!.enabled).toBe(false);
    expect(app.skills.skillPackageStamps(lead.id).find((skill) => skill.name === "pricing-policy")!.stamp.release).toBe("1.3.0");
    expect(readdirSync(join(app.DATA_DIR, "skill-state", lead.id, "org-skill-staging"))).toEqual([]);
    expect(readdirSync(join(app.DATA_DIR, "workspaces", lead.id, "skills", ".revisions"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("tracks path-only and mode-only releases and protects a locally changed mode", async () => {
    const bundle = (version: string, executable: boolean, path = "scripts/render.sh") => release("full-team.v2.json", (doc) => {
      doc.package.release = version;
      doc.package.skills.version = 3;
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [
        { path, content: "#!/bin/sh\necho fixture\n", ...(executable ? { executable: true } : {}) },
      ];
    });
    let fail = false;
    const { app, botOf, update } = await addedTeam({ replaceOrg: (botId, source, skill, stamp, expected) =>
      app.replaceOrganizationSkill(botId, source, skill, stamp, expected, fail ? { writeManifest: () => { throw new Error("fixture disk failure"); } } : {})
    }, bundle("1.3.0", false));
    const lead = botOf("lead");
    app.skills.setSkillEnabled(lead.id, "pricing-policy", false);
    const first = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    await update(bundle("1.4.0", false, "scripts/renamed.sh"));
    const renamed = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(renamed).not.toBe(first);
    expect(existsSync(join(renamed, "scripts", "render.sh"))).toBe(false);
    expect(statSync(join(renamed, "scripts", "renamed.sh")).mode & 0o100).toBe(0);
    fail = true;
    await update(bundle("1.5.0", true, "scripts/renamed.sh"));
    expect(statSync(join(renamed, "scripts", "renamed.sh")).mode & 0o100).toBe(0);
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
    fail = false;
    await update(bundle("1.5.0", true, "scripts/renamed.sh"));
    const second = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const script = join(second, "scripts", "renamed.sh");
    expect(statSync(script).mode & 0o100).toBe(0o100);
    expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")!.enabled).toBe(false);
    chmodSync(script, 0o600);
    await update(bundle("1.6.0", false, "scripts/renamed.sh"));
    expect(statSync(script).mode & 0o100).toBe(0);
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.5.0");
  });

  it("keeps a newly added local file if the skill changes while an update is staged", async () => {
    let oldDirectory = "";
    const { app, botOf, update } = await addedTeam({ replaceOrg: (botId, source, skill, stamp, expected) => app.replaceOrganizationSkill(botId, source, skill, stamp, expected, {
      writeFolder: (...parts) => {
        writeSkillFolder(...parts);
        writeFileSync(join(oldDirectory, "local.md"), "My notes\n");
      },
    }) });
    const lead = botOf("lead");
    oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const oldText = readFileSync(join(oldDirectory, "SKILL.md"), "utf8");
    await update();
    expect(readFileSync(join(oldDirectory, "SKILL.md"), "utf8")).toBe(oldText);
    expect(readFileSync(join(oldDirectory, "local.md"), "utf8")).toBe("My notes\n");
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.3.0");
  });

  it("updates an enabled skill repeatedly and allows it to be removed and added again", async () => {
    const bundle = (version: string, content?: string) => release("full-team.v2.json", (doc) => {
      doc.package.release = version;
      if (content) {
        doc.package.skills.version = 2;
        doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [{ path: "references/pricing.md", content }];
      }
    });
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const firstDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    await update(bundle("1.4.0", "First reference"));
    const secondDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(secondDirectory).not.toBe(firstDirectory);
    expect(existsSync(firstDirectory)).toBe(false);
    expect(readFileSync(join(secondDirectory, "references", "pricing.md"), "utf8")).toBe("First reference");
    expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")!.enabled).toBe(true);
    const final = bundle("1.5.0");
    await update(final);
    const finalDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    expect(existsSync(secondDirectory)).toBe(false);
    expect(existsSync(join(finalDirectory, "references", "pricing.md"))).toBe(false);
    const stamp = app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp;
    expect(stamp.w).toBe(app.parts.partHash(final.document.package.skills.entries.find((s: any) => s.name === "pricing-policy").instructions));
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toEqual({ removed: true });
    expect(existsSync(finalDirectory)).toBe(false);
    const skill = final.document.package.skills.entries.find((s: any) => s.name === "pricing-policy");
    expect(app.skills.installOrgSkill(lead.id, "org:acme", skill.instructions, stamp)).not.toHaveProperty("error");
  });

  it("recovers an old directory left by an interrupted manifest switch, even after another update", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const interrupted = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockImplementation(() => { throw new Error("simulated interruption"); });
    await update();
    interrupted.mockRestore();
    expect(existsSync(oldDirectory)).toBe(true);
    expect(app.skills.listSkills(lead.id).find((s) => s.name === "pricing-policy")).not.toHaveProperty("retiredRoot");
    const third = await update(release("full-team.v2.json", (doc) => {
      NEXT(doc); doc.package.release = "1.5.0";
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += "\nAnother revision.";
    }));
    const stamp = app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp;
    expect(stamp.release).toBe("1.5.0");
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toEqual({ removed: true });
    expect(existsSync(oldDirectory)).toBe(false);
    const skill = third.document.package.skills.entries.find((s: any) => s.name === "pricing-policy");
    expect(app.skills.installOrgSkill(lead.id, "org:fixture", skill.instructions, stamp, skill.files)).not.toHaveProperty("error");
  });

  it("does not remove a retired directory that was changed after an interrupted switch", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const interrupted = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockImplementation(() => { throw new Error("simulated interruption"); });
    await update();
    interrupted.mockRestore();
    writeFileSync(join(oldDirectory, "local.md"), "Keep my notes\n");
    expect(app.recoverOrganizationSkillLinks(lead.id)).toHaveProperty("error", expect.stringContaining("previous skill folder changed"));
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toHaveProperty("error", expect.stringContaining("previous skill revision"));
    expect(readFileSync(join(oldDirectory, "local.md"), "utf8")).toBe("Keep my notes\n");
    expect(app.skills.listSkills(lead.id).some((skill) => skill.name === "pricing-policy")).toBe(true);
  });

  it("keeps a locally changed older revision and defers removal until recovery", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    await update();
    const older = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const sync = app.skills.orgSkillStorage.syncSkillLinks;
    const changing = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockImplementation((...args) => {
      const result = sync(...args); writeFileSync(join(older, "local.md"), "Keep my notes\n"); return result;
    });
    await update(release("full-team.v2.json", (doc) => {
      NEXT(doc); doc.package.release = "1.5.0";
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += "\nAnother revision.";
    }));
    changing.mockRestore();
    expect(app.skills.removeSkill(lead.id, "pricing-policy")).toHaveProperty("error", expect.stringContaining("previous skill revision"));
    expect(readFileSync(join(older, "local.md"), "utf8")).toBe("Keep my notes\n");
  });

  it.each([false, true])("handles a retired directory before library migration (locally changed: %s)", async (changed) => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const interrupted = vi.spyOn(app.skills.orgSkillStorage, "syncSkillLinks").mockImplementation(() => { throw new Error("simulated interruption"); });
    await update();
    interrupted.mockRestore();
    if (changed) writeFileSync(join(oldDirectory, "local.md"), "Keep my notes\n");
    else expect(app.recoverOrganizationSkillLinks(lead.id)).toEqual({ ok: true });
    const { migrateBotSkillsToLibrary } = await import("./skills-library-migration.ts");
    const report = migrateBotSkillsToLibrary(lead.id);
    const outcome = report.outcomes.find((item) => item.name === "pricing-policy");
    if (changed) {
      expect(outcome).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("previous skill revision") });
      expect(readFileSync(join(oldDirectory, "local.md"), "utf8")).toBe("Keep my notes\n");
      expect(app.skills.listSkills(lead.id).some((skill) => skill.name === "pricing-policy")).toBe(true);
    } else {
      expect(outcome).toMatchObject({ outcome: "migrated" });
      expect(existsSync(oldDirectory)).toBe(false);
    }
  });

  it("does not replace a bundle whose reference was edited locally", async () => {
    const bundle = (version: string, content: string) => release("full-team.v2.json", (doc) => {
      doc.package.release = version; doc.package.skills.version = 2;
      doc.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").files = [{ path: "references/pricing.md", content }];
    });
    const { app, botOf, update } = await addedTeam({}, bundle("1.3.0", "Original"));
    const lead = botOf("lead");
    const path = join(app.DATA_DIR, "workspaces", lead.id, "skills", "pricing-policy", "references", "pricing.md");
    writeFileSync(path, "My local edit");
    await update(bundle("1.4.0", "Publisher edit"));
    expect(readFileSync(path, "utf8")).toBe("My local edit");
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.3.0");
  });

  it.skipIf(process.platform === "win32")("refuses a linked protected staging folder without following it", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const oldDirectory = app.skills.listMigratableSkills(lead.id, "pricing-policy")[0]!.directory!;
    const oldText = readFileSync(join(oldDirectory, "SKILL.md"), "utf8");
    const outside = join(app.DATA_DIR, "outside-fixture"); mkdirSync(outside);
    symlinkSync(outside, join(app.DATA_DIR, "skill-state", lead.id, "org-skill-staging"));
    await update();
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(oldDirectory, "SKILL.md"), "utf8")).toBe(oldText);
    expect(app.skills.skillPackageStamps(lead.id).find((s) => s.name === "pricing-policy")!.stamp.release).toBe("1.3.0");
  });

  it("takes every part the publisher changed and the person did not, and moves the install to the new release", async () => {
    const { app, library, installId, botOf, routineOf, update } = await addedTeam();
    const before = botOf("lead");
    const next = await update();
    const lead = botOf("lead");
    expect(lead).toMatchObject({ soul: "You run the desk. Quote the 2027 price list.", title: "Desk lead", name: before.name });
    expect(lead.approvalMode, "an update never raises approval").toBe(before.approvalMode);
    expect(lead.playbooks![0]!.instructions).toMatch(/Then confirm the seat count\.$/);
    expect(lead.installedPackage).toMatchObject({ release: "1.4.0", sha256: next.sha256 });
    expect(app.skills.readSkillFile(lead.id, "pricing-policy")).toMatch(/Seats are 59 from January\./);
    expect(app.skills.skillPackageStamps(lead.id).find((skill) => skill.name === "pricing-policy")!.stamp.release).toBe("1.4.0");
    expect(app.store.groups[0]!.bulletin).toBe("Cite sources. Lead answers first.");
    const daily = app.routines.listRoutines().find((routine) => routine.id === routineOf("daily-digest").routineId)!;
    expect(daily).toMatchObject({ prompt: "Summarise yesterday's deals, biggest first.", enabled: false });
    expect(app.sections.readSectionContext(lead.section)?.text).toBe("We sell a team plan at 59 per seat.");
    expect(app.readState().installs[installId]).toMatchObject({ release: "1.4.0", sha256: next.sha256, status: "installed" });
    expect(app.posted.at(-1).packages).toEqual([{ packageId: TEAM_ID, release: "1.4.0", sha256: next.sha256, state: "installed" }]);
    expect(library.list().packages[0]!.installed).toMatchObject({ release: "1.4.0" });

    // Nothing changes when the same catalog comes again.
    const stamped = structuredClone(botOf("lead").packageBase);
    await update(next);
    expect(botOf("lead").packageBase).toEqual(stamped);
  });

  it("keeps every part the person changed, and takes the rest", async () => {
    const edited = "My own pricing notes.";
    const { app, botOf, routineOf, update } = await addedTeam();
    const lead = botOf("lead");
    const editedSkill = join(app.DATA_DIR, "workspaces", lead.id, "skills", "pricing-policy", "SKILL.md");
    writeFileSync(editedSkill, edited);
    app.store.patchBotProfile(lead.id, { soul: "My own instructions." });
    app.store.patchGroup(app.store.groups[0]!.id, { bulletin: "Our own room rules." });
    const daily = routineOf("daily-digest").routineId;
    app.routines.update(daily, { prompt: "My own digest.", enabled: true });
    await update();
    const after = botOf("lead");
    expect(after.soul).toBe("My own instructions.");
    expect(after.title).toBe("Desk lead");
    expect(readFileSync(editedSkill, "utf8")).toBe(edited);
    expect(app.store.groups[0]!.bulletin).toBe("Our own room rules.");
    expect(app.routines.listRoutines().find((routine) => routine.id === daily)).toMatchObject({ prompt: "My own digest.", enabled: true });

    // A later release that changes the soul again still leaves the person's version alone.
    await update(release("full-team.v2.json", (document) => { NEXT(document); document.package.release = "1.5.0"; document.package.agents[0].soul = "Third version."; }));
    expect(botOf("lead").soul).toBe("My own instructions.");
  });

  it("adds a skill new to a bot in this release, never one the person took off, and keeps a skill switched off", async () => {
    const { app, botOf, update } = await addedTeam();
    const lead = botOf("lead");
    const scout = botOf("scout");
    app.skills.setSkillEnabled(lead.id, "pricing-policy", false);
    const scoutHad = app.skills.listSkills(scout.id).map((skill) => skill.name);
    app.skills.removeSkill(scout.id, scoutHad[0]!);
    await update(release("full-team.v2.json", (document) => {
      NEXT(document);
      document.package.agents.find((agent: any) => agent.key === "lead").skills.push("objection-handling");
    }));
    expect(app.skills.listSkills(lead.id).map((skill) => [skill.name, skill.enabled]).sort()).toEqual([["objection-handling", true], ["pricing-policy", false]]);
    expect(app.skills.readSkillFile(lead.id, "pricing-policy")).toMatch(/Seats are 59 from January\./);
    expect(app.skills.listSkills(scout.id).map((skill) => skill.name)).not.toContain(scoutHad[0]);
  });

  it("puts a skill back when its new text can't be written, and finishes the update with the next catalog", async () => {
    let fail = false;
    const { app, installId, botOf, update } = await addedTeam({
      replaceOrg: (...args) => {
        if (fail && args[2].instructions.includes("Seats are 59")) { fail = false; return { error: "disk full" }; }
        return app.replaceOrganizationSkill(...args);
      },
    });
    const lead = botOf("lead");
    const original = app.skills.readSkillFile(lead.id, "pricing-policy");
    fail = true;
    const next = await update();
    expect(app.skills.readSkillFile(lead.id, "pricing-policy")).toBe(original);
    expect(app.readState().installs[installId].release, "not moved while a part failed").toBe("1.3.0");
    await update(next);
    expect(app.skills.readSkillFile(lead.id, "pricing-policy")).toMatch(/Seats are 59 from January\./);
    expect(app.readState().installs[installId].release).toBe("1.4.0");
  });

  it("waits while the new release isn't downloaded or needs a newer app, and never moves to a withdrawn one", async () => {
    const { app, installId, botOf, update } = await addedTeam();
    const soul = botOf("lead").soul;
    const next = await update(undefined, {}, false);
    expect(botOf("lead").soul).toBe(soul);
    expect(app.readState().installs[installId].release).toBe("1.3.0");
    await update(next, { release: { ...entry(TEAM_ID, next).release, formatVersion: 99 } });
    expect(app.readState().installs[installId].release).toBe("1.3.0");
    await update(next, { withdrawnReleases: [{ version: "1.4.0", sha256: next.sha256 }] });
    expect(botOf("lead").soul).toBe(soul);
    expect(app.readState().installs[installId].release).toBe("1.3.0");
  });

  it("leaves a team another organization added, and a removed team, alone", async () => {
    const { app, library, installId, botOf } = await addedTeam();
    const next = release("full-team.v2.json", NEXT);
    app.writeBlob(next.bytes);
    const soul = botOf("lead").soul;
    library.applyRelay(relay({ ...catalog([entry(TEAM_ID, next)]), organization: { id: OTHER_ORG, name: "Other Co" } }, { organizationId: OTHER_ORG }));
    await library.settled();
    expect(botOf("lead").soul).toBe(soul);
    expect(app.readState().installs[installId].release).toBe("1.3.0");
  });
});

