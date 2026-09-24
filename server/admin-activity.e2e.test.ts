// The admin activity log through the real server: an admin session (Boss)
// and the owner on this machine change settings, people, keys, budgets, MCP
// servers, webhooks, bots, a bot's audience and sessions; each change lands
// in <data>/admin-activity/YYYY-MM.ndjson naming who acted, what changed
// and the redacted values before and after. GET /api/admin-activity (and its
// CSV) shows those rows beside the decision log's answered cards, filtered by
// who, what and when, to admins only. Nothing is sent anywhere.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
const BOSS = "boss@example.test";
const ADA = "ada@example.test";
const SECRET = "sk-ant-api03-activity-fixture-secret-0123456789abcdef";
const MCP_SECRET = "mcp-activity-fixture-secret-value";
const ARG_SECRET = "acme_live_9f8e7d6c5b4a3f2e1d0c";

let child: ChildProcess;
let home: string;
let data: string;
let log = "";
const tokens: Record<string, string> = {};
let oldPhone = "";

const api = async (method: string, path: string, body?: unknown, as?: string, extra: Record<string, string> = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* CSV */
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
};

async function start() {
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A request whose body is held back until `release()`: the server has
 * started on it (and taken its "before") while other requests run. */
function slowRequest(method: string, path: string, body: unknown, as?: string) {
  const text = new TextEncoder().encode(JSON.stringify(body));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(text.slice(0, 2));
      await gate;
      controller.enqueue(text.slice(2));
      controller.close();
    },
  });
  const response = fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { release, response };
}

async function activity(query = "", as = BOSS): Promise<any[]> {
  // Rows are written once the change's response has gone out.
  await new Promise((r) => setTimeout(r, 150));
  const res = await api("GET", `/api/admin-activity${query}`, undefined, as);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.entries;
}
const month = () => new Date().toISOString().slice(0, 7);

