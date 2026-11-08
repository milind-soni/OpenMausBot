import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { canonicalJson, parsePackageDocument } from "../shared/package-format.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORG = "11111111-1111-4111-8111-111111111111";
const PUBLISHER = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "44444444-4444-4444-8444-444444444444";

function release(name: string, edit?: (document: any) => void) {
  const document: any = parsePackageDocument(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), { trust: "file" });
  document.package.publisher = { organization: "acme", name: "Acme Partners" };
  edit?.(document);
  const bytes = canonicalJson(document);
  return { document, bytes, sha256: sha(bytes) };
}

function entry(packageId: string, rel: ReturnType<typeof release>) {
  const pkg = rel.document.package;
  return {
    packageId, ref: `acme/${pkg.id}`, name: pkg.name, tagline: pkg.tagline, kind: pkg.agents.length ? "team" : "library",
    publisher: { organizationId: PUBLISHER, name: "Acme Partners", self: false }, mode: "available", offAction: "keep",
    release: { version: pkg.release, sha256: rel.sha256, sizeBytes: Buffer.byteLength(rel.bytes), formatVersion: 2, publishedAt: 1_700_000_000_000, notes: "" },
    withdrawnReleases: [],
    contents: { bots: pkg.agents.length, skills: pkg.skills?.entries.length ?? 0, presets: pkg.presets?.length ?? 0, rooms: pkg.rooms?.length ?? 0,
      routines: pkg.routines?.length ?? 0, connections: pkg.connections?.length ?? 0, botNames: pkg.agents.map((agent: any) => agent.name) },
    scanFindings: 0,
  };
}

