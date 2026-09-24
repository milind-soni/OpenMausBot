import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PackageDocument } from "../shared/package-format.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
let home: string;

/** A real Store, RoutineManager, skill store, memory and section registry in
 * a throwaway home; MCP config and policy are in-memory stand-ins. */
async function installation(options: { refuse?: (name: string) => string | undefined; servers?: Record<string, unknown> } = {}) {
  home = mkdtempSync(join(tmpdir(), "omb-package-import-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const { RoutineManager } = await import("./routines.ts");
  const skills = await import("./skills.ts");
  const workspace = await import("./workspace.ts");
  const sections = await import("./section-context.ts");
  const { saveImage } = await import("./attachments.ts");
  const { botAvatarUrlFromStoredPath } = await import("../shared/bot-avatar.ts");
  const importer = await import("./package-import.ts");
  const { parsePackageDocument } = await import("../shared/package-format.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(home, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: (groupId, botId) => (store.group(groupId)?.memberIds.includes(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
  });
  const mcp = { servers: { ...options.servers } as Record<string, unknown> };
  const events: string[] = [];
  const deps = {
    store,
    routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled, installOrg: skills.installOrgSkill },
    memory: { writeIndex: workspace.writeMemoryFile, writeTopic: workspace.writeMemoryTopic },
    mcp: {
      servers: () => mcp.servers,
      refusal: (name: string) => options.refuse?.(name),
      persist: (next: Record<string, unknown>) => { mcp.servers = next; },
    },
    sections: { writeBrief: (section: string, text: string) => void sections.writeSectionContext(section, text) },
    images: { save: (bytes: Uint8Array, mime: string) => botAvatarUrlFromStoredPath(saveImage(Buffer.from(bytes), mime).path)! },
    broadcast: (event: { kind: string }) => { events.push(event.kind); },
    defaultSelection: () => ({ instanceId: "claude", model: "default-model" }),
  };
  const snapshot = () => JSON.stringify({ bots: store.bots.map((bot) => bot.id), groups: store.groups.map((group) => group.id),
    routines: routines.listRoutines().map((routine) => routine.id), sections: store.sections, servers: mcp.servers });
  return { store, routines, skills, workspace, sections, importer, parsePackageDocument, deps, mcp, events, snapshot };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("importing a whole team", () => {
  it("adds every part from a file: persona, picture, brief, Chief, rooms, paused routines, skills off, valueless connections, notes", async () => {
    const app = await installation({ servers: { crm: { type: "http", url: "https://existing.example.com", headers: { Authorization: "Bearer mine" }, enabled: true } } });
    const document: PackageDocument = app.parsePackageDocument(fixture("full-team.v2.json"));
    const result = app.importer.importPackageDocument(document, { trust: "file", mode: "add" }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    const byKey = new Map(result.bots.map((bot) => [bot.installedPackage!.agentKey, app.store.bot(bot.id)!]));
    const lead = byKey.get("lead")!;
    const scout = byKey.get("scout")!;
    expect(result.section).toBe("Sales desk");
    expect(lead).toMatchObject({
      name: "Morgan", title: "Sales lead", soul: "You coordinate the desk. Keep answers short and cite the price list.\n",
      color: "purple", mascotExpression: "focused", section: "Sales desk", chiefOfStaff: true,
      composio: false, connectorTools: {}, avatarCrop: "circle", modelSelection: { instanceId: "claude", model: "default-model" },
      playbooks: [expect.objectContaining({ key: "qualify" })],
      installedPackage: { id: "sales-desk", release: "1.3.0", source: "file", agentKey: "lead", suggestedApproval: "auto",
        requiredApps: [expect.objectContaining({ slug: "hubspot" })] },
    });
    expect(lead.avatarUrl).toMatch(/^\/api\/attachments\/[\w-]+\.png$/);
    // Approval is never taken from the file.
    expect(lead).not.toHaveProperty("approvalMode");
    expect(lead).not.toHaveProperty("autoApprove");
    expect(lead.installedPackage?.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(result.bots.map((bot) => bot.installedPackage?.installId)).size).toBe(1);
    expect(app.sections.readSectionContext("Sales desk")?.text).toContain("49 per seat");
    expect(result.groups).toEqual([expect.objectContaining({
      name: "Deal desk", section: "Sales desk", bulletin: expect.stringContaining("Cite sources"),
      defaultResponder: { kind: "member", botId: lead.id }, setupCompletedAt: expect.any(Number),
    })]);
    expect(result.groups[0]!.memberIds.sort()).toEqual(result.bots.map((bot) => bot.id).sort());
    expect(result.routines).toEqual([
      expect.objectContaining({ name: "Daily digest", botId: scout.id, enabled: false, nextRunAt: null, continuity: true, timeoutMinutes: 20 }),
      expect.objectContaining({ name: "Weekly pipeline review", target: "room-goal", groupId: result.groups[0]!.id, botId: lead.id, enabled: false }),
    ]);
    expect(app.skills.listSkills(scout.id)).toEqual([
      expect.objectContaining({ name: "pricing-policy", enabled: false, source: "package:sales-desk" }),
      expect.objectContaining({ name: "research-brief", enabled: false }),
    ]);
    expect(result.offeredSkills).toEqual(["objection-handling"]);
    // The slot never binds to the credentialed server already called "crm".
    expect(result.connections).toEqual([{ key: "crm", name: "crm-2", label: "CRM" }]);
    expect(app.mcp.servers["crm-2"]).toEqual({ type: "http", url: "https://mcp.example.com/crm", headers: { Authorization: "" }, enabled: false });
    expect(app.mcp.servers.crm).toMatchObject({ headers: { Authorization: "Bearer mine" } });
    expect(lead.mcpServers).toEqual(["crm-2"]);
    expect(byKey.get("writer")!.mcpServers).toBeUndefined();
    expect(app.workspace.readMemoryFile(lead.id).text).toContain("short summaries");
    expect(app.workspace.readMemoryTopic(lead.id, "pricing.md")).toContain("49 per seat");
    expect(result.notes).toBe(2);
    expect(result.brief).toBe(true);
    expect(result.skipped).toEqual([{ part: "presets[support]", reason: "presets_not_supported_yet" }]);
    expect(app.events.filter((kind) => kind === "bot")).toHaveLength(3);
  });

  it("imports the same file twice as two independent copies", async () => {
    const app = await installation();
    const document = app.parsePackageDocument(fixture("full-team.v2.json"));
    const first = app.importer.importPackageDocument(document, { trust: "file", mode: "add" }, app.deps);
    const second = app.importer.importPackageDocument(document, { trust: "file", mode: "add" }, app.deps);
    if (first.alreadyAdded || second.alreadyAdded) throw new Error("file imports are never 'already added'");
    expect(second.section).toBe("Sales desk 2");
    expect(second.bots[0]!.name).toBe("Morgan 2");
    expect(second.installId).not.toBe(first.installId);
    expect(second.connections[0]!.name).toBe("crm-2");
  });

  it("records a connection the organization's policy refuses and imports the rest", async () => {
    const app = await installation({ refuse: (name) => (name === "crm" ? "Not approved by Acme." : undefined) });
    const result = app.importer.importPackageDocument(app.parsePackageDocument(fixture("full-team.v2.json")), { trust: "file", mode: "add" }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    expect(result.skipped).toContainEqual({ part: "connections[crm]", reason: "connection_refused_by_policy" });
    expect(result.connections).toEqual([]);
    expect(app.mcp.servers).toEqual({});
    expect(result.bots).toHaveLength(3);
    expect(app.store.bot(result.bots.find((bot) => bot.installedPackage?.agentKey === "lead")!.id)!.mcpServers).toEqual([]);
  });

  it("leaves nothing behind when the last step fails", async () => {
    const app = await installation();
    const before = app.snapshot();
    const failing = { ...app.deps, sections: { writeBrief: () => { throw new Error("disk full"); } } };
    expect(() => app.importer.importPackageDocument(app.parsePackageDocument(fixture("full-team.v2.json")), { trust: "file", mode: "add" }, failing))
      .toThrow("disk full");
    expect(app.snapshot()).toBe(before);
    expect(app.sections.readSectionContext("Sales desk")).toBeNull();
  });

  it("refuses a library-only package with a pointer to the shelf, creating nothing", async () => {
    const app = await installation();
    const before = app.snapshot();
    expect(() => app.importer.importPackageDocument(app.parsePackageDocument(fixture("library-only.v2.json")), { trust: "file", mode: "add" }, app.deps))
      .toThrow(app.importer.NO_BOTS_MESSAGE);
    expect(app.snapshot()).toBe(before);
  });

  it("brings a run limit the routine store cannot hold into range and says so", async () => {
    const app = await installation();
    const input = fixture("full-team.v2.json");
    input.package.routines[0].timeoutMinutes = 600;
    const result = app.importer.importPackageDocument(app.parsePackageDocument(input), { trust: "file", mode: "add" }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    expect(result.routines[0]!.timeoutMinutes).toBe(240);
    expect(result.skipped).toContainEqual({ part: "routines[daily-digest].timeoutMinutes", reason: "run_limit_adjusted" });
  });

  it("switches skills on and stamps provenance only for the organization channel, once", async () => {
    const app = await installation();
    const document = app.parsePackageDocument({ ...fixture("full-team.v2.json") }, { trust: "org" });
    document.package.publisher = { organization: "acme", name: "Acme Partners" };
    const org = {
      adminOrigin: "https://admin.example.com", organizationId: "org-1", packageId: "pkg-1", ref: "acme/sales-desk", sha256: "a".repeat(64),
      publisher: { organizationId: "org-acme", slug: "acme", name: "Acme Partners" },
      installId: app.importer.orgInstallId("https://admin.example.com", "org-1", "pkg-1"),
    };
    const result = app.importer.importPackageDocument(document, { trust: "org", mode: "add", org }, app.deps);
    if (result.alreadyAdded) throw new Error("unexpected");
    const scout = result.bots.find((bot) => bot.installedPackage?.agentKey === "scout")!;
    expect(app.skills.listSkills(scout.id)).toEqual([
      expect.objectContaining({ name: "pricing-policy", enabled: true, source: "org:acme/sales-desk@1.3.0" }),
      expect.objectContaining({ name: "research-brief", enabled: true }),
    ]);
    expect(scout.installedPackage).toMatchObject({ source: "org", installId: org.installId, ref: "acme/sales-desk", sha256: org.sha256, publisher: org.publisher });
    expect(result.routines.every((routine) => !routine.enabled)).toBe(true);
    const bots = app.store.bots.length;
    expect(app.importer.importPackageDocument(document, { trust: "org", mode: "add", org }, app.deps)).toEqual({ alreadyAdded: true, installId: org.installId });
    expect(app.store.bots).toHaveLength(bots);
    expect(() => app.importer.importPackageDocument(document, { trust: "org", mode: "add", org: { ...org, installId: "f".repeat(32) } }, app.deps))
      .toThrow("install id");
    expect(() => app.importer.importPackageDocument(document, { trust: "org", mode: "add", org: { ...org, publisher: { ...org.publisher, slug: "other" } } }, app.deps))
      .toThrow("not published by the organization");
  });
});
