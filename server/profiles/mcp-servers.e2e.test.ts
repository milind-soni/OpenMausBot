// A real fake-engine server applies the acme folder's MCP servers: an HTTP one (a stand-in Notion) and a command one,
// each with a key from a secret slot. Both arrive off until their keys are in the Vault; the command one stays off until
// the person turns it on; then a bot's turn calls a tool on each, with the Vault's value and never the profile's text.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { launchRestartableServer, type RestartableServer } from "../testing/restartable-server.ts";

type Rec = Record<string, any>;
const ROOT = join(import.meta.dirname, "..", "..");
const ACME = join(ROOT, "server", "testing", "fixtures", "profiles", "acme");
const NOTION_KEY = "Bearer notion-fixture-value-0123456789";
const FAKE_KEY = "fake-fixture-value-0123456789";
const posixOnly = describe.skipIf(process.platform === "win32");

// A stdio MCP server small enough for a profile's args: no `$`, `%`, `~` or path, which profiles refuse in a command.
const STDIO_SERVER = [
  "const send = (frame, body) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: \"2.0\", id: frame.id }, body)) + String.fromCharCode(10));",
  "require(\"readline\").createInterface({ input: process.stdin }).on(\"line\", (line) => { const frame = JSON.parse(line);",
  "if (frame.method === \"initialize\") send(frame, { result: { protocolVersion: \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"fake\", version: \"1\" } } });",
  "if (frame.method === \"tools/list\") send(frame, { result: { tools: [{ name: \"read_notes\", inputSchema: { type: \"object\", properties: {} } }] } });",
  "if (frame.method === \"tools/call\") send(frame, { result: { content: [{ type: \"text\", text: \"fake notes, key length \" + String((process.env.FAKE_TOKEN || \"\").length) }] } }); });",
].join(" ");

let server: RestartableServer;
let notion: FakeHttpMcp;
let scratch: string;
let folder: string;
let admin: string;

