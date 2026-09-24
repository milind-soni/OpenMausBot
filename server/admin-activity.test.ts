import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activityCsv,
  activityEntries,
  adminActivityFileFor,
  appendAdminAction,
  auditValues,
  botAuditSnapshot,
  botChangeRows,
  changedPaths,
  configChangeRows,
  flushAdminActivity,
  parseActivityWhat,
  pruneAdminActivity,
  readAdminActivityRange,
  sharedSignIn,
  signInListsOf,
  type AdminActionRow,
} from "./admin-activity.ts";
import { bindDecisionRetention, DEFAULT_DECISION_RETENTION_DAYS, type DecisionRow } from "./decision-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-admin-activity-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  bindDecisionRetention(() => DEFAULT_DECISION_RETENTION_DAYS);
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const BOSS = { kind: "session" as const, sessionId: "s1", label: "Boss's laptop", email: "boss@example.test" };

describe("what a row records", () => {
  it("names the paths that changed, never a secret's value", () => {
    const before = { anthropic: { key: "sk-ant-old-secret-value-1234567890" }, features: { browser: true }, profile: { name: "A" } };
    const after = { anthropic: { key: "sk-ant-new-secret-value-0987654321" }, features: { browser: false }, profile: { name: "A" }, decisions: { retentionDays: 365 } };
    expect(changedPaths(before, after)).toEqual(["anthropic.key", "decisions.retentionDays", "features.browser"]);
    const rows = configChangeRows(before, after);
    expect(rows.map((row) => [row.category, row.action, row.changed])).toEqual([
      ["engine", "engine.update", ["anthropic.key"]],
      ["config", "config.update", ["decisions.retentionDays", "features.browser"]],
    ]);
    const engine = auditValues(rows[0]!.after!);
    expect(engine).toEqual({ "anthropic.key": "[hidden]" });
    expect(JSON.stringify(auditValues(rows[0]!.before!))).not.toContain("sk-ant");
    expect(auditValues(rows[1]!.after!)).toEqual({ "decisions.retentionDays": 365, "features.browser": false });
    expect(auditValues(rows[1]!.before!)).toEqual({ "decisions.retentionDays": null, "features.browser": true });
  });

  it("files people, budgets and MCP servers under their own heading, headers and env hidden", () => {
    const rows = configChangeRows(
      { signIn: { admins: ["boss@example.test"], members: [] }, budgets: { monthlyUsd: 100 } },
      {
        signIn: { admins: ["boss@example.test"], members: ["ada@example.test"] },
        budgets: { monthlyUsd: 250 },
        mcpServers: { github: { url: "https://mcp.example.test", headers: { Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, env: { TEAM: "ops" } } },
      },
    );
    expect(rows.map((row) => row.category).sort()).toEqual(["budget", "mcp", "people"]);
    const people = rows.find((row) => row.category === "people")!;
    expect(people.changed).toEqual(["signIn.members"]);
    expect(auditValues(people.after!)).toEqual({ "signIn.members": ["ada@example.test"] });
    const mcp = auditValues(rows.find((row) => row.category === "mcp")!.after!);
    expect(mcp).toEqual({ "mcpServers.github.env": { TEAM: "[hidden]" }, "mcpServers.github.headers": { Authorization: "[hidden]" }, "mcpServers.github.url": "https://mcp.example.test" });
    expect(auditValues({ "instances.grok.environment": { KEY: "x" }, "box.token": "t", "rooms.maxTokens": 9 }))
      .toEqual({ "instances.grok.environment": { KEY: "[hidden]" }, "box.token": "[hidden]", "rooms.maxTokens": 9 });
  });

  it("hides a credential passed as a flag or in a URL", () => {
    const rows = configChangeRows({ mcpServers: {} }, { mcpServers: {
      stripe: { command: "npx", args: ["-y", "@acme/mcp", "--api-key", "acme_live_9f8e7d6c5b4a3f2e1d0c", "--token=tok_live_123456", "--verbose", "--port", "8080"] },
      remote: { url: "https://mcp.example.test/sse?key=abc123def456ghi&mode=fast&access_token=xyz987" },
    } });
    const values = JSON.stringify(auditValues(rows[0]!.after!));
    for (const secret of ["acme_live_9f8e7d6c5b4a3f2e1d0c", "tok_live_123456", "abc123def456ghi", "xyz987"]) expect(values).not.toContain(secret);
    const more = JSON.stringify(auditValues({
      short: ["-k", "acme_live_9f8e7d6c5b4a3f2e1d0c", "-p", "8080"],
      path: "https://mcp.zapier.com/api/mcp/s/acme_live_9f8e7d6c5b4a3f2e1d0c/sse",
      remote: "https://acme_live_9f8e7d6c5b4a3f2e1d0c@mcp.example.com/sse",
      slug: "https://example.com/docs/getting-started-guide-2024",
      uuid: "https://api.example.com/items/4575b1f7-c16c-4afa-82ce-bcc2fdc70374",
    }));
    expect(more).not.toContain("acme_live");
    expect(more).toContain('["-k","[hidden]","-p","8080"]');
    expect(more).toContain("https://mcp.zapier.com/api/mcp/s/[hidden]/sse");
    expect(more).toContain("https://[hidden]@mcp.example.com/sse");
    // readable names and ids stay readable
    expect(more).toContain("getting-started-guide-2024");
    expect(more).toContain("4575b1f7-c16c-4afa-82ce-bcc2fdc70374");
    expect(values).toContain('"--api-key","[hidden]","--token=[hidden]","--verbose","--port","8080"');
    expect(values).toContain("?key=[hidden]&mode=fast&access_token=[hidden]");
  });

  it("compares only the fields a request named", () => {
    const before = botAuditSnapshot({ approvalMode: "ask", composio: true });
    const after = botAuditSnapshot({ approvalMode: "auto", composio: false });
    expect(botChangeRows({ id: "b" }, before, after, ["composio"]).map((row) => row.changed)).toEqual([["composio"]]);
    expect(botChangeRows({ id: "b" }, before, after).map((row) => row.changed)).toEqual([["approvalMode", "composio"]]);
  });

  it("knows when more than one person signs in", () => {
    expect(sharedSignIn({ admins: ["boss@example.test"], members: [] })).toBe(false);
    expect(sharedSignIn({ admins: [], members: [] })).toBe(false);
    expect(sharedSignIn({ admins: ["boss@example.test"], members: ["ada@example.test"] })).toBe(true);
    expect(sharedSignIn({ admins: ["boss@example.test", "cto@example.test"], members: [] })).toBe(true);
    expect(sharedSignIn({ admins: ["@example.test"], members: [] })).toBe(true);
    expect(signInListsOf({ signIn: { admins: ["a@x.test", 3], members: "nope" } })).toEqual({ admins: ["a@x.test"], members: [] });
    expect(signInListsOf(null)).toEqual({ admins: [], members: [] });
  });

  it("splits a bot's audience from its other permissions and ignores display fields", () => {
    const before = botAuditSnapshot({ id: "b", color: "red", approvalMode: "ask", peers: ["x"] });
    const after = botAuditSnapshot({ id: "b", color: "blue", approvalMode: "ask", peers: [], visibility: { people: ["ada@example.test"] } });
    const rows = botChangeRows({ id: "b", name: "Payroll" }, before, after);
    expect(rows).toEqual([
      { category: "visibility", action: "visibility.update", target: { kind: "bot", id: "b", name: "Payroll" }, changed: ["visibility"],
        before: { visibility: "everyone" }, after: { visibility: { people: ["ada@example.test"] } } },
      { category: "bot", action: "bot.update", target: { kind: "bot", id: "b", name: "Payroll" }, changed: ["peers"], before: { peers: ["x"] }, after: { peers: [] } },
    ]);
    expect(botChangeRows({ id: "b" }, botAuditSnapshot({ color: "red" }), botAuditSnapshot({ color: "blue" }))).toEqual([]);
  });
});

describe("the monthly file", () => {
  it("appends 0600 rows, reads a range back, and prunes by the decision log's window", async () => {
    const dir = tempDir();
    const old = new Date(Date.UTC(2025, 0, 10));
    const recent = new Date();
    appendAdminAction(dir, { at: old.toISOString(), category: "config", action: "config.update", actor: { kind: "loopback" } });
    await flushAdminActivity(dir);
    appendAdminAction(dir, { category: "people", action: "people.update", actor: BOSS, before: { "signIn.members": [] }, after: { "signIn.members": ["ada@example.test"] } });
    await flushAdminActivity(dir);
    // A write in a new hour prunes: the default window already covers January 2025 → gone.
    expect(existsSync(adminActivityFileFor(dir, old))).toBe(false);
    const file = adminActivityFileFor(dir, recent);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const rows = readAdminActivityRange(dir, { from: new Date(recent.getTime() - 60_000), to: new Date(recent.getTime() + 60_000) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "people", actor: BOSS });
  });

  it("prunes a quiet log on the server's timer, by the same window", async () => {
    const dir = tempDir();
    const old = new Date(Date.UTC(2024, 0, 15));
    mkdirSync(join(dir, "admin-activity"), { recursive: true });
    writeFileSync(adminActivityFileFor(dir, old), JSON.stringify({ at: old.toISOString(), category: "bot", action: "bot.create", actor: { kind: "cli" } }) + "\n");
    expect(await pruneAdminActivity(dir, 3650)).toEqual([]);
    expect(await pruneAdminActivity(dir, 180)).toEqual(["2024-01.ndjson"]);
  });

  it("keeps an old month while the configured window still covers it", async () => {
    const dir = tempDir();
    bindDecisionRetention(() => 3650);
    const old = new Date(Date.UTC(2024, 5, 1));
    mkdirSync(join(dir, "admin-activity"), { recursive: true });
    writeFileSync(adminActivityFileFor(dir, old), JSON.stringify({ at: old.toISOString(), category: "bot", action: "bot.create", actor: { kind: "cli" } }) + "\n");
    appendAdminAction(dir, { category: "config", action: "config.update", actor: { kind: "loopback" } });
    await flushAdminActivity(dir);
    expect(readFileSync(adminActivityFileFor(dir, old), "utf8")).toContain("bot.create");
  });
});

describe("the Activity view", () => {
  const decisions: DecisionRow[] = [
    { at: "2026-09-20T10:00:00.000Z", threadId: "t1", decision: "auto-approved", source: "rule" as DecisionRow["source"], tool: "Read" },
    { at: "2026-09-20T11:00:00.000Z", threadId: "t1", decision: "user-approved", source: "user", tool: "Bash", summary: "=cmd|' /C calc'!A0", botName: "Ops",
      actor: { kind: "session", sessionId: "s2", label: "Ada's phone", email: "ada@example.test" } },
  ];
  const actions: AdminActionRow[] = [
    { at: "2026-09-21T09:00:00.000Z", category: "visibility", action: "visibility.update", target: { kind: "bot", id: "b", name: "Payroll" }, actor: BOSS,
      changed: ["visibility"], before: { visibility: "everyone" }, after: { visibility: "admins" } },
    { at: "2026-09-19T09:00:00.000Z", category: "people", action: "people.update", actor: { kind: "cli" } },
  ];

  it("shows admin actions and people's answers newest first, filtered by who and what", () => {
    const all = activityEntries(decisions, actions, { what: "all" });
    expect(all.map((entry) => [entry.type, entry.who, entry.what])).toEqual([
      ["admin", "boss@example.test", "visibility"],
      ["approval", "ada@example.test", "user-approved"],
      ["admin", "Command line", "people"],
    ]);
    expect(activityEntries(decisions, actions, { what: "decisions" })).toHaveLength(2);
    expect(activityEntries(decisions, actions, { what: "approvals" }).map((entry) => entry.who)).toEqual(["ada@example.test"]);
    expect(activityEntries(decisions, actions, { what: "visibility" })).toHaveLength(1);
    expect(activityEntries(decisions, actions, { what: "all", who: "COMMAND" }).map((entry) => entry.what)).toEqual(["people"]);
    expect(parseActivityWhat(null)).toBe("all");
    expect(parseActivityWhat("budget")).toBe("budget");
    expect(parseActivityWhat("nonsense")).toBeNull();
  });

  it("exports CSV with formula cells neutralised", () => {
    const csv = activityCsv(activityEntries(decisions, actions, { what: "all" }));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("time,type,who,what,action,target,changed,before,after,bot,tool,summary,thread");
    expect(lines[1]).toContain("visibility.update,Payroll,visibility");
    expect(csv).toContain(",'=cmd|' /C calc'!A0,");
  });
});
