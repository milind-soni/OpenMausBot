import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, parsePackageDocument } from "../shared/package-format.ts";

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

/** The bytes Admin serves: the file parsed as a file, stamped with its
 * publisher, in canonical form (contract §1.6, §4.4 step 5). */
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

/** The relay Electron sends: the raw catalog body and its digest. */
function relay(body: unknown, overrides: Record<string, unknown> = {}) {
  const text = JSON.stringify(body);
  return { adminOrigin: ADMIN, organizationId: ORG, organizationName: "Customer Co", digest: sha(text), catalog: text, ...overrides };
}

/** A copy of the whole installation as it is on disk right now: what the
 * next start would find if the app stopped at this instant. */
function snapshot(): string {
  const copy = mkdtempSync(join(tmpdir(), "omb-org-library-crash-"));
  homes.push(copy);
  cpSync(home, copy, { recursive: true });
  return copy;
}

/** A real Store, RoutineManager and skill store in a throwaway home (or in
 * `from`, a snapshot, to start again from what it holds). */
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
  const workspace = await import("./workspace.ts");
  const sections = await import("./section-context.ts");
  const { saveImage } = await import("./attachments.ts");
  const { botAvatarUrlFromStoredPath } = await import("../shared/bot-avatar.ts");
  const { DATA_DIR } = await import("./config.ts");
  const { OrgLibrary, parseOrgLibraryCatalog } = await import("./org-library.ts");
  const parts = await import("./package-parts.ts");
  // Preset bots (presets.ts), wired as server/index.ts wires them.
  const presetStore = (await import("./presets.ts")).createPresetStore(join(DATA_DIR, "org-library", "presets.json"));
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: (groupId, botId) => (store.group(groupId)?.memberIds.includes(botId) ? "ready" : "missing"),
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
  const open = () => new OrgLibrary({
    dataDir: DATA_DIR,
    store,
    routines,
    skills: { list: skills.listSkills, stamps, setEnabled: skills.setSkillEnabled, installOrg: skills.installOrgSkill },
    presets: presetStore,
    postState: (message) => posted.push(structuredClone(message)),
  });
  const writeBlob = (bytes: string | Buffer, name = sha(bytes)) => {
    mkdirSync(join(DATA_DIR, "org-library", "blobs"), { recursive: true });
    writeFileSync(join(DATA_DIR, "org-library", "blobs", `${name}.json`), bytes);
  };
  const statePath = join(DATA_DIR, "org-library", "state.json");
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  return { store, routines, skills, stamps, parts, sections, DATA_DIR, importDeps, mcp, posted, open, writeBlob, statePath, readState, parseOrgLibraryCatalog };
}

