import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteAccessPaths, startTeamPolicyClient, TEAM_POLICY_ADMIN_PATH, TEAM_POLICY_FILE, TEAM_POLICY_FRESH_MS, TEAM_POLICY_REFRESH_MS, teamManagedPolicy, teamPolicyDocumentSchema, teamPolicyFingerprint, teamPolicySignature, type TeamPolicyClient } from "./cloud-team-policy.ts";
import { ManagedDesktopPolicy, type ManagedPolicy } from "./managed-policy.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";

const TEAM = { id: "11111111-1111-4111-8111-111111111111", name: "Acme" };
const doc = (limits: Record<string, unknown>) => ({ schema: 1, limits });
const answer = (document: unknown, version = 1) => Response.json({ policy: { version, fingerprint: teamPolicyFingerprint(document), document } });

const dirs: string[] = [], clients: TeamPolicyClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.stop(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(fetchImpl: (body: { loaded: { fingerprint: string } | null; problem: string | null }, init: RequestInit, url: string) => Response | Promise<Response>, options: { dataDir?: string; now?: () => number } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omb-team-policy-"));
  if (!options.dataDir) dirs.push(dataDir);
  const applied: (ManagedPolicy | null)[] = [], logs: string[] = [], timers: { run: () => void; ms: number }[] = [], reports: { loaded: { fingerprint: string } | null; problem: string | null }[] = [];
  const client = startTeamPolicyClient({
    team: TEAM, machineId: "cm-test-home", adminOrigin: "https://cloud.example.test", secret: "s".repeat(43), dataDir, random: () => 0,
    apply: (policy) => { applied.push(policy); }, log: (line) => logs.push(line), ...(options.now ? { now: options.now } : {}),
    setTimer: (run, ms) => { const timer = { run, ms, unref() {} }; timers.push(timer); return timer; }, clearTimer: (timer) => { timers.splice(timers.indexOf(timer as never), 1); },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      reports.push(body);
      return fetchImpl(body, init, url);
    }) as typeof fetch,
  });
  clients.push(client);
  return { client, dataDir, applied, logs, timers, reports };
}

describe("the document", () => {
  it("computes the fingerprint and signature exactly as openmaus-cloud's server/cloud-team-policy.ts does", () => {
    // The same vectors are pinned in openmaus-cloud tests/cloud-team-policy.test.ts.
    expect(teamPolicyFingerprint({ schema: 1, limits: { remoteAccess: "off", allowedEngines: ["claudeAgent", "codex"] } })).toBe("8341e89f9d7fc734");
    expect(teamPolicyFingerprint({ limits: { allowedEngines: ["claudeAgent", "codex"], remoteAccess: "off" }, schema: 1 })).toBe("8341e89f9d7fc734");
    expect(teamPolicySignature("s".repeat(43), "cm-test-home", "1792670400", "nonce-nonce-nonce-1", '{"v":1,"loaded":null,"problem":null}')).toBe("ZNkIYIIuPldLp7gQ4cy7s1zQJpBiWkyP8DOyRtRz03w");
  });

  it("accepts explicitly permissive values, and refuses a key it can't enforce", () => {
    expect(teamPolicyDocumentSchema.safeParse(doc({ allowedEngines: "all", allowedApps: "all", allowedMcpServers: "all", allowedComputers: "all", remoteAccess: "allowed", requireFreshPolicy: false })).success).toBe(true);
    expect(teamPolicyDocumentSchema.safeParse(doc({ somethingNew: 1 })).success).toBe(false);
    expect(teamPolicyDocumentSchema.safeParse({ schema: 2, limits: {} }).success).toBe(false);
  });

  it("restricting nothing is no policy at all, whichever way it is said", () => {
    expect(teamManagedPolicy(teamPolicyDocumentSchema.parse(doc({})), TEAM, 1)).toBeNull();
    expect(teamManagedPolicy(teamPolicyDocumentSchema.parse(doc({ allowedEngines: "all", allowedApps: "all", allowedMcpServers: "all", allowedComputers: "all", remoteAccess: "allowed", requireFreshPolicy: false })), TEAM, 1)).toBeNull();
  });

  it("projects into the one strict shape every refusal reads, which never lapses and is never company-only", () => {
    const policy = teamManagedPolicy(teamPolicyDocumentSchema.parse(doc({ allowedEngines: ["codex"], allowedApps: ["gmail"], allowedMcpServers: ["orders"], allowedComputers: ["vps"], remoteAccess: "off", requireFreshPolicy: true })), TEAM, 4)!;
    expect(policy).toEqual({ organizationId: TEAM.id, organizationName: "Acme", expiresAt: null, version: 4, companyModelsOnly: false, allowedEngines: ["codex"],
      mcp: { allowCustom: false, allowlist: ["orders"] }, apps: { allowAll: false, allowlist: ["gmail"] }, computers: { thisComputer: false, localVm: false, box: false, vps: true }, remoteAccess: false, team: { requireFresh: true, ownMcpOnly: false } });
    const managed = new ManagedDesktopPolicy();
    managed.apply(policy);
    expect(managed.current()).not.toBeNull();
    managed.close();
  });

  it("on a Team Cloud, the pairing every member's app uses is never remote access; off a team it still is", () => {
    expect(remoteAccessPaths(true)).not.toContain("/api/auth/pair");
    expect(remoteAccessPaths(true)).toEqual(expect.arrayContaining(["/api/auth/pairing", "/api/team/phone-pairing"]));
    expect(remoteAccessPaths(false)).toEqual(expect.arrayContaining(["/api/auth/pair", "/api/pair", "/api/auth/pairing", "/api/auth/email/start", "/api/auth/email/verify"]));
  });

  it("no backup carries the kept rules", () => {
    expect(excludedWorkspaceAuthPath(TEAM_POLICY_FILE)).toBe(true);
    expect(excludedWorkspaceAuthPath(`${TEAM_POLICY_FILE}.123.aa-bb.tmp`)).toBe(true);
  });
});

