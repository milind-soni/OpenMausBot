import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { TEMPLATE_SHARE_MESSAGE } from "../shared/share-card.ts";

const KEY = "sk-ant-api03-SHAREFIXTUREKEY000000000000000000";
const MEMORY_MARKER = "MEMORY_FIXTURE_Acme_contact_jane";
const PRIVATE_LINE = "Quotes live in /Users/danarivera/Clients/quotes and /Users/danarivera/.openmausbot/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/out.md; ask dana@rivera-sales.com or +1 (415) 555-0132.";
const CHAT_MARKER = "CHAT_FIXTURE_the_Acme_renewal";
const MCP_TOKEN = "MCPFIXTURETOKEN0123456789";
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} steps.\n---\n\n# ${name}\n\nQuote the list price.\n`;

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let work: string;
let calls: string;
let api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
const command = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
const toolCalls = (list: unknown[]) => writeFileSync(calls, JSON.stringify(list));
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
async function say(botId: string, text: string) {
  await command("send", "--bot", botId, "--text", text);
  expect(await command("wait", "--bot", botId, "--timeout", "30")).toMatchObject({ status: "settled" });
}
/** Every file under `dir`, as text. */
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) for (const [inner, text] of Object.entries(readTree(path))) out[`${name}/${inner}`] = text;
    else out[name] = readFileSync(path, "latin1");
  }
  return out;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "omb-share-e2e-"));
  calls = join(work, "calls.json");
  toolCalls([]);
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS_FILE: calls });
  console.log(JSON.stringify({ fixture: fixture.info }));
  api = async (method, path, body) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  rmSync(work, { recursive: true, force: true });
});