afterEach(async () => {
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
    // …but a catalog for the organization the relay names is applied.
    expect(library.list().organization).toEqual({ id: OTHER_ORG, name: "Other" });
    expect(library.applyRelay(relay(catalog([entry(TEAM_ID, team)])))).toEqual({ ok: true });
    await library.settled();
    // The digest must name exactly the relayed bytes.
    expect(library.applyRelay({ ...relay(catalog([])), digest: "0".repeat(64) }).ok).toBe(false);
    // A non-https Admin origin is refused.
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
    // Same name, different bytes: tampered on disk.
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

describe("the relay", () => {
  it("acknowledges before any work, then reconciles and reports", async () => {
    const app = await installation();
    const library = app.open();
    const team = release("full-team.v2.json");
    const started = Date.now();
    const body = catalog([entry(TEAM_ID, team)]);
    expect(library.applyRelay(relay(body))).toEqual({ ok: true });
    // Nothing has been written or reported yet: the ack comes first.
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
      // Every part has both hashes; nothing is taken from the file's approval.
      expect(Object.keys(bot.packageBase!).sort()).toEqual([...app.parts.AGENT_PARTS].sort());
      for (const value of Object.values(bot.packageBase!)) expect(value).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
      expect(bot.packageBase!.approval!.w).toBe(app.parts.partHash("ask"));
      expect(bot).not.toHaveProperty("approvalMode");
    }
    // w(name) is what was written after the collision; r is the release's.
    expect(scout.packageBase!.name).toEqual({ r: app.parts.partHash("Scout"), w: app.parts.partHash("Scout 2") });
    // Everything written as released hashes the same on both sides, so a
    // later update can tell "untouched" from "edited".
    const lead = byKey.get("lead")!;
    for (const part of ["name", "title", "description", "soul", "look", "playbooks", "skills"] as const) {
      expect(lead.packageBase![part]!.w, part).toBe(lead.packageBase![part]!.r);
    }
    expect(byKey.get("lead")!.packageBase!.approval!.r).toBe(app.parts.partHash("auto"));

    // Skills on, stamped; the file's own source is ignored.
    expect(app.skills.listSkills(scout.id)).toEqual([
      expect.objectContaining({ name: "pricing-policy", enabled: true, source: "org:acme/sales-desk@1.3.0" }),
      expect.objectContaining({ name: "research-brief", enabled: true, source: "org:acme/sales-desk@1.3.0" }),
    ]);
    expect(app.skills.listSkills(scout.id)[0]).not.toHaveProperty("package");
    expect(app.skills.skillPackageStamps(scout.id)).toContainEqual({ name: "pricing-policy", enabled: true,
      stamp: { installId, key: "pricing-policy", release: "1.3.0", r: expect.stringMatching(hex), w: expect.stringMatching(hex) } });

    // Routines paused, stamped; the stamp never reaches the wire.
    expect(result.routines).toHaveLength(2);
    expect(app.routines.listRoutines().every((routine) => !routine.enabled && !("installedPackage" in routine))).toBe(true);
    const stamps = app.routines.packageStamps();
    expect(stamps.map((routine) => routine.stamp.key).sort()).toEqual(["daily-digest", "weekly-review"]);
    for (const routine of stamps) {
      expect(routine.stamp.installId).toBe(installId);
      for (const part of app.parts.ROUTINE_PARTS) expect(routine.stamp.parts[part]).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
      for (const part of ["name", "prompt", "schedule"] as const) expect(routine.stamp.parts[part].w, part).toBe(routine.stamp.parts[part].r);
    }

    // The group chat carries its keys and hashes.
    const room = app.store.group(result.groups[0]!.id)!;
    expect(room.installedPackage).toMatchObject({ installId, key: "desk", memberKeys: ["lead", "scout", "writer"] });
    for (const part of app.parts.ROOM_PARTS) expect(room.installedPackage!.parts[part]).toEqual({ r: expect.stringMatching(hex), w: expect.stringMatching(hex) });
    for (const part of ["name", "bulletin"] as const) expect(room.installedPackage!.parts[part].w, part).toBe(room.installedPackage!.parts[part].r);

    // The index follows the records.
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
    // The team's preset is in New bot, with the release-side hash (§1.6).
    const [preset] = app.importDeps.presets.list();
    expect(preset).toMatchObject({ source: "org", installId, key: "support", ref: "acme/sales-desk", sha256: team.sha256 });
    expect(install.presets).toEqual({ support: { presetId: preset!.id, r: app.parts.partHash(team.document.package.presets[0]) } });
    expect(library.list().packages[0]!.installed).toEqual({ installId, release: "1.3.0", status: "installed" });
    // Reported after the Add.
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

    // A crash after the records but before the index: the records win, and
    // the team's presets are indexed again from their rows.
    library.dispose();
    unlinkSync(app.statePath);
    library = app.open();
    library.applyRelay(relay(body));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ packageId: TEAM_ID, status: "installed", section: "Sales desk", presets });
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 200, value: { alreadyAdded: true } });
    expect(app.store.bots).toHaveLength(bots);
    expect(app.store.groups).toHaveLength(1);

    // Signing out hides the shelf; the copies stay. Reconnecting to the same
    // organization recognizes them.
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
    // The person switched a routine on after adding.
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

    // Only the transition acts: a skill the person switches back on stays on.
    app.skills.setSkillEnabled(scout.id, "research-brief", true);
    library.applyRelay(relay(catalog([withdrawn], { libraryVersion: 4 })));
    await library.settled();
    expect(app.skills.listSkills(scout.id).find((skill) => skill.name === "research-brief")!.enabled).toBe(true);
    // An entry that disappears changes nothing.
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
    // The person may add it again from the shelf.
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
    // The team's unassigned skill, put on one of the person's own bots.
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
    // The skill is a copy and stays where the person put it.
    expect(app.skills.listSkills(own.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true })]);
    // …and the team can be added again, whole.
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
    // The team is still the one the person removed.
    expect(app.readState().installs[installId]).toMatchObject({ status: "removed", withdrawnHandled: team.sha256 });
    expect(app.posted.at(-1).packages).toEqual([
      { packageId: TEAM_ID, release: "1.3.0", sha256: team.sha256, state: "removed", reason: "removed_locally" },
    ]);
    // Switched back on by the person, it stays on.
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
    // The app stops as the first routine is about to be written: the bots
    // (with their skills and notes), the group chat and the brief are on
    // disk, the routines and the leader are not.
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

    // The next start removes the half-built team instead of adopting it.
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

    // Add now brings the whole team, under its own name.
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
    // Every bot, group chat and routine is written and stamped; the leader,
    // the importer's last write, is not.
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
    // The leader is the importer's last write; the app stops right after it,
    // before the index is saved.
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
    // The leader is set last, so a team with its leader has its brief too.
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
    // No records carry a library install, so the index alone makes Add a no-op.
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
    // A library install has no records of its own; it is never "removed".
    app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("installed");

    // Withdrawing it switches the offered skill off where it was added.
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
    // Deleting a bot never marks a skills-only package removed.
    app.store.deleteBot(app.store.createBot({ name: "Passing" }).id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId]).toMatchObject({ kind: "library", status: "installed" });
    expect(library.offeredSkills(bot.id).skills.find((skill) => skill.name === "follow-up")).toMatchObject({ added: true });
  });
});