describe("the fetch", () => {
  it("signs its request, applies the rules, keeps them 0600 and reports them in force at once", async () => {
    const document = doc({ allowedEngines: ["codex"] });
    const { client, applied, dataDir, reports, timers } = world((_body, init, url) => {
      expect(url).toBe(`https://cloud.example.test${TEAM_POLICY_ADMIN_PATH}`);
      expect(init.redirect).toBe("error");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-omb-cloud-signature"]).toBe(`v1=${teamPolicySignature("s".repeat(43), "cm-test-home", headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, String(init.body))}`);
      return answer(document);
    });
    await client.settled();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ organizationName: "Acme", allowedEngines: ["codex"], expiresAt: null });
    expect(reports.map((report) => report.loaded?.fingerprint ?? null)).toEqual([null, teamPolicyFingerprint(document)]);
    const file = join(dataDir, TEAM_POLICY_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ teamId: TEAM.id, version: 1, document });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(timers.map((timer) => timer.ms)).toEqual([TEAM_POLICY_REFRESH_MS]);
  });

  it("a change applies with no restart: at the next timer, or at once when nudged", async () => {
    let document = doc({ allowedEngines: ["codex"] });
    const { client, applied, timers } = world(() => answer(document));
    await client.settled();
    document = doc({ allowedEngines: ["claudeAgent"] });
    timers.pop()!.run();
    await client.settled();
    expect(applied.at(-1)).toMatchObject({ allowedEngines: ["claudeAgent"] });
    document = doc({ allowedEngines: ["grokAgent"] });
    client.nudge();
    await client.settled();
    expect(applied.at(-1)).toMatchObject({ allowedEngines: ["grokAgent"] });
  });

  it("a kept copy applies before any answer, and an Admin that can't be reached never lapses it", async () => {
    const document = doc({ allowedEngines: ["codex"] }), good = world(() => answer(document));
    await good.client.settled();
    good.client.stop();
    for (const failure of [() => { throw new TypeError("fetch failed"); }, () => new Response("down", { status: 503 }), () => new Response(null, { status: 401, headers: { "content-type": "application/json" } }), () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }), () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } })]) {
      const down = world(failure, { dataDir: good.dataDir });
      expect(down.applied).toHaveLength(1);
      expect(down.applied[0]).toMatchObject({ allowedEngines: ["codex"] });
      await down.client.settled();
      expect(down.applied).toHaveLength(1);
      expect(existsSync(join(good.dataDir, TEAM_POLICY_FILE))).toBe(true);
      down.client.stop();
    }
  });

  it("another team's copy, or a copy that fails validation, is ignored", async () => {
    const document = doc({ allowedEngines: ["codex"] }), good = world(() => answer(document));
    await good.client.settled();
    good.client.stop();
    const file = join(good.dataDir, TEAM_POLICY_FILE), kept = JSON.parse(readFileSync(file, "utf8"));
    for (const copy of [{ ...kept, teamId: "someone-else" }, { ...kept, document: doc({}) }, { ...kept, document: doc({ somethingNew: 1 }) }, "not json at all"]) {
      writeFileSync(file, typeof copy === "string" ? copy : JSON.stringify(copy));
      const later = world(() => new Response("down", { status: 503 }), { dataDir: good.dataDir });
      await later.client.settled();
      expect(later.applied).toEqual([]);
      later.client.stop();
    }
  });

  it("an unknown schema or a failed validation never crashes it: it keeps the last good rules and reports why, once", async () => {
    let body: () => Response = () => answer(doc({ allowedEngines: ["codex"] }));
    const { client, applied, reports } = world(() => body());
    await client.settled();
    const good = applied.length;
    body = () => answer({ schema: 2, limits: {}, settings: {} }, 2);
    client.nudge();
    await client.settled();
    expect(applied).toHaveLength(good);
    expect(client.status()).toMatchObject({ fingerprint: teamPolicyFingerprint(doc({ allowedEngines: ["codex"] })), problem: "rules of a newer kind (schema 2)" });
    expect(reports.at(-1)).toMatchObject({ problem: "rules of a newer kind (schema 2)" });
    body = () => answer(doc({ somethingNew: 1 }), 3);
    client.nudge();
    await client.settled();
    expect(reports.at(-1)?.problem).toMatch(/limits\.somethingNew can't be read/);
    // A document that doesn't match its fingerprint is no better.
    body = () => Response.json({ policy: { version: 4, fingerprint: "0".repeat(16), document: doc({}) } });
    client.nudge();
    await client.settled();
    expect(applied).toHaveLength(good);
    expect(reports.at(-1)?.problem).toMatch(/fingerprint/);
    // A good one again clears it.
    body = () => answer(doc({ allowedEngines: ["claudeAgent"] }), 5);
    client.nudge();
    await client.settled();
    expect(client.status().problem).toBeNull();
    expect(applied.at(-1)).toMatchObject({ allowedEngines: ["claudeAgent"] });
  });

  it("the Admin's word that there are none, a null or a JSON 404, lifts them and forgets the copy", async () => {
    for (const none of [() => Response.json({ policy: null }), () => Response.json({ error: "Not found." }, { status: 404 })]) {
      let body: () => Response = () => answer(doc({ allowedEngines: ["codex"] }));
      const { client, applied, dataDir } = world(() => body());
      await client.settled();
      body = none;
      client.nudge();
      await client.settled();
      expect(applied.at(-1)).toBeNull();
      expect(existsSync(join(dataDir, TEAM_POLICY_FILE))).toBe(false);
    }
  });

  it("a Cloud with no rules and an older Admin behaves as it always did", async () => {
    const { client, applied, reports } = world(() => Response.json({ error: "Not found." }, { status: 404 }));
    await client.settled();
    expect(applied).toEqual([null]);
    expect(reports).toHaveLength(1);
  });

  it("fresh: only while the Admin confirmed lately; a stale read asks again, at most so often", async () => {
    let at = 1_000_000, up = true;
    const { client, reports } = world(() => up ? answer(doc({ requireFreshPolicy: true })) : new Response("down", { status: 503 }), { now: () => at });
    await client.settled();
    expect(client.fresh()).toBe(true);
    at += TEAM_POLICY_FRESH_MS;
    expect(client.fresh()).toBe(true);
    up = false;
    at += 1;
    const before = reports.length;
    expect(client.fresh()).toBe(false);
    expect(client.fresh()).toBe(false);
    await client.settled();
    expect(reports.length).toBe(before + 1);
    up = true;
    at += 30_000;
    expect(client.fresh()).toBe(false);
    await client.settled();
    expect(client.fresh()).toBe(true);
  });
});