it("shows the organization's shelf, adds a team once, and keeps its stamps off the wire", async () => {
  const key = randomBytes(32).toString("hex");
  const fixture = await launchVerificationServer({ ...process.env, OMB_TEST_ORG_LIBRARY_KEY: key });
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect(await call("GET", "/api/org-library")).toEqual({ status: 200, body: { organization: null, packages: [] } });
    expect((await call("POST", "/api/org-library/add", { packageId: TEAM_ID })).status).toBe(404);
    expect(await call("GET", "/api/org-library/skills")).toEqual({ status: 200, body: { organization: null, skills: [] } });
    expect((await call("POST", "/api/testing/org-library", { library: null }, { "x-openmausbot-test-org-library": "wrong".repeat(13) })).status).toBe(404);

    const team = release("full-team.v2.json");
    const skills = release("library-only.v2.json");
    const blobs = join(fixture.info.dataDir, "org-library", "blobs");
    mkdirSync(blobs, { recursive: true });
    for (const rel of [team, skills]) writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "openmaus.org-library", version: 1, libraryVersion: 1, organization: { id: ORG, name: "Customer Co" },
      packages: [entry(TEAM_ID, team), entry(LIBRARY_ID, skills)] });
    const relayed = await call("POST", "/api/testing/org-library", {
      library: { adminOrigin: "https://admin.example.com", organizationId: ORG, organizationName: "Customer Co", digest: sha(catalog), catalog },
    }, { "x-openmausbot-test-org-library": key });
    expect(relayed).toEqual({ status: 200, body: { ok: true, report: { type: "openmausbot:managed-library-state", digest: sha(catalog), packages: [] } } });

    const shelf = (await call("GET", "/api/org-library")).body;
    expect(shelf.organization).toEqual({ id: ORG, name: "Customer Co" });
    expect(shelf.packages.map((item: any) => [item.name, item.blob, item.installed])).toEqual([["Sales desk", "ready", null], ["Sales skills", "ready", null]]);
    const preview = await call("GET", `/api/org-library/packages/${TEAM_ID}`);
    expect(preview.status).toBe(200);
    expect(preview.body.document.package).toMatchObject({ id: "sales-desk", publisher: { organization: "acme" } });

    const added = await call("POST", "/api/org-library/add", { packageId: TEAM_ID });
    expect(added.status).toBe(201);
    expect(added.body.bots).toHaveLength(3);
    expect(added.body.section).toBe("Sales desk");
    const again = await call("POST", "/api/org-library/add", { packageId: TEAM_ID });
    expect(again).toEqual({ status: 200, body: { alreadyAdded: true, installId: added.body.installId } });

    const everything = JSON.stringify([(await call("GET", "/api/bots")).body, (await call("GET", "/api/routines")).body, added.body]);
    expect(everything).not.toContain("packageBase");
    expect(everything).not.toContain("memberKeys");
    const bots = (await call("GET", "/api/bots")).body.bots.filter((bot: any) => bot.section === "Sales desk");
    expect(bots).toHaveLength(3);
    for (const bot of bots) {
      expect(bot.installedPackage).toMatchObject({ source: "org", ref: "acme/sales-desk", publisher: { name: "Acme Partners" } });
      const listed = (await call("GET", `/api/bots/${bot.id}/skills`)).body.skills as Array<{ enabled: boolean }>;
      expect(listed.every((skill) => skill.enabled)).toBe(true);
    }
    expect((await call("GET", "/api/routines")).body.routines.every((routine: any) => !routine.enabled)).toBe(true);
    const state = JSON.parse(readFileSync(join(fixture.info.dataDir, "org-library", "state.json"), "utf8"));
    expect(state.installs[added.body.installId]).toMatchObject({ packageId: TEAM_ID, status: "installed", section: "Sales desk" });

    const library = await call("POST", "/api/org-library/add", { packageId: LIBRARY_ID });
    expect(library.status).toBe(201);
    const offered = (await call("GET", `/api/org-library/skills?botId=${bots[0].id}`)).body;
    expect(offered.skills.map((skill: any) => skill.name)).toEqual(["objection-handling", "objection-handling", "follow-up"]);
    const put = await call("POST", "/api/org-library/skills", { botId: bots[0].id, installId: library.body.installId, name: "follow-up" });
    expect(put).toMatchObject({ status: 201, body: { skill: { name: "follow-up", enabled: true } } });

    await call("POST", "/api/testing/org-library", { library: null }, { "x-openmausbot-test-org-library": key });
    expect((await call("GET", "/api/org-library")).body).toEqual({ organization: null, packages: [] });
    expect((await call("GET", "/api/bots")).body.bots.filter((bot: any) => bot.section === "Sales desk")).toHaveLength(3);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("brings an added team to a newer release, keeping what the person changed", async () => {
  const key = randomBytes(32).toString("hex");
  const fixture = await launchVerificationServer({ ...process.env, OMB_TEST_ORG_LIBRARY_KEY: key });
  const url = fixture.info.url;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const blobs = join(fixture.info.dataDir, "org-library", "blobs");
  const offer = async (rel: ReturnType<typeof release>, libraryVersion: number) => {
    mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "openmaus.org-library", version: 1, libraryVersion, organization: { id: ORG, name: "Customer Co" }, packages: [entry(TEAM_ID, rel)] });
    const relayed = await call("POST", "/api/testing/org-library", {
      library: { adminOrigin: "https://admin.example.com", organizationId: ORG, organizationName: "Customer Co", digest: sha(catalog), catalog },
    }, { "x-openmausbot-test-org-library": key });
    expect(relayed.status).toBe(200);
    return relayed.body.report;
  };
  try {
    await offer(release("full-team.v2.json"), 1);
    const added = await call("POST", "/api/org-library/add", { packageId: TEAM_ID });
    expect(added.status).toBe(201);
    const bots = async () => (await call("GET", "/api/bots")).body.bots.filter((bot: any) => bot.section === "Sales desk");
    const byKey = async (agentKey: string) => (await bots()).find((bot: any) => bot.installedPackage.agentKey === agentKey);
    const scout = await byKey("scout");
    expect((await call("PATCH", `/api/bots/${scout.id}`, { soul: "Scout the way we like it." })).status).toBe(200);

    const next = release("full-team.v2.json", (document) => {
      document.package.release = "1.4.0";
      for (const agent of document.package.agents) agent.soul = `${agent.soul} Version two.`;
    });
    const report = await offer(next, 2);
    expect(report.packages).toEqual([{ packageId: TEAM_ID, release: "1.4.0", sha256: next.sha256, state: "installed" }]);
    expect((await byKey("lead")).soul).toMatch(/Version two\.$/);
    expect((await byKey("scout")).soul).toBe("Scout the way we like it.");
    expect((await byKey("lead")).installedPackage).toMatchObject({ release: "1.4.0", sha256: next.sha256 });
    expect(JSON.stringify((await call("GET", "/api/bots")).body)).not.toContain("packageBase");
    expect((await call("GET", "/api/routines")).body.routines.every((routine: any) => !routine.enabled)).toBe(true);
    const shelf = (await call("GET", "/api/org-library")).body.packages[0];
    expect(shelf.installed).toMatchObject({ release: "1.4.0", status: "installed" });
  } finally {
    await fixture.close();
  }
}, 120_000);