describe("parts the person deleted (removedLocally)", () => {
  /** The full team added from the shelf: bots lead, scout and writer, the
   * group chat desk, and the routines daily-digest (scout's) and
   * weekly-review (lead's). */
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
  /** The store-change debounce, then the rebuild it queued. */
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
    // A bot's routines stop counting with it, so they are noted as well.
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
    // Deleting a routine is not a store change; the next rebuild (here the
    // next relayed catalog) notes it.
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
    // Nothing changed, so nothing was written.
    expect(readFileSync(app.statePath, "utf8")).toBe(before);
    expect(install().removedLocally).toEqual(["agent:writer"]);

    // Deleted with no library listening (the app stopped before its
    // debounced rebuild): the next start notes it. A list that already
    // names the part (another build wrote it) gets no second entry.
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
    // Records restored from a backup, say.
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
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: false, status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.posted).toEqual([]);
    expect(existsSync(join(app.DATA_DIR, "org-library"))).toBe(false);
    // Not even the bots' skill state is read.
    expect(app.stamps).not.toHaveBeenCalled();
  });
});

// Preset bots (presets.ts) are an install's records too, in their own way.
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
    // New bot → the team's preset: the bot carries the install id and a presetKey.
    const made = app.store.createBot({ name: "Sky" });
    presets.applyPresetToBot(made.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    expect(app.store.bot(made.id)!.installedPackage).toMatchObject({ source: "org", installId, presetKey: "support" });

    // The person deletes the team; the bot they made from its preset stays.
    for (const id of app.store.groups.map((group) => group.id)) app.store.deleteGroup(id);
    for (const bot of added.value.result.bots) app.store.deleteBot(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("removed");

    // Neither that bot nor the preset row makes Add a no-op.
    const again = library.add(TEAM_ID, app.importDeps) as any;
    expect(again).toMatchObject({ ok: true, status: 201 });
    expect(again.value.result.bots).toHaveLength(3);
    expect(app.store.bot(made.id)).toBeTruthy();
    // The same preset, refreshed in place: one row, the same id.
    expect(app.importDeps.presets.list()).toEqual([expect.objectContaining({ id: row!.id, installId, key: "support" })]);
    expect(app.readState().installs[installId]).toMatchObject({ status: "installed", presets: { support: { presetId: row!.id } } });
    expect(library.add(TEAM_ID, app.importDeps)).toMatchObject({ ok: true, status: 200, value: { alreadyAdded: true } });
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
    // A skill of the same name from somewhere else is the person's own.
    const mine = app.store.createBot({ name: "Mine" });
    presets.applyPresetToBot(mine.id, app.importDeps.presets.resolve(row!.id)!, app.importDeps);
    app.skills.removeSkill(mine.id, "objection-handling");
    app.skills.installSkill(mine.id, "https://example.com/mine", [{ path: "SKILL.md", content: "---\nname: objection-handling\ndescription: Mine.\n---\n\nMine.\n" }]);
    app.skills.setSkillEnabled(mine.id, "objection-handling", true);

    // state.json becomes unreadable (or the app stopped before writing it):
    // the preset rows are the package's records, so it is adopted as it was.
    library.dispose();
    writeFileSync(app.statePath, "{not json");
    library = app.open();
    library.applyRelay(relay(body));
    await library.settled();
    expect(app.readState().installs[installId]).toEqual({ ...indexed, addedAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(library.add(LIBRARY_ID, app.importDeps)).toEqual({ ok: true, status: 200, value: { alreadyAdded: true, installId } });
    expect(app.importDeps.presets.list()).toHaveLength(1);
    expect(library.offeredSkills().skills.map((skill) => skill.name)).toEqual(["objection-handling", "follow-up"]);

    // Withdrawn: the preset leaves New bot and the bot made from it has its
    // skill switched off, once. The person's own skill is left alone.
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills, { release: null, withdrawnReleases: [{ version: "2.0.1", sha256: skills.sha256 }] })])));
    await library.settled();
    expect(app.readState().installs[installId].status).toBe("withdrawn");
    expect(presets.listBotPresets(app.importDeps.presets, presets.readOrgInstallStatuses(app.statePath))).toEqual([]);
    expect(app.skills.listSkills(made.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: false })]);
    expect(app.skills.listSkills(mine.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true, source: "https://example.com/mine" })]);
    app.skills.setSkillEnabled(made.id, "objection-handling", true);
    library.applyRelay(relay(catalog([entry(LIBRARY_ID, skills, { release: null, withdrawnReleases: [{ version: "2.0.1", sha256: skills.sha256 }] })], { libraryVersion: 4 })));
    await library.settled();
    expect(app.skills.listSkills(made.id)[0]!.enabled).toBe(true);
  });
});