describe("the managed policy with a team's rules", () => {
  const managedWith = (limits: Record<string, unknown>) => {
    const managed = new ManagedDesktopPolicy();
    managed.apply(teamManagedPolicy(teamPolicyDocumentSchema.parse(doc(limits)), TEAM, 1));
    return managed;
  };
  it("never lapses, however long the Cloud runs", () => {
    vi.useFakeTimers();
    try {
      const managed = managedWith({ allowedEngines: ["codex"] });
      vi.advanceTimersByTime(400 * 86_400_000);
      expect(managed.current()).not.toBeNull();
      expect(managed.modelRefusal({ driverKind: "claudeAgent", displayName: "Claude" }, false)).toBeDefined();
      managed.close();
    } finally { vi.useRealTimers(); }
  });
  it("each refusal names the team and says to ask an admin", () => {
    const managed = managedWith({ allowedEngines: ["codex"], allowedApps: ["gmail"], allowedMcpServers: ["orders"], allowedComputers: ["vps"], remoteAccess: "off" });
    expect(managed.modelRefusal({ driverKind: "claudeAgent", displayName: "Claude" }, false)).toBe("Acme does not allow the Claude engine. Choose another model for this bot, or ask a team admin.");
    expect(managed.mcpRefusal("other")).toBe("Acme allows only MCP servers it has approved. Ask a team admin to add this one.");
    expect(managed.computerRefusal("box")).toBe("Acme does not allow bots to use cloud computers. Ask a team admin.");
    expect(managed.remoteAccessRefusal()).toBe("Acme does not allow opening this Cloud on a phone or with a link. Ask a team admin.");
    expect(managed.appRefusal("google_sheets")).toBe("Acme does not allow bots to use Google Sheets. Ask a team admin.");
    for (const line of [managed.modelRefusal({ driverKind: "claudeAgent", displayName: "Claude" }, false)!, managed.computerRefusal("thisComputer")!, managed.remoteAccessRefusal()!]) {
      expect(line.length).toBeLessThanOrEqual(160);
      expect(line).not.toMatch(/\bserver\b/i);
    }
    managed.close();
  });
  it("apps: a tool runs only for an allowed app, a batch is refused whole, code that could reach any app is refused, and a longer slug isn't captured", () => {
    const managed = managedWith({ allowedApps: ["gmail", "bland"] });
    expect(managed.appsCallRefusal([{ slug: "GMAIL_SEND_EMAIL" }])).toBeUndefined();
    expect(managed.appsCallRefusal([{ slug: "GMAIL_SEND_EMAIL" }, { slug: "SLACK_POST" }])).toMatch(/does not allow bots to use Slack/);
    expect(managed.appsCallRefusal([{ slug: "COMPOSIO_PROXY_EXECUTE" }])).toMatch(/can't run code/);
    expect(managed.appsCallRefusal([{ slug: "BLAND_AI_CALL" }], ["bland_ai"])).toMatch(/Bland Ai/);
    expect(managed.appsCallRefusal([{ slug: "BLAND_CALL" }], ["bland_ai"])).toBeUndefined();
    expect(managed.appsConnectRefusal(["gmail", "notion"])).toMatch(/Notion/);
    expect(managed.appAllowed("email")).toBe(false);
    managed.close();
    const open = managedWith({ allowedEngines: ["codex"] });
    expect(open.appsCallRefusal([{ slug: "SLACK_POST" }, { slug: "COMPOSIO_PROXY_EXECUTE" }])).toBeUndefined();
    expect(open.appAllowed("slack")).toBe(true);
    open.close();
  });
  it("only the team's own servers: what an admin adds stays, a bot's own doesn't start, and a bot can't add one", () => {
    const managed = managedWith({ allowedMcpServers: "team" });
    expect(managed.summary()!.mcp).toEqual({ allowCustom: true, allowlist: [] });
    expect(managed.mcpRefusal("orders", "https://mcp.example.com")).toBeUndefined();
    expect(managed.restrictsMcp()).toBe(true);
    expect(Object.keys(managed.filterMcp({ orders: { url: "https://mcp.example.com" }, mine: { command: "mine", bot: "b1" } }))).toEqual(["orders"]);
    expect(managed.botMcpRefusal()).toBe("Acme uses only the MCP servers its admins add. Ask a team admin.");
    managed.close();
    const open = managedWith({ allowedEngines: ["codex"] });
    expect(open.botMcpRefusal()).toBeUndefined();
    expect(Object.keys(open.filterMcp({ mine: { command: "mine", bot: "b1" } }))).toEqual(["mine"]);
    open.close();
  });
  it("requires fresh rules only of a team that said so", () => {
    const required = managedWith({ requireFreshPolicy: true });
    required.setFreshness(() => false);
    expect(required.modelRefusal({ driverKind: "claudeAgent" }, false)).toMatch(/^Acme requires up-to-date rules/);
    required.setFreshness(() => true);
    expect(required.modelRefusal({ driverKind: "claudeAgent" }, false)).toBeUndefined();
    required.close();
    const not = managedWith({ allowedEngines: ["claudeAgent"] });
    not.setFreshness(() => false);
    expect(not.modelRefusal({ driverKind: "claudeAgent" }, false)).toBeUndefined();
    not.close();
  });
  it("the renderer's view says it is a team's, and holds no id or date", () => {
    const managed = managedWith({ allowedEngines: ["codex"] });
    const summary = managed.summary()!;
    expect(summary.team).toBe(true);
    expect(summary).not.toHaveProperty("organizationId");
    expect(summary).not.toHaveProperty("expiresAt");
    managed.close();
  });
});
