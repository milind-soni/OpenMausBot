import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NewBotDefaults } from "./new-bot-defaults.ts";
import type { BotRecord } from "./store.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const skillText = (name: string, body = "Do it well.") => `---\nname: ${name}\ndescription: ${name} steps.\n---\n\n# ${name}\n\n${body}\n`;
let home: string;

/** A real Store, skill store and memory in a throwaway home, the importer,
 * and a preset store on a file in that home. */
async function installation() {
  home = mkdtempSync(join(tmpdir(), "omb-presets-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const { RoutineManager } = await import("./routines.ts");
  const skills = await import("./skills.ts");
  const workspace = await import("./workspace.ts");
  const sections = await import("./section-context.ts");
  const presets = await import("./presets.ts");
  const importer = await import("./package-import.ts");
  const exporter = await import("./package-export.ts");
  const { parsePackageDocument } = await import("../shared/package-format.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(home, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: (groupId, botId) => (store.group(groupId)?.memberIds.includes(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
  });
  const presetFile = join(home, "presets.json");
  const presetStore = presets.createPresetStore(presetFile);
  const mcp = { servers: {} as Record<string, unknown> };
  const deps = {
    store,
    routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled, installOrg: skills.installOrgSkill },
    memory: { writeIndex: workspace.writeMemoryFile, writeTopic: workspace.writeMemoryTopic },
    mcp: { servers: () => mcp.servers, refusal: () => undefined, persist: (next: Record<string, unknown>) => { mcp.servers = next; } },
    sections: { writeBrief: (section: string, text: string) => void sections.writeSectionContext(section, text) },
    images: { save: () => "/api/attachments/fixture.png" },
    defaultSelection: () => ({ instanceId: "claude", model: "default-model" }),
    presets: presetStore,
  };
  const applyDeps = { store, skills: deps.skills, memory: deps.memory };
  const org = (packageId = "pkg-1") => ({
    adminOrigin: "https://admin.example.com", organizationId: "org-1", packageId, ref: "acme/sales-skills", sha256: "a".repeat(64),
    publisher: { organizationId: "org-acme", slug: "acme", name: "Acme Partners" },
    installId: importer.orgInstallId("https://admin.example.com", "org-1", packageId),
  });
  const orgDocument = (name: string) => {
    const document = parsePackageDocument(fixture(name), { trust: "org" });
    document.package.publisher = { organization: "acme", name: "Acme Partners" };
    return document;
  };
  return { store, skills, workspace, presets, importer, exporter, parsePackageDocument, presetStore, presetFile, deps, applyDeps, org, orgDocument };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("preset store", () => {
  it("adds a team file's presets as file presets, once per identical file, and a failed import removes them again", async () => {
    const app = await installation();
    const document = app.parsePackageDocument(fixture("full-team.v2.json"));
    const first = app.importer.importPackageDocument(document, { trust: "file", mode: "add" }, app.deps);
    if (first.alreadyAdded) throw new Error("unexpected");
    expect(first.presets).toEqual([{ id: expect.any(String), key: "support", name: "Support agent" }]);
    expect(first.skipped).toEqual([]);
    const [row] = app.presetStore.list();
    expect(row).toMatchObject({ source: "file", installId: first.installId, packageId: "sales-desk", packageName: "Sales desk", release: "1.3.0", key: "support" });
    expect(row).not.toHaveProperty("publisher");
    // What the file keeps: only the skills and playbooks the preset uses.
    const stored = JSON.parse(readFileSync(app.presetFile, "utf8"));
    expect(stored.content[first.installId!].skills.map((skill: { name: string }) => skill.name)).toEqual(["objection-handling"]);
    expect(stored.content[first.installId!].playbooks.map((playbook: { key: string }) => playbook.key)).toEqual(["qualify"]);

    // The same file again: a second team (bots are always new) but the same preset.
    const second = app.importer.importPackageDocument(document, { trust: "file", mode: "add" }, app.deps);
    if (second.alreadyAdded) throw new Error("unexpected");
    expect(second.presets).toEqual(first.presets);
    expect(app.presetStore.list()).toHaveLength(1);

    // A changed file is a different preset.
    const changed = fixture("full-team.v2.json");
    changed.package.presets[0].bot.soul = "Be brief.\n";
    const third = app.importer.importPackageDocument(app.parsePackageDocument(changed), { trust: "file", mode: "add" }, app.deps);
    if (third.alreadyAdded) throw new Error("unexpected");
    expect(app.presetStore.list()).toHaveLength(2);

    // A failure after the presets were stored removes them with everything else.
    const another = fixture("full-team.v2.json");
    another.package.presets[0].name = "Support agent (new)";
    const bots = app.store.bots.length;
    const lateFailure = { ...app.deps, broadcast: () => { throw new Error("window gone"); } };
    expect(() => app.importer.importPackageDocument(app.parsePackageDocument(another), { trust: "file", mode: "add" }, lateFailure)).toThrow("window gone");
    expect(app.presetStore.list()).toHaveLength(2);
    expect(app.store.bots).toHaveLength(bots);
  });

  it("stores a library file's presets and offers its skills, and refuses a file with nothing to add", async () => {
    const app = await installation();
    const result = app.importer.importPackageDocument(app.parsePackageDocument(fixture("library-only.v2.json")), { trust: "file", mode: "add" }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    expect(result).toMatchObject({ name: "Sales skills", section: "", bots: [], groups: [], routines: [], offeredSkills: ["objection-handling", "follow-up"], connections: [], brief: false, notes: 0 });
    expect(result.presets).toEqual([{ id: expect.any(String), key: "support", name: "Support agent" }]);
    expect(app.store.bots).toEqual([]);
    expect(app.store.sections).toEqual([]);

    const skillsOnly = fixture("library-only.v2.json");
    delete skillsOnly.package.presets;
    expect(() => app.importer.importPackageDocument(app.parsePackageDocument(skillsOnly), { trust: "file", mode: "add" }, app.deps))
      .toThrow(app.importer.NO_PRESETS_MESSAGE);
    expect(app.presetStore.list()).toHaveLength(1);
  });

  it("stores organization presets with their provenance, and refreshes an install's rows in place when it is added again", async () => {
    const app = await installation();
    const org = app.org();
    const document = app.orgDocument("library-only.v2.json");
    const result = app.importer.importPackageDocument(document, { trust: "org", mode: "add", org }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    expect(result.installId).toBe(org.installId);
    expect(app.presetStore.list()).toEqual([expect.objectContaining({
      source: "org", installId: org.installId, publisherName: "Acme Partners", publisher: org.publisher, ref: "acme/sales-skills", sha256: org.sha256,
    })]);
    const [first] = app.presetStore.list();
    // Preset rows never make the importer answer "already added" (that is
    // org-library.ts's index): a retry after the app stopped before its index
    // was written, or a removed team added again, refreshes the same rows.
    const again = app.importer.importPackageDocument(document, { trust: "org", mode: "add", org }, app.deps);
    if (again.alreadyAdded) throw new Error("unexpected");
    expect(again.presets).toEqual([{ id: first!.id, key: "support", name: "Support agent" }]);
    expect(app.presetStore.list()).toEqual([first]);
    // A later release of the same install replaces its rows; a key it no
    // longer has is dropped, and nothing is duplicated.
    const next = fixture("library-only.v2.json");
    next.package.release = "2.1.0";
    next.package.presets[0].name = "Support lead";
    next.package.presets.push({ ...next.package.presets[0], key: "closer", name: "Closer" });
    const nextDocument = app.parsePackageDocument(next, { trust: "org" });
    nextDocument.package.publisher = { organization: "acme", name: "Acme Partners" };
    app.importer.importPackageDocument(nextDocument, { trust: "org", mode: "add", org: { ...org, sha256: "b".repeat(64) } }, app.deps);
    expect(app.presetStore.list().map((row) => [row.id === first!.id, row.key, row.name, row.release, row.sha256])).toEqual([
      [true, "support", "Support lead", "2.1.0", "b".repeat(64)],
      [false, "closer", "Closer", "2.1.0", "b".repeat(64)],
    ]);
    const without = fixture("library-only.v2.json");
    without.package.presets = without.package.presets.filter((preset: { key: string }) => preset.key === "support");
    const withoutDocument = app.parsePackageDocument(without, { trust: "org" });
    withoutDocument.package.publisher = { organization: "acme", name: "Acme Partners" };
    app.importer.importPackageDocument(withoutDocument, { trust: "org", mode: "add", org }, app.deps);
    expect(app.presetStore.list().map((row) => [row.id === first!.id, row.key, row.release])).toEqual([[true, "support", "2.0.1"]]);
    // Organization presets are Admin's to remove; a file preset is the person's.
    expect(app.presetStore.removeFilePreset(app.presetStore.list()[0]!.id)).toBe("organization");
    expect(app.presetStore.removeFilePreset("missing")).toBe("not_found");
  });

  it("offers organization presets first, hides withdrawn or removed installs, and never lists a tampered row", async () => {
    const app = await installation();
    app.importer.importPackageDocument(app.parsePackageDocument(fixture("library-only.v2.json")), { trust: "file", mode: "add" }, app.deps);
    const org = app.org();
    app.importer.importPackageDocument(app.orgDocument("library-only.v2.json"), { trust: "org", mode: "add", org }, app.deps);
    const listed = app.presets.listBotPresets(app.presetStore, new Map());
    expect(listed.map((preset) => [preset.source, preset.name, preset.publisherName, preset.skillsEnabled])).toEqual([
      ["org", "Support agent", "Acme Partners", true],
      ["file", "Support agent", undefined, false],
    ]);
    expect(listed[1]).toMatchObject({ packageName: "Sales skills", release: "2.0.1", bot: { name: "Sky", title: "Support", appearance: { color: "blue" } },
      skills: [{ name: "objection-handling", description: "Answer common objections." }], playbooks: [], notes: [] });
    expect(app.presets.listBotPresets(app.presetStore, new Map([[org.installId, "withdrawn" as const]])).map((preset) => preset.source)).toEqual(["file"]);
    expect(app.presets.listBotPresets(app.presetStore, new Map([[org.installId, "removed" as const]])).map((preset) => preset.source)).toEqual(["file"]);

    // A hand-edited file cannot add an approval level, a model or a daily log:
    // fields the format does not have are dropped, and a row the format
    // refuses is not offered at all.
    const stored = JSON.parse(readFileSync(app.presetFile, "utf8"));
    Object.assign(stored.presets[0].bot, { approvalMode: "full", modelSelection: { instanceId: "x", model: "y" }, cwd: "/", computer: "local" });
    stored.presets[1].seed = { memory: { "memory/log/2026-09-24.md": "chat" } };
    writeFileSync(app.presetFile, JSON.stringify(stored));
    const after = app.presets.listBotPresets(app.presetStore, new Map());
    expect(after).toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/approvalMode|modelSelection|cwd|computer/);
    expect(app.presetStore.resolve(stored.presets[1].id)).toBeNull();
  });

  it("reads the organization's install statuses from its state file, and nothing from a missing or broken one", async () => {
    const app = await installation();
    const file = join(home, "state.json");
    expect(app.presets.readOrgInstallStatuses(file).size).toBe(0);
    writeFileSync(file, "{not json");
    expect(app.presets.readOrgInstallStatuses(file).size).toBe(0);
    writeFileSync(file, JSON.stringify({ version: 1, installs: { a: { status: "installed" }, b: { status: "withdrawn" }, c: { status: "odd" }, d: null } }));
    expect([...app.presets.readOrgInstallStatuses(file)]).toEqual([["a", "installed"], ["b", "withdrawn"]]);
  });
});

describe("creating a bot from a preset", () => {
  it("adds a file preset's skills switched off, its playbooks and starter notes, and stamps where it came from", async () => {
    const app = await installation();
    const input = fixture("full-team.v2.json");
    input.package.presets[0].seed = { memory: { "MEMORY.md": "- Greets by name.\n", "memory/tone.md": "Warm.\n" } };
    const imported = app.importer.importPackageDocument(app.parsePackageDocument(input), { trust: "file", mode: "add" }, app.deps);
    if (imported.alreadyAdded) throw new Error("unexpected");
    const resolved = app.presetStore.resolve(imported.presets![0]!.id)!;
    const bot = app.store.createBot({ name: "Sky", modelSelection: { instanceId: "claude", model: "default-model" } });
    expect(app.presets.applyPresetToBot(bot.id, resolved, app.applyDeps)).toEqual({ skills: ["objection-handling"], notes: 2 });
    expect(app.skills.listSkills(bot.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: false, source: "package:sales-desk" })]);
    expect(app.workspace.readMemoryFile(bot.id).text).toBe("- Greets by name.\n");
    expect(app.workspace.readMemoryTopic(bot.id, "tone.md")).toBe("Warm.\n");
    const record = app.store.bot(bot.id)!;
    expect(record.playbooks).toEqual([expect.objectContaining({ key: "qualify", name: "Qualify a lead" })]);
    expect(record.installedPackage).toEqual({ id: "sales-desk", name: "Sales desk", release: "1.3.0", requiredApps: [], source: "file",
      installId: imported.installId, presetKey: "support" });
    // A preset never touches model, approval, computer or connected apps.
    expect(record.modelSelection).toEqual({ instanceId: "claude", model: "default-model" });
    for (const field of ["approvalMode", "autoApprove", "computer", "cwd", "composio", "mcpServers", "browser"] as const) {
      expect(record).not.toHaveProperty(field);
    }
  });

  it("adds an organization preset's skills switched on, under the organization's own source", async () => {
    const app = await installation();
    const org = app.org();
    const imported = app.importer.importPackageDocument(app.orgDocument("library-only.v2.json"), { trust: "org", mode: "add", org }, app.deps);
    if (imported.alreadyAdded) throw new Error("unexpected");
    const bot = app.store.createBot({ name: "Sky", modelSelection: { instanceId: "claude", model: "default-model" } });
    app.presets.applyPresetToBot(bot.id, app.presetStore.resolve(imported.presets![0]!.id)!, app.applyDeps);
    expect(app.skills.listSkills(bot.id)).toEqual([expect.objectContaining({ name: "objection-handling", enabled: true, source: "org:acme/sales-skills@2.0.1" })]);
    expect(app.store.bot(bot.id)!.installedPackage).toEqual({ id: "sales-skills", name: "Sales skills", release: "2.0.1", requiredApps: [],
      source: "org", installId: org.installId, presetKey: "support", publisher: org.publisher, ref: "acme/sales-skills", sha256: org.sha256 });
  });
});