it("keeps an active task's skill available and retries the organization update after its turn", async () => {
  const key = randomBytes(32).toString("hex");
  const fixture = await launchVerificationServer({ ...process.env, OMB_TEST_ORG_LIBRARY_KEY: key, FAKE_CLAUDE_MODE: "hang" });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const offer = async (rel: ReturnType<typeof release>, version: number) => {
    const blobs = join(fixture.info.dataDir, "org-library", "blobs"); mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "openmaus.org-library", version: 1, libraryVersion: version,
      organization: { id: ORG, name: "Customer Co" }, packages: [entry(TEAM_ID, rel)] });
    return call("POST", "/api/testing/org-library", { library: { adminOrigin: "https://admin.example.com", organizationId: ORG,
      organizationName: "Customer Co", digest: sha(catalog), catalog } }, { "x-openmausbot-test-org-library": key });
  };
  try {
    await offer(release("full-team.v2.json"), 1);
    const added = await call("POST", "/api/org-library/add", { packageId: TEAM_ID });
    expect(added.status).toBe(201);
    const bots = async () => (await call("GET", "/api/bots")).body.bots as any[];
    const lead = (await bots()).find((bot) => bot.installedPackage?.agentKey === "lead")!;
    await runControlOmb(["send", "--url", fixture.info.url, "--bot", lead.id, "--text", "Stay active."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const taskSkill = join(fixture.info.dataDir, "task-workspaces", lead.id, lead.threadId, ".claude", "skills", "pricing-policy", "SKILL.md");
    const original = readFileSync(taskSkill, "utf8");
    const next = release("full-team.v2.json", (document) => {
      document.package.release = "1.4.0";
      document.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += "\nNew reviewed release.";
    });
    const deferred = await offer(next, 2);
    expect(deferred.body.report.packages[0].release).toBe("1.3.0");
    expect(readFileSync(taskSkill, "utf8")).toBe(original);
    await runControlOmb(["interrupt", "--url", fixture.info.url, "--bot", lead.id]);
    await expect.poll(async () => (await bots()).find((bot) => bot.id === lead.id)?.busy, { timeout: 30_000 }).toBe(false);
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.info.dataDir, "org-library", "state.json"), "utf8"))
      .installs[added.body.installId].release, { timeout: 30_000 }).toBe("1.4.0");
    expect(readFileSync(taskSkill, "utf8")).toBe(original);
  } finally { await fixture.close(); }
}, 120_000);

