import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { launchRestartableServer, type RestartableServer } from "../testing/restartable-server.ts";

type Rec = Record<string, any>;
const ACME = join(import.meta.dirname, "..", "testing", "fixtures", "profiles", "acme");
const posixOnly = describe.skipIf(process.platform === "win32");

let server: RestartableServer;
let scratch: string;
let folder: string;
const tokens: Record<string, string> = {};

async function api(method: string, path: string, body?: unknown, as?: string): Promise<{ status: number; body: Rec }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Rec };
}
const profileBots = async () => ((await api("GET", "/api/bots?messages=0")).body.bots as Rec[]).filter((bot) => bot.profileSource);
const analyst = async () => (await profileBots()).find((bot) => bot.profileSource.key === "analyst");

posixOnly("profile apply routes", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-profiles-apply-"));
    folder = join(scratch, "acme");
    cpSync(ACME, folder, { recursive: true });
    server = await launchRestartableServer();
    await server.stop();
    const registry = new SessionRegistry({ file: join(server.dataDir, "sessions.json"), emailScopes: () => ["client"] });
    tokens.admin = registry.issue({ label: "Owner's laptop", scopes: ["admin", "client"] }).token;
    tokens.member = registry.issue({ label: "Phone", scopes: ["client"] }).token;
    registry.close();
    await server.start();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    if (scratch) await removeTempDir(scratch);
  });

  it("keeps the chosen folder, and refuses one that is relative, missing or inside the data folder", async () => {
    expect((await api("GET", "/api/profiles")).body).toEqual({ areas: {} });
    expect((await api("PUT", "/api/profiles/folder", { folder: "acme" })).status).toBe(400);
    expect((await api("PUT", "/api/profiles/folder", { folder: join(scratch, "missing") })).status).toBe(400);
    expect((await api("PUT", "/api/profiles/folder", { folder: join(server.dataDir, "profiles") })).body.error).toBe("A profile folder cannot be inside this app's data folder.");
    cpSync(ACME, join(server.dataDir, "acme"), { recursive: true });
    symlinkSync(join(server.dataDir, "acme"), join(scratch, "into-data"));
    expect((await api("PUT", "/api/profiles/folder", { folder: join(scratch, "into-data") })).body.error).toBe("A profile folder cannot be inside this app's data folder.");
    expect((await api("POST", "/api/profiles/plan", { folder: join(scratch, "into-data") })).status).toBe(400);
    expect((await api("GET", "/api/profiles")).body).toEqual({ areas: {} });
    expect((await api("POST", "/api/profiles/plan", {})).body.error).toBe("Choose a profile folder first.");
    const chosen = await api("PUT", "/api/profiles/folder", { folder });
    expect(chosen).toEqual({ status: 200, body: { folder, areas: {} } });
    expect((await api("PUT", "/api/profiles/folder", { folder }, "member")).status).toBe(403);
  });

  it("plans the chosen folder without changing anything", async () => {
    const plan = await api("POST", "/api/profiles/plan", {});
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ folder, organization: "Acme", noChanges: false, problems: [], counts: { add: 7, access: 1, later: 4 } });
    expect(plan.body.commit).toBeUndefined();
    expect(plan.body.lines.filter((line: Rec) => line.kind === "access").map((line: Rec) => line.text)).toEqual(["Analista BI: Edu crew on"]);
    expect(await profileBots()).toEqual([]);
  });

  it("refuses more access from a program on this computer, and applies nothing", async () => {
    const refused = await api("POST", "/api/profiles/apply", { giveAccess: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("These changes give bots more access, so they have to be confirmed from the desktop app or a paired admin device.");
    expect(refused.body.lines.map((line: Rec) => line.text)).toEqual(["Analista BI: Edu crew on"]);
    expect(await profileBots()).toEqual([]);
    expect((await api("POST", "/api/profiles/apply", { giveAccess: true }, "member")).status).toBe(403);
    expect(await profileBots()).toEqual([]);
  });

  it("refuses a plan that is no longer the one the person saw", async () => {
    const stale = await api("POST", "/api/profiles/apply", { expect: "0".repeat(32) });
    expect(stale.status).toBe(409);
    expect(stale.body.plan.counts.add).toBe(7);
    expect(await profileBots()).toEqual([]);
  });

  it("refuses a plan whose files changed since, even when every line reads the same", async () => {
    const plan = (await api("POST", "/api/profiles/plan", {})).body;
    const file = join(folder, "areas", "bi", "bots", "analyst.md");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("Check every number against its source", "Send every number without checking"));
    try {
      const stale = await api("POST", "/api/profiles/apply", { expect: plan.digest });
      expect(stale.status).toBe(409);
      expect(stale.body.plan.lines).toEqual(plan.lines);
      expect(stale.body.plan.digest).not.toBe(plan.digest);
      expect(await profileBots()).toEqual([]);
    } finally {
      writeFileSync(file, text);
    }
  });

  it("applies the rest without the more-access lines, then those from an admin session", async () => {
    const plan = (await api("POST", "/api/profiles/plan", {})).body;
    const applied = await api("POST", "/api/profiles/apply", { expect: plan.digest });
    expect(applied.status).toBe(200);
    expect(applied.body.applied.skipped).toEqual([expect.objectContaining({ text: "Analista BI: Edu crew on", reason: expect.stringContaining("desktop app or a paired admin device") })]);
    expect((await profileBots()).map((bot) => bot.name).sort()).toEqual(["Analista BI", "Closer", "Reporter"]);
    expect(await analyst()).toMatchObject({ section: "BI", chiefOfStaff: true, approvalMode: "auto" });
    expect((await analyst())!.eduCrew).not.toBe(true);
    expect((await api("GET", "/api/sidebar-sections")).body.sections).toEqual(["BI", "Sales"]);

    const again = (await api("POST", "/api/profiles/plan", {})).body;
    expect(again.lines.filter((line: Rec) => ["add", "change", "access", "conflict"].includes(line.kind)).map((line: Rec) => line.text))
      .toEqual(["Analista BI: Edu crew off → on"]);
    const confirmed = await api("POST", "/api/profiles/apply", { giveAccess: true, expect: again.digest }, "admin");
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.applied).toEqual({ lines: [expect.objectContaining({ text: "Analista BI: Edu crew off → on" })], skipped: [] });
    expect((await analyst())!.eduCrew).toBe(true);
    expect((await api("POST", "/api/profiles/plan", {})).body.noChanges).toBe(true);
  });

  it("records each apply in the admin activity log and the applied state", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rows = (await api("GET", "/api/admin-activity?what=profile", undefined, "admin")).body.entries as Rec[];
    expect(rows.map((row) => row.action)).toEqual(["profile.apply", "profile.apply"]);
    expect(rows.find((row) => row.changed?.includes("bi/analyst.eduCrew") && row.changed.length === 1)).toBeTruthy();
    expect(rows.find((row) => row.changed?.includes("sales/closer.approval"))?.after).toMatchObject({ folder });
    const status = (await api("GET", "/api/profiles")).body;
    expect(status).toMatchObject({ folder, applied: { folder, digest: expect.any(String) }, areas: { bi: { section: "BI" }, sales: { section: "Sales" } } });
  });

  it("follows a department renamed in the app, so the next plan keeps it instead of making another", async () => {
    expect((await api("PATCH", "/api/sidebar-sections?section=BI", { name: "Analytics" })).status).toBe(200);
    expect((await api("GET", "/api/profiles")).body.areas.bi).toEqual({ section: "Analytics" });
    const plan = (await api("POST", "/api/profiles/plan", {})).body;
    expect(plan.lines.filter((line: Rec) => line.kind === "add")).toEqual([]);
    expect(plan.lines.filter((line: Rec) => line.kind === "changed-here").map((line: Rec) => line.text)).toEqual(["Area BI: its department was renamed here to Analytics, so that name is kept"]);
    expect((await api("GET", "/api/sidebar-sections")).body.sections).toEqual(["Analytics", "Sales"]);
  });
});
