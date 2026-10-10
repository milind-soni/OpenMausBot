import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { canonicalJson, parsePackageDocument } from "../shared/package-format.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORG = "11111111-1111-4111-8111-111111111111";
const PUBLISHER = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "44444444-4444-4444-8444-444444444444";

function release(name: string) {
  const document: any = parsePackageDocument(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), { trust: "file" });
  document.package.publisher = { organization: "acme", name: "Acme Partners" };
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

// The recipe in docs/verification/org-library.md: a disposable fake-engine
// server, a catalog relayed the way Electron relays it, the release files
// where Electron stores them, then the renderer's routes.
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
    // No organization: nothing is visible and nothing can be added.
    expect(await call("GET", "/api/org-library")).toEqual({ status: 200, body: { organization: null, packages: [] } });
    expect((await call("POST", "/api/org-library/add", { packageId: TEAM_ID })).status).toBe(404);
    expect(await call("GET", "/api/org-library/skills")).toEqual({ status: 200, body: { organization: null, skills: [] } });
    // The relay route needs the fixture's key.
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

    // Stamps are server-private: never on bots, rooms or routines as clients see them.
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

    // Bot → Skills → From Customer Co: the team's unassigned skill, then the library's.
    const library = await call("POST", "/api/org-library/add", { packageId: LIBRARY_ID });
    expect(library.status).toBe(201);
    const offered = (await call("GET", `/api/org-library/skills?botId=${bots[0].id}`)).body;
    expect(offered.skills.map((skill: any) => skill.name)).toEqual(["objection-handling", "objection-handling", "follow-up"]);
    const put = await call("POST", "/api/org-library/skills", { botId: bots[0].id, installId: library.body.installId, name: "follow-up" });
    expect(put).toMatchObject({ status: 201, body: { skill: { name: "follow-up", enabled: true } } });

    // Signing out hides the shelf; what was added stays.
    await call("POST", "/api/testing/org-library", { library: null }, { "x-openmausbot-test-org-library": key });
    expect((await call("GET", "/api/org-library")).body).toEqual({ organization: null, packages: [] });
    expect((await call("GET", "/api/bots")).body.bots.filter((bot: any) => bot.section === "Sales desk")).toHaveLength(3);
  } finally {
    await fixture.close();
  }
}, 120_000);