describe("templates on a throwaway server", () => {
  it("the old share formats and the folder scout are gone; backups stay", async () => {
    expect((await api("GET", "/api/teams/scout?cwd=%2Ftmp")).status).toBe(404);
    expect((await api("GET", "/api/teams/scout/directory?cwd=%2Ftmp")).status).toBe(404);
    for (const body of [{ format: "package", version: 2, team: "Sales desk" }, { format: "package", version: 2, kind: "library" }, { format: "package" }, { name: "Manifest" }]) {
      expect((await api("POST", "/api/teams/export", body)).status).toBe(400);
    }
    const backup = await api("POST", "/api/teams/export", { format: "backup" });
    expect(backup.status, JSON.stringify(backup.body).slice(0, 300)).toBe(200);
  });

  it("a bot shares itself from chat: one card, a folder with no chats, memory or keys, and an equivalent bot when it is added back", async () => {
    const seeded = await api("POST", "/api/teams/import", {
      format: "openmaus.package", version: 2,
      package: {
        id: "sales-helper", release: "1.0.0", name: "Sales helper", tagline: "Quotes prices.", summary: "Helps with quotes.", category: "Sales",
        author: { name: "Fixture" }, license: "MIT", outcomes: ["Quotes."], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
        team: { name: "Seed" }, agents: [{ key: "helper", name: "Sales helper", title: "Quotes", appearance: { color: "green" }, skills: ["pricing"] }],
        skills: { version: 1, entries: [{ name: "pricing", description: "pricing steps.", instructions: skill("pricing") }] },
      },
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
    const bot = seeded.body.bots[0];
    // Skills from a template arrive switched off, and a template carries only switched-on ones.
    expect((await api("PATCH", `/api/bots/${bot.id}/skills/pricing`, { enabled: true })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { soul: `Quote from the list. The billing key is ${KEY}.\n${PRIVATE_LINE}\n` })).status).toBe(200);
    expect((await api("PUT", `/api/bots/${bot.id}/memory`, { text: `# Memory\n- ${MEMORY_MARKER}\n` })).status).toBe(200);
    const mcp = await api("POST", "/api/mcp/servers", { name: "crm", type: "http", url: `https://crm.example.com/mcp/${MCP_TOKEN}` });
    expect(mcp.status, JSON.stringify(mcp.body)).toBeLessThan(300);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["crm"] })).status).toBe(200);
    const routine = await api("POST", "/api/routines", { name: "Morning quotes", prompt: "Check new quote requests.", botId: bot.id, enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    await say(bot.id, `Remember ${CHAT_MARKER}.`);

    toolCalls([{ name: "share", server: "agents", input: { action: "export" } }]);
    await say(bot.id, TEMPLATE_SHARE_MESSAGE);
    toolCalls([]);
    const thread = await messages(bot.threadId);
    expect(thread.some((line) => line.role === "user" && line.text === TEMPLATE_SHARE_MESSAGE)).toBe(true);
    const cards = thread.filter((line) => line.template);
    expect(cards).toHaveLength(1);
    const card = cards[0].template;
    expect(card).toMatchObject({ scope: "bot", name: "Sales helper", status: "draft", counts: { bots: 1, skills: 1, routines: 1, apps: 1 }, fallback: "unavailable" });
    expect(card.redacted).toBeGreaterThan(0);
    expect(card).toMatchObject({ secret: true, scrubbed: { paths: 2, emails: 1, phones: 1, names: 0 } });

    const shown = await api("GET", `/api/share/${card.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.details).toMatchObject({ scope: "bot", name: "Sales helper", skills: [{ name: "pricing" }], routines: [{ name: "Morning quotes" }], apps: [{ label: "Crm" }] });
    expect(await api("POST", `/api/share/${card.id}/publish`)).toMatchObject({ status: 200, body: { status: "draft", fallback: "unavailable" } });

    const target = join(work, "saved");
    mkdirSync(target);
    const saved = await api("POST", `/api/share/${card.id}/save`, { path: target });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const files = readTree(saved.body.path);
    expect(Object.keys(files).sort()).toEqual(["bot.md", "skills/pricing/SKILL.md"]);
    const everything = Object.values(files).join("\n");
    for (const kept of [KEY, MEMORY_MARKER, CHAT_MARKER, MCP_TOKEN, "crm.example.com", "modelSelection", "approval", "/Users/", "dana@", "555-0132"]) expect(everything).not.toContain(kept);
    expect(files["bot.md"]).toContain("Quotes live in ~/Clients/quotes and <workspace>/out.md; ask <email> or <phone>.");
    expect(files["bot.md"]).toContain("enabledAfterInstall: false");
    const zip = await fetch(`${fixture.info.url}/api/share/${card.id}/download`, { headers: { origin: fixture.info.url } });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");

    const preview = await api("POST", "/api/share/import?preview=1", { path: saved.body.path });
    expect(preview.body.details).toMatchObject({ scope: "bot", name: "Sales helper", routines: [{ name: "Morning quotes" }] });
    const added = await api("POST", "/api/share/import", { path: saved.body.path });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ section: "", appsToConnect: 1, bots: [{ name: "Sales helper 2", title: "Quotes", color: "green" }] });
    const copy = added.body.bots[0];
    expect(copy.section ?? "").toBe("");
    expect(copy.soul).toContain("Quote from the list.");
    expect(copy.soul).not.toContain(KEY);
    expect(copy.mcpServers ?? []).toEqual([]);
    expect(added.body.routines).toEqual([expect.objectContaining({ name: "Morning quotes", enabled: false })]);
    expect((await api("GET", `/api/bots/${copy.id}/skills`)).body.skills).toEqual([expect.objectContaining({ name: "pricing", enabled: false })]);
    expect(JSON.stringify((await api("GET", `/api/bots/${copy.id}/memory`)).body)).not.toContain(MEMORY_MARKER);
    expect(JSON.stringify(await messages(copy.threadId))).not.toContain(CHAT_MARKER);

    const before = (await api("GET", "/api/bots")).body.bots.length;
    toolCalls([{ name: "share", server: "agents", input: { action: "import", path: saved.body.path } }]);
    await say(bot.id, "Add the template I saved earlier.");
    expect((await api("GET", "/api/bots")).body.bots.length, "a path the person didn't write is refused").toBe(before);
    await say(bot.id, `Add this: ${saved.body.path}`);
    toolCalls([]);
    expect((await api("GET", "/api/bots")).body.bots.length, "the path in the person's own message is added").toBe(before + 1);

    expect((await api("DELETE", `/api/share/${card.id}`)).body).toEqual({ ok: true });
    expect((await messages(bot.threadId)).find((line) => line.template?.id === card.id)?.template.status).toBe("gone");
    expect((await api("GET", `/api/share/${card.id}`)).status).toBe(404);
  }, 180_000);

  it("a department exports and comes back as a new department with its bots, skills, group chat, brief and Chief", async () => {
    const seeded = await api("POST", "/api/teams/import", JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8")));
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
    const section = seeded.body.section as string;
    const card = await api("POST", "/api/share/export", { department: section });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect(card.body).toMatchObject({ scope: "department", name: section, counts: { bots: 3, routines: 2 } });
    const before = (await api("GET", `/api/share/${card.body.id}`)).body.details;
    const target = join(work, "department");
    mkdirSync(target);
    const saved = await api("POST", `/api/share/${card.body.id}/save`, { path: target });
    const files = readTree(saved.body.path);
    expect(Object.keys(files)).toContain("team.md");
    expect(Object.values(files).join("\n")).not.toMatch(/mcp\.example|https:\/\/[^\s]*crm|enabledAfterInstall: true/);
    const preview = (await api("POST", "/api/share/import?preview=1", { path: saved.body.path })).body.details;
    expect(preview).toEqual(before);
    const added = await api("POST", "/api/share/import", { path: saved.body.path });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.section).toBe(`${section} 2`);
    expect(added.body.bots).toHaveLength(3);
    expect(added.body.brief).toBe(true);
    expect(added.body.groups.map((group: { name: string }) => group.name)).toEqual(before.groupChats.map((group: { name: string }) => group.name));
    expect(added.body.routines.every((routine: { enabled: boolean }) => !routine.enabled)).toBe(true);
    const bots = (await api("GET", "/api/bots")).body.bots as Array<{ name: string; section?: string; chiefOfStaff?: boolean }>;
    const lead = before.bots.find((each: { lead?: boolean }) => each.lead).name;
    expect(bots.find((each) => each.section === `${section} 2` && each.name.startsWith(lead))?.chiefOfStaff).toBe(true);
  }, 120_000);
});