describe("sharing my New bot defaults as a preset", () => {
  const defaults = (overrides: Partial<NewBotDefaults> = {}): NewBotDefaults => ({
    profile: {
      name: "Sky", title: "Support", description: "Answers customers.", soul: "Be kind.\n", color: "blue", mascotExpression: "happy",
      // Everything below grants reach or is personal: none of it may travel.
      modelSelection: { instanceId: "claude", model: "opus" }, computer: "local", cwd: "/Users/me/secret", approvalMode: "full",
      alwaysAllow: ["Bash(*)"], chiefOfStaff: true, managedSections: ["Ops"], peers: ["x"], composio: true, browser: true,
      browserProfile: "work", mcpServers: ["crm"], section: "Support", approvePeerComms: true, parkDirectMessages: true, avatarCrop: "rounded",
    },
    memory: { "MEMORY.md": "- Customers first.\n", "memory/tone.md": "Warm.\n" },
    skills: [{ name: "follow-up", description: "follow-up steps.", source: "https://github.com/acme/skills", text: skillText("follow-up"), enabled: true, warnings: [] }],
    routines: [{ name: "Daily", prompt: "Check the inbox.", schedule: { type: "daily", time: "09:00", weekdays: [1] } }],
    ...overrides,
  });

  it("keeps only the allowlist: name, look, instructions, skills and (when asked) starter notes", async () => {
    const app = await installation();
    const built = app.presets.presetFromDefaults(defaults(), { name: "Support agent", description: "Kind and precise.", includeNotes: true,
      avatar: { mime: "image/png", data: PNG } });
    expect(built.skipped).toEqual([]);
    expect(built.value!.preset).toEqual({
      key: "new-bot-defaults", name: "Support agent", description: "Kind and precise.",
      bot: { name: "Sky", title: "Support", description: "Answers customers.", soul: "Be kind.\n",
        appearance: { color: "blue", mascotExpression: "happy", avatar: { mime: "image/png", data: PNG, crop: "rounded" } } },
      skills: ["follow-up"],
      seed: { memory: { "MEMORY.md": "- Customers first.\n", "memory/tone.md": "Warm.\n" } },
    });
    expect(JSON.stringify(built.value)).not.toMatch(/opus|secret|full|Bash|crm|work|Ops|Daily/);
    expect(app.presets.presetFromDefaults(defaults(), { includeNotes: false }).value!.preset).not.toHaveProperty("seed");
    const empty = app.presets.presetFromDefaults({ profile: { approvalMode: "auto", computer: "local" }, memory: {}, skills: [], routines: [] }, { includeNotes: true });
    expect(empty).toEqual({ value: null, skipped: [{ part: "presets[new-bot-defaults]", reason: "preset_empty" }] });
  });

  it("goes into a team file with its skills, never pushing out the team's own", async () => {
    const app = await installation();
    const built = app.presets.presetFromDefaults(defaults({
      skills: [
        { name: "follow-up", description: "follow-up steps.", source: "fixture", text: skillText("follow-up"), enabled: true, warnings: [] },
        { name: "research-brief", description: "research-brief steps.", source: "fixture", text: skillText("research-brief", "Different."), enabled: true, warnings: [] },
      ],
    }), { includeNotes: true });
    const bot = { id: "b1", threadId: "t1", name: "Morgan", color: "green", section: "Sales desk", createdAt: 1 } as BotRecord;
    const exported = app.exporter.createTeamPackageExport({
      team: "Sales desk", bots: [bot], groups: [], routines: [], published: null,
      skillsByBot: new Map([["b1", [{ name: "research-brief", description: "research-brief steps.", instructions: skillText("research-brief"), source: "fixture" }]]]),
      preset: built.value,
    });
    const pkg = exported.document.package;
    expect(pkg.presets).toEqual([expect.objectContaining({ key: "new-bot-defaults", name: "Sky", skills: ["follow-up"] })]);
    expect(pkg.skills!.entries.map((skill) => skill.name).sort()).toEqual(["follow-up", "research-brief"]);
    expect(pkg.skills!.entries.find((skill) => skill.name === "research-brief")!.instructions).toContain("Do it well.");
    expect(exported.skipped).toEqual([{ part: "presets[new-bot-defaults].skills[research-brief]", reason: "preset_skill_conflict" }]);
    expect(JSON.stringify(pkg)).not.toMatch(/enabled|opus|approval/);
  });

  it("saves a library file of the preset and its skills, redacted, with a stable id and the next release", async () => {
    const app = await installation();
    const built = app.presets.presetFromDefaults(defaults({ profile: { name: "Sky", soul: "Use password=Hunter2-Secret-99 for the portal.\n" } }), { name: "Support agent", includeNotes: true });
    const first = app.exporter.createLibraryPackageExport({ published: null, preset: built.value, authorName: "Mira" });
    expect(first.filename).toBe("support-agent-1.0.0.openmaus.json");
    expect(first.redacted).toEqual(["presets[new-bot-defaults].bot.soul"]);
    expect(JSON.stringify(first.document)).not.toContain("Hunter2-Secret-99");
    expect(first.document.package).toMatchObject({ id: "support-agent", agents: [], author: { name: "Mira" }, presets: [expect.objectContaining({ skills: ["follow-up"] })] });
    expect(first.document.package).not.toHaveProperty("team");
    expect(() => app.parsePackageDocument(first.document)).not.toThrow();
    const second = app.exporter.createLibraryPackageExport({ published: first.published, preset: built.value, name: "Renamed" });
    expect(second.document.package).toMatchObject({ id: "support-agent", release: "1.0.1", name: "Renamed" });
    expect(() => app.exporter.createLibraryPackageExport({ published: null, preset: null })).toThrow("Your New bot defaults are empty");
    expect(() => app.exporter.createLibraryPackageExport({ published: null, preset: built.value, release: "one" })).toThrow("Use a version like 1.2.3.");

    // The file round-trips: import it and create a bot from its preset.
    const imported = app.importer.importPackageDocument(app.parsePackageDocument(JSON.parse(JSON.stringify(first.document))), { trust: "file", mode: "add" }, app.deps);
    if (imported.alreadyAdded) throw new Error("unexpected");
    const bot = app.store.createBot({ name: "Sky", modelSelection: { instanceId: "claude", model: "default-model" } });
    app.presets.applyPresetToBot(bot.id, app.presetStore.resolve(imported.presets![0]!.id)!, app.applyDeps);
    expect(app.skills.listSkills(bot.id)).toEqual([expect.objectContaining({ name: "follow-up", enabled: false })]);
    expect(app.workspace.readMemoryTopic(bot.id, "tone.md")).toBe("Warm.\n");
  });

  it("records what was last shared and starts over from an unreadable record", async () => {
    const app = await installation();
    const file = join(home, "published-library.json");
    expect(app.presets.readPublishedLibrary(file)).toBeNull();
    app.presets.writePublishedLibrary({ packageId: "support-agent", lastRelease: "1.0.4" }, file);
    expect(app.presets.readPublishedLibrary(file)).toEqual({ packageId: "support-agent", lastRelease: "1.0.4" });
    writeFileSync(file, "{");
    expect(app.presets.readPublishedLibrary(file)).toBeNull();
  });
});