async function api(method: string, path: string, body?: unknown, asAdmin = false): Promise<{ status: number; body: Rec }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asAdmin ? { authorization: `Bearer ${admin}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Rec };
}
const mcpLines = (plan: Rec) => (plan.lines as Rec[]).filter((line) => line.subject.kind === "mcp-server").map((line) => `${line.kind}: ${line.text}`);
const listed = async (name: string) => ((await api("GET", "/api/mcp/servers")).body.servers as Rec[]).find((server) => server.name === name);
const applyAsAdmin = async () => {
  const plan = (await api("POST", "/api/profiles/plan", {})).body;
  const applied = await api("POST", "/api/profiles/apply", { giveAccess: true, expect: plan.digest }, true);
  expect(applied.status, JSON.stringify(applied.body).slice(0, 400)).toBe(200);
  expect(applied.body.applied.skipped).toEqual([]);
  return applied.body;
};

posixOnly("MCP servers from profiles", () => {
  beforeAll(async () => {
    notion = await startFakeHttpMcp({ requireHeader: { name: "authorization", value: NOTION_KEY }, guard: "tools/call",
      tools: [{ name: "search_pages", inputSchema: { type: "object", properties: {} } }] });
    scratch = mkdtempSync(join(tmpdir(), "omb-profile-mcp-"));
    folder = join(scratch, "acme");
    cpSync(ACME, folder, { recursive: true });
    const notionFile = join(folder, "mcp", "notion.md");
    writeFileSync(notionFile, readFileSync(notionFile, "utf8").replace("https://mcp.notion.com/mcp", notion.url));
    writeFileSync(join(folder, "mcp", "fake.md"), [
      "---", "edubot: 1", "kind: mcp-server", "key: fake", "transport: stdio", "command: node",
      `args: ['-e', '${STDIO_SERVER}']`, "env:", "  FAKE_TOKEN: { secret: FAKE_TOKEN }", "---", "A local test server.", "",
    ].join("\n"));
    const area = join(folder, "areas", "bi", "area.md");
    writeFileSync(area, readFileSync(area, "utf8").replace("chief: analyst", "chief: analyst\nmcpServers: [fake]")
      .replace('"mcp:notion:*"]', '"mcp:notion:*", "mcp:fake:*"]'));
    server = await launchRestartableServer({ instances: { claude: {
      driver: "claudeAgent", displayName: "Verification fixture", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_TOOL_CALLS_FILE: join(scratch, "tool-calls.json") },
    } } });
    await server.stop();
    const registry = new SessionRegistry({ file: join(server.dataDir, "sessions.json"), emailScopes: () => ["client"] });
    admin = registry.issue({ label: "Owner's laptop", scopes: ["admin", "client"] }).token;
    // A chat-only device is what makes this server keep an admin activity log.
    registry.issue({ label: "Phone", scopes: ["client"] });
    registry.close();
    await server.start();
    expect((await api("PUT", "/api/profiles/folder", { folder })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    await notion?.close();
    if (scratch) await removeTempDir(scratch);
  });

  it("saves each server off with Needs your key, and shows the command a command server runs", async () => {
    const plan = (await api("POST", "/api/profiles/plan", {})).body;
    expect(plan.problems).toEqual([]);
    expect(mcpLines(plan)).toEqual([
      `access: Adds MCP server fake that runs \`node -e ${JSON.stringify(STDIO_SERVER)}\` on this computer, with variable FAKE_TOKEN from your Vault secret FAKE_TOKEN; `
        + "Needs your key: it stays off until you save FAKE_TOKEN in Settings → Vault and apply again",
      `access: Adds MCP server notion at ${notion.url}, sending header Authorization from your Vault secret NOTION_TOKEN; `
        + "Needs your key: it stays off until you save NOTION_TOKEN in Settings → Vault and apply again",
    ]);
    expect((plan.lines as Rec[]).filter((line) => line.text.includes("no MCP server named")), "the folder defines both").toEqual([]);
    expect((await api("POST", "/api/profiles/apply", { giveAccess: true })).status, "more access from a program on this computer").toBe(403);
    await applyAsAdmin();
    expect(await listed("notion")).toMatchObject({ type: "http", url: notion.url, headerKeys: [], enabled: false, needsKey: true });
    expect(await listed("fake")).toMatchObject({ command: "node", args: ["-e", STDIO_SERVER], envKeys: [], enabled: false, needsKey: true });
    expect((await api("GET", "/api/profiles")).body).not.toHaveProperty("mcpServers");
    expect(JSON.parse(readFileSync(join(server.dataDir, "profiles.json"), "utf8")).mcpServers).toEqual({
      fake: { hash: expect.any(String), needsKey: true }, notion: { hash: expect.any(String), needsKey: true } });
  });

  it("fills the keys from the Vault as pointers, turns the HTTP server on and leaves the command server for the person", async () => {
    for (const [name, value] of [["NOTION_TOKEN", NOTION_KEY], ["FAKE_TOKEN", FAKE_KEY]]) {
      expect((await api("POST", "/api/vault/secrets", { name, value })).status).toBe(201);
    }
    const plan = (await api("POST", "/api/profiles/plan", {})).body;
    expect(mcpLines(plan)).toEqual([
      "access: MCP server fake: sends variable FAKE_TOKEN from your Vault secret FAKE_TOKEN; it stays off until you check this command and turn it on in Apps → MCP servers",
      "access: MCP server notion: sends header Authorization from your Vault secret NOTION_TOKEN; it is turned on",
    ]);
    await applyAsAdmin();
    expect(await listed("notion")).toMatchObject({ headerKeys: ["Authorization"], enabled: true });
    expect(await listed("fake")).toMatchObject({ envKeys: ["FAKE_TOKEN"], enabled: false });
    expect((await listed("fake"))!.needsKey).toBeUndefined();
    const config = readFileSync(join(server.dataDir, "config.json"), "utf8");
    expect(config).not.toContain(NOTION_KEY);
    expect(config).not.toContain(FAKE_KEY);
    expect(JSON.parse(config).mcpServers.notion.headers.Authorization).toMatch(/^vault:[0-9a-f-]{36}$/);
    expect((await api("POST", "/api/profiles/plan", {})).body.noChanges).toBe(true);
    expect((await api("PATCH", "/api/mcp/servers/fake", { enabled: true })).status).toBe(200);
    expect((await api("POST", "/api/profiles/plan", {})).body.noChanges, "turning it on is the person's to do").toBe(true);
  });

  it("a bot's turn calls a tool on each server with the Vault's value", async () => {
    const analyst = ((await api("GET", "/api/bots?messages=0")).body.bots as Rec[]).find((bot) => bot.profileSource?.key === "analyst")!;
    expect(analyst.mcpServers).toEqual(["fake", "notion"]);
    writeFileSync(join(scratch, "tool-calls.json"), JSON.stringify([
      { server: "notion", name: "search_pages", input: { query: "weekly sales" } },
      { server: "fake", name: "read_notes", input: {} },
    ]));
    const dumpPath = join(server.dataDir, "fake-claude-dump.json");
    rmSync(dumpPath, { force: true });
    const text = "Find this week's sales notes";
    expect((await api("POST", `/api/bots/${analyst.id}/messages`, { threadId: analyst.threadId, text, sendId: "profile-mcp-e2e-send-0001" })).status).toBe(202);
    await expect.poll(() => existsSync(dumpPath), { timeout: 20_000 }).toBe(true);
    const mounts = JSON.parse(readFileSync(dumpPath, "utf8")).mcpConfig.mcpServers as Rec;
    expect(Object.keys(mounts)).toEqual(expect.arrayContaining(["notion", "fake"]));
    let transcript = "";
    await expect.poll(async () => {
      transcript = JSON.stringify((await api("GET", `/api/threads/${analyst.threadId}/messages?limit=50`)).body);
      return transcript.includes('"turnSucceeded":true');
    }, { timeout: 30_000 }).toBe(true);
    expect(notion.calls).toEqual([{ name: "search_pages", arguments: { query: "weekly sales" } }]);
    expect(notion.seenHeaders.some((headers) => headers.authorization === NOTION_KEY)).toBe(true);
    expect(notion.refusedCalls).toEqual([]);
    expect(transcript).toContain(`fake notes, key length ${FAKE_KEY.length}`);
    expect(transcript).not.toContain(NOTION_KEY);
    expect(transcript).not.toContain(FAKE_KEY);
  }, 90_000);

  it("records the applies in the admin activity log", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rows = (await api("GET", "/api/admin-activity?what=profile", undefined, true)).body.entries as Rec[];
    expect(rows.filter((row) => row.action === "profile.apply").map((row) => (row.changed as string[]).filter((field) => field.startsWith("mcp/"))))
      .toEqual(expect.arrayContaining([["mcp/fake", "mcp/notion"]]));
  });
});