posixOnly("admin activity log", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-admin-activity-"));
    data = join(home, ".openmausbot");
    mkdirSync(join(data, "decisions"), { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: [BOSS], members: [ADA] } }));
    // One card Ada answered earlier, as the decision log recorded it (#1708).
    writeFileSync(join(data, "decisions", `${month()}.ndjson`), [
      { at: new Date(Date.now() - 60_000).toISOString(), threadId: "t1", requestId: "r1", botName: "Ops", tool: "Bash", summary: "echo hi",
        decision: "user-approved", source: "user", actor: { kind: "session", sessionId: "s-ada", label: "ada's laptop", email: ADA } },
      { at: new Date(Date.now() - 50_000).toISOString(), threadId: "t1", requestId: "r2", tool: "Read", decision: "auto-approved", source: "full-access" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const role = (email: string) => (email === BOSS ? ["admin", "client"] as const : ["client"] as const);
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: (email) => [...role(email)] });
    for (const email of [BOSS, ADA]) tokens[email] = registry.issue({ label: `${email.split("@")[0]}'s laptop`, email, scopes: [...role(email)] }).token;
    oldPhone = registry.issue({ label: "Old phone", scopes: ["client"] }).session.id;
    registry.close();
    await start();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("is an admin's to read", async () => {
    expect((await api("GET", "/api/admin-activity", undefined, ADA)).status).toBe(403);
    expect((await api("GET", "/api/admin-activity.csv", undefined, ADA)).status).toBe(403);
    expect((await api("GET", "/api/admin-activity?what=everything", undefined, BOSS)).status).toBe(400);
    expect((await api("GET", "/api/admin-activity?from=2026-02-31", undefined, BOSS)).status).toBe(400);
  });

  it("records settings, people, keys and budgets with who changed them, never a secret", async () => {
    expect((await api("PUT", "/api/config", { signIn: { admins: [BOSS], members: [ADA, "carol@example.test"] } }, BOSS)).status).toBe(200);
    expect((await api("PUT", "/api/config", { anthropic: { key: SECRET } }, BOSS)).status).toBe(200);
    expect((await api("PUT", "/api/config", { budgets: { monthlyUsd: 75 } }, BOSS)).status).toBe(200);
    expect((await api("PUT", "/api/config", { decisions: { retentionDays: 400 } })).status).toBe(200); // the owner, on this machine
    expect((await api("PUT", "/api/config", { profile: { name: "Ops desk" } }, undefined, { "x-openmausbot-cli": "1" })).status).toBe(200);

    const people = (await activity("?what=people"))[0];
    expect(people).toMatchObject({ type: "admin", who: BOSS, what: "people", action: "people.update", changed: ["signIn.members"],
      before: { "signIn.members": [ADA] }, after: { "signIn.members": [ADA, "carol@example.test"] } });
    const engine = (await activity("?what=engine"))[0];
    expect(engine).toMatchObject({ who: BOSS, action: "engine.update", changed: ["anthropic.key"], after: { "anthropic.key": "[hidden]" } });
    const budget = (await activity("?what=budget"))[0];
    expect(budget).toMatchObject({ who: BOSS, changed: ["budgets.monthlyUsd"], after: { "budgets.monthlyUsd": 75 } });
    const config = await activity("?what=config");
    expect(config[0]).toMatchObject({ who: "Command line", changed: ["profile.name"], after: { "profile.name": "Ops desk" } });
    expect(config[1]).toMatchObject({ who: "This computer", changed: ["decisions.retentionDays"], after: { "decisions.retentionDays": 400 } });

    // Neither the key nor any part of it is on disk in the log, and the file is private.
    const dir = join(data, "admin-activity");
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), "utf8")).not.toContain("activity-fixture-secret");
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("records MCP servers, webhooks, bots, a bot's audience and sessions", async () => {
    const mcp = await api("POST", "/api/mcp/servers", { name: "fixture", command: process.execPath, args: ["--version", "--api-key", ARG_SECRET], env: { FIXTURE_TOKEN: MCP_SECRET } }, BOSS);
    expect(mcp.status, JSON.stringify(mcp.body)).toBe(201);
    const bot = await api("POST", "/api/bots", { name: "Audit Owl" }, BOSS);
    expect(bot.status).toBe(201);
    const botId = bot.body.bot.id as string;
    expect((await api("PATCH", `/api/bots/${botId}`, { visibility: { people: [ADA] } }, BOSS)).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${botId}`, { approvePeerComms: true }, BOSS)).status).toBe(200);
    // display-only and refused changes leave no row
    expect((await api("PATCH", `/api/bots/${botId}`, { pinned: true }, ADA)).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${botId}`, { visibility: { people: ["nope"] } }, BOSS)).status).toBe(400);
    const signOut = await api("POST", "/api/instances/no-such-engine/auth/sign-out", {}, BOSS);
    expect(signOut.status, JSON.stringify(signOut.body)).toBeGreaterThanOrEqual(400);
    const hook = await api("POST", "/api/webhooks", { name: "Audit feed", botId, prompt: "Read it.", enabled: false }, BOSS);
    expect(hook.status).toBe(201);
    expect((await api("DELETE", `/api/webhooks/${hook.body.webhook.id}`, undefined, BOSS)).status).toBe(200);
    expect((await api("DELETE", `/api/auth/sessions/${oldPhone}`, undefined, BOSS)).status).toBe(200);
    expect((await api("POST", "/api/auth/pairing", { label: "Reception iPad", scopes: ["client"] }, BOSS)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${botId}`, undefined, BOSS)).status).toBe(200);

    const rows = (await activity("?what=all")).filter((entry) => entry.type === "admin");
    const actions = rows.map((entry) => entry.action);
    for (const action of ["mcp.update", "bot.create", "visibility.update", "bot.update", "webhook.create", "webhook.delete", "session.revoke", "pairing.create", "bot.delete"]) {
      expect(actions, action).toContain(action);
    }
    expect(actions.filter((action) => action === "bot.update")).toHaveLength(1); // not the pin, not the refused audience
    expect(actions).not.toContain("engine.auth-sign-out"); // refused: nothing happened
    expect(actions.filter((action) => action === "visibility.update")).toHaveLength(1);
    const audience = rows.find((entry) => entry.action === "visibility.update");
    expect(audience).toMatchObject({ who: BOSS, target: { kind: "bot", id: botId, name: "Audit Owl" }, before: { visibility: "everyone" }, after: { visibility: { people: [ADA] } } });
    const mcpRow = rows.find((entry) => entry.action === "mcp.update");
    expect(JSON.stringify(mcpRow)).not.toContain(MCP_SECRET);
    expect(JSON.stringify(mcpRow)).not.toContain(ARG_SECRET);
    expect(JSON.stringify(mcpRow)).toContain("--api-key");
    expect(JSON.stringify(mcpRow)).toContain("FIXTURE_TOKEN");
    expect(rows.find((entry) => entry.action === "session.revoke")).toMatchObject({ target: { id: oldPhone, name: "Old phone" } });
    expect(rows.find((entry) => entry.action === "pairing.create")).toMatchObject({ after: { label: "Reception iPad", scopes: ["client"] } });
    expect(rows.find((entry) => entry.action === "bot.delete")).toMatchObject({ target: { id: botId }, before: { visibility: { people: [ADA] } } });
  });

  it("shows answered cards with admin actions, filtered by who, what and when, and exports them", async () => {
    const all = await activity();
    const approval = all.find((entry) => entry.type === "approval");
    expect(approval).toMatchObject({ who: ADA, what: "user-approved", bot: "Ops", tool: "Bash" });
    // automatic decisions only when asked for
    expect(all.some((entry) => entry.what === "auto-approved")).toBe(false);
    expect((await activity("?what=decisions")).map((entry) => entry.what).sort()).toEqual(["auto-approved", "user-approved"]);
    expect((await activity("?what=approvals")).map((entry) => entry.who)).toEqual([ADA]);
    expect((await activity(`?who=${encodeURIComponent("ADA@")}`)).map((entry) => entry.type)).toEqual(["approval"]);
    expect((await activity("?who=command")).map((entry) => entry.action)).toEqual(["config.update"]);
    // newest first
    const times = all.map((entry) => entry.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(await activity("?from=2020-01-01&to=2020-01-31")).toEqual([]);

    const csv = await api("GET", "/api/admin-activity.csv?what=all", undefined, BOSS);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[0]).toBe("time,type,who,what,action,target,changed,before,after,bot,tool,summary,thread");
    expect(csv.text).toContain("visibility.update");
    expect(csv.text).not.toContain("activity-fixture-secret");
    expect(csv.text).not.toContain(ARG_SECRET);
  });

  it("puts each concurrent change down to the admin who made it", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Race Finch" }, BOSS)).body.bot as { id: string };
    // Boss's request is slow: its body arrives only after the owner on this
    // machine has made (and finished) a change of their own to the same thing.
    const slowBot = slowRequest("PATCH", `/api/bots/${bot.id}`, { approvePeerComms: true }, BOSS);
    await new Promise((r) => setTimeout(r, 300));
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false })).status).toBe(200);
    slowBot.release();
    expect((await slowBot.response).status).toBe(200);
    const slowConfig = slowRequest("PUT", "/api/config", { profile: { name: "Race desk" } }, BOSS);
    await new Promise((r) => setTimeout(r, 300));
    expect((await api("PUT", "/api/config", { decisions: { retentionDays: 365 } })).status).toBe(200);
    slowConfig.release();
    expect((await slowConfig.response).status).toBe(200);

    const rows = (await activity("?what=all")).filter((entry) => entry.type === "admin");
    const botRows = rows.filter((entry) => entry.action === "bot.update" && entry.target?.id === bot.id);
    expect(botRows.map((entry) => [entry.who, entry.changed]).sort()).toEqual([
      [BOSS, ["approvePeerComms"]],
      ["This computer", ["composio"]],
    ].sort());
    const configRows = rows.filter((entry) => entry.action === "config.update" &&
      (JSON.stringify(entry.after).includes("Race desk") || JSON.stringify(entry.after).includes("365")));
    expect(configRows.map((entry) => [entry.who, entry.changed]).sort()).toEqual([
      [BOSS, ["profile.name"]],
      ["This computer", ["decisions.retentionDays"]],
    ].sort());
  });

  it("records only while the workspace is shared, including the change that ends or starts sharing", async () => {
    // Ada leaves: the change that ends sharing is still recorded…
    expect((await api("PUT", "/api/config", { signIn: { admins: [BOSS], members: [] } }, BOSS)).status).toBe(200);
    expect((await activity("?what=people"))[0]).toMatchObject({ who: BOSS, changed: ["signIn.members"] });
    // (an unused chat-only pairing code from earlier also counts as sharing)
    for (const pairing of (await api("GET", "/api/auth/pairing", undefined, BOSS)).body.pairings ?? []) {
      expect((await api("DELETE", `/api/auth/pairing/${pairing.id}`, undefined, BOSS)).status).toBe(200);
    }
    // …and after it, a one-person server keeps no admin log.
    expect((await api("PUT", "/api/config", { profile: { name: "Solo desk" } }, BOSS)).status).toBe(200);
    expect((await api("POST", "/api/bots", { name: "Solo Wren" }, BOSS)).status).toBe(201);
    let rows = await activity("?what=all");
    expect(JSON.stringify(rows)).not.toContain("Solo desk");
    expect(JSON.stringify(rows)).not.toContain("Solo Wren");
    expect((await api("GET", "/api/admin-activity", undefined, BOSS)).body.recording).toBe(false);

    // A chat-only phone makes it shared again: its pairing code is recorded,
    // and so is signing it out, though that leaves one person again.
    const opened = await api("POST", "/api/auth/pairing", { label: "Front desk phone", scopes: ["client"] }, BOSS);
    expect(opened.status).toBe(200);
    const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Front desk phone" });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    const phone = paired.body.session.id as string;
    expect((await api("GET", "/api/admin-activity", undefined, BOSS)).body.recording).toBe(true);
    expect((await api("DELETE", `/api/auth/sessions/${phone}`, undefined, BOSS)).status).toBe(200);
    expect((await api("GET", "/api/admin-activity", undefined, BOSS)).body.recording).toBe(false);
    rows = await activity("?what=session");
    expect(rows.map((entry) => entry.action)).toEqual(expect.arrayContaining(["pairing.create", "session.revoke"]));
    expect(rows.find((entry) => entry.action === "session.revoke")).toMatchObject({ who: BOSS, target: { id: phone, name: "Front desk phone" } });
  });
});