it("waits for another bot using an organization's workspace before replacing its skill", async () => {
  const key = randomBytes(32).toString("hex");
  const fixture = await launchVerificationServer({ OMB_TEST_ORG_LIBRARY_KEY: key, FAKE_CLAUDE_MODE: "hang" });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const offer = async (rel: ReturnType<typeof release>, version: number) => {
    const blobs = join(fixture.info.dataDir, "org-library", "blobs"); mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "openmaus.org-library", version: 1, libraryVersion: version,
      organization: { id: ORG, name: "Customer Co" }, packages: [entry(TEAM_ID, rel)] });
    return call("POST", "/api/testing/org-library", { library: { adminOrigin: "https://admin.example.com", organizationId: ORG,
      organizationName: "Customer Co", digest: sha(catalog), catalog } }, { "x-openmausbot-test-org-library": key });
  };
  const next = (version: string) => release("full-team.v2.json", (document) => {
    document.package.release = version;
    document.package.skills.entries.find((skill: any) => skill.name === "pricing-policy").instructions += `\nReviewed ${version}.`;
  });
  try {
    await offer(release("full-team.v2.json"), 1);
    const added = await call("POST", "/api/org-library/add", { packageId: TEAM_ID });
    const bots = async () => (await call("GET", "/api/bots?messages=0")).bots as any[];
    const lead = (await bots()).find((bot) => bot.installedPackage?.agentKey === "lead")!;
    const other = (await call("POST", "/api/bots", { name: "Workspace visitor", useDefaults: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot;
    const root = join(fixture.info.dataDir, "workspaces", lead.id), skill = join(root, ".claude", "skills", "pricing-policy", "SKILL.md");
    const alias = join(fixture.info.dataDir, "workspace-alias"), otherFolder = join(fixture.info.dataDir, "other-project");
    if (process.platform !== "win32") { symlinkSync(root, alias); mkdirSync(otherFolder); }
    const installedRelease = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "org-library", "state.json"), "utf8")).installs[added.installId].release;
    const room = (await call("POST", "/api/groups", { name: "Shared skill fixture", memberIds: [other.id] })).group;
    await call("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", cwd: process.platform === "win32" ? root : alias, bulletin: "", defaultResponder: { kind: "everyone" } });
    await call("POST", `/api/groups/${room.id}/messages`, { text: "Use this workspace." });
    await expect.poll(() => existsSync(fixture.fixtureDumpPath) && JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).cwd === root, { timeout: 30_000 }).toBe(true);
    if (process.platform !== "win32") { unlinkSync(alias); symlinkSync(otherFolder, alias); }
    expect((await offer(next("1.4.0"), 2)).report.packages[0].release).toBe("1.3.0");
    expect(readFileSync(skill, "utf8")).not.toContain("Reviewed 1.4.0.");
    await call("POST", `/api/groups/${room.id}/interrupt`, {});
    await expect.poll(installedRelease, { timeout: 30_000 }).toBe("1.4.0");
    expect(readFileSync(skill, "utf8")).toContain("Reviewed 1.4.0.");

    await expect.poll(async () => (await bots()).find((bot) => bot.id === other.id)?.busy, { timeout: 30_000 }).toBe(false);
    rmSync(fixture.fixtureDumpPath, { force: true });
    await call("PATCH", `/api/bots/${other.id}`, { cwd: root });
    await call("POST", `/api/bots/${other.id}/messages`, { text: "Use the shared workspace directly." });
    await expect.poll(() => existsSync(fixture.fixtureDumpPath) && JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).cwd === root, { timeout: 30_000 }).toBe(true);
    expect((await offer(next("1.5.0"), 3)).report.packages[0].release).toBe("1.4.0");
    expect(readFileSync(skill, "utf8")).not.toContain("Reviewed 1.5.0.");
    await call("POST", `/api/bots/${other.id}/interrupt`, {});
    await expect.poll(installedRelease, { timeout: 30_000 }).toBe("1.5.0");
    expect(readFileSync(skill, "utf8")).toContain("Reviewed 1.5.0.");
  } finally { await fixture.close(); }
}, 180_000);

