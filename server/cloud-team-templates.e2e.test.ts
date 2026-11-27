// A Team Cloud's own templates on a real Team Cloud, as its owner, an admin and a member: an admin adds a bot's
// template (its skill's script included) to team-files/templates/<slug>/, adding it again keeps the old one as
// <slug>.previous/, an admin lists and imports it as a new bot whose skill brings the script, and only an admin removes
// one. A member reaches none of it, over HTTP or through the share tool in a chat; the owner's own chat request can.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/calls.json";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";`;
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADELE = { email: "adele@acme.test", role: "admin" as const };
const RUI = { email: "rui@acme.test", role: "member" as const };
const SKILL = "---\nname: report\ndescription: Weekly report.\n---\n\n# Report\n\nRun scripts/report.py.\n";
const SCRIPT = "import os\ntoken = os.environ.get('REPORT_TOKEN', '')\nprint('weekly report')\n";

let fx: CloudSendFixture, team: CloudTeamFixture;
const tokens = { olive: "", adele: "", rui: "" };
type Who = keyof typeof tokens;
const as = (who: Who, method: string, path: string, body?: unknown) => team.as(tokens[who], method, path, body);
let reporter: { id: string; threadId: string };
let templateId = "";

const templates = () => join(team.home, ".openmausbot", "team-files", "templates");
const toolCalls = (list: unknown[]) => writeFileSync(join(team.home, "calls.json"), JSON.stringify(list));
async function until(done: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const idle = async () => ((await as("olive", "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
async function say(who: Who, text: string) {
  const before = ((await as(who, "GET", `/api/threads/${reporter.threadId}/messages?limit=200`)).body.messages as unknown[]).length;
  const sent = await as(who, "POST", `/api/bots/${reporter.id}/messages`, { text, threadId: reporter.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => await idle() && ((await as(who, "GET", `/api/threads/${reporter.threadId}/messages?limit=200`)).body.messages as unknown[]).length >= before + 2);
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-templates-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-templates", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  toolCalls([]);
  for (const [who, person] of [["olive", OLIVE], ["adele", ADELE], ["rui", RUI]] as const) tokens[who] = (await team.pair(person)).token!;
  const seeded = await as("olive", "POST", "/api/teams/import", {
    format: "openmaus.package", version: 2,
    package: {
      id: "reporter", release: "1.0.0", name: "Reporter", tagline: "Writes the weekly report.", summary: "Writes reports.", category: "Ops",
      author: { name: "Fixture" }, license: "MIT", outcomes: ["Reports."], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
      team: { name: "Seed" }, agents: [{ key: "reporter", name: "Reporter", appearance: { color: "green" }, skills: ["report"] }],
      skills: { version: 1, entries: [{ name: "report", description: "Weekly report.", instructions: SKILL, files: [{ path: "scripts/report.py", content: SCRIPT }] }] },
    },
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
  reporter = seeded.body.bots[0];
  expect((await as("olive", "PUT", `/api/bots/${reporter.id}/access`, { everyone: "chat", people: {} })).status).toBe(200);
  // Skills from a template arrive switched off, and a template carries only switched-on ones.
  expect((await as("olive", "PATCH", `/api/bots/${reporter.id}/skills/report`, { enabled: true })).status).toBe(200);
  const skills = (await as("olive", "GET", `/api/bots/${reporter.id}/skills`)).body.skills;
  expect(skills).toEqual([expect.objectContaining({ name: "report", files: ["scripts/report.py"] })]);
}, hostTimeout(240_000));

afterAll(async () => {
  await fx?.close();
});

describe("a Team Cloud's own templates", () => {
  it("an admin adds a template with its skill's script; a member can't add, list or import", async () => {
    const made = await as("olive", "POST", "/api/share/export", { botId: reporter.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    templateId = made.body.id;
    expect(made.body.skipped).toEqual([]);
    expect((await as("rui", "POST", `/api/share/${templateId}/library`)).status).toBe(403);
    expect((await as("rui", "GET", "/api/share/library")).status).toBe(403);
    expect((await as("rui", "POST", "/api/share/import?preview=1", { library: "reporter" })).status).toBe(403);
    const added = await as("adele", "POST", `/api/share/${templateId}/library`);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ replaced: false, template: { slug: "reporter", name: "Reporter", scope: "bot", addedBy: expect.stringMatching(/adele/i) } });
    expect(readFileSync(join(templates(), "reporter", "skills", "report", "scripts", "report.py"), "utf8")).toBe(SCRIPT);
    expect(readFileSync(join(templates(), "reporter", "bot.md"), "utf8")).toContain("skillFiles:");
  }, hostTimeout(60_000));

  it("adding it again replaces it and keeps the previous one; an admin lists it with who added it and when", async () => {
    const again = await as("olive", "POST", `/api/share/${templateId}/library`);
    expect(again.body).toMatchObject({ replaced: true, template: { addedBy: expect.stringMatching(/olive/i) } });
    expect(existsSync(join(templates(), "reporter.previous", "bot.md"))).toBe(true);
    const listed = await as("adele", "GET", "/api/share/library");
    expect(listed).toMatchObject({ status: 200, body: { team: "Acme", templates: [{ slug: "reporter", name: "Reporter", scope: "bot", addedBy: expect.stringMatching(/olive/i), addedAt: expect.any(Number) }] } });
  }, hostTimeout(60_000));

  it("an admin imports it as a new bot whose skill brings the script, off until someone turns it on", async () => {
    const preview = await as("adele", "POST", "/api/share/import?preview=1", { library: "reporter" });
    expect(preview).toMatchObject({ status: 200, body: { details: { scope: "bot", name: "Reporter", skills: [{ name: "report" }] } } });
    const added = await as("adele", "POST", "/api/share/import", { library: "reporter" });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const copy = added.body.bots[0];
    expect(copy.name).toBe("Reporter 2");
    expect((await as("adele", "GET", `/api/bots/${copy.id}/skills`)).body.skills).toEqual([expect.objectContaining({ name: "report", enabled: false, files: ["scripts/report.py"] })]);
  }, hostTimeout(60_000));

  it("the share tool: a member's chat request can't add to or import from the library; the owner's can", async () => {
    const bots = async () => ((await as("olive", "GET", "/api/bots?messages=0")).body.bots as Array<{ name: string }>).length;
    const before = await bots();
    toolCalls([{ name: "share", server: "agents", input: { action: "import_from_team_library", slug: "reporter" } }]);
    await say("rui", "Add the reporter from our templates");
    expect(await bots()).toBe(before);
    toolCalls([{ name: "share", server: "agents", input: { action: "export" } }, { name: "share", server: "agents", input: { action: "add_to_team_library" } }]);
    const listedBefore = (await as("olive", "GET", "/api/share/library")).body.templates[0].addedAt;
    await say("rui", "Share yourself to the team's templates");
    expect((await as("olive", "GET", "/api/share/library")).body.templates[0].addedAt).toBe(listedBefore);
    await say("olive", "Share yourself to the team's templates");
    toolCalls([]);
    await until(async () => (await as("olive", "GET", "/api/share/library")).body.templates[0].addedAt > listedBefore, 30_000);
    expect((await as("olive", "GET", "/api/share/library")).body.templates[0].addedBy).toMatch(/olive/i);
  }, hostTimeout(180_000));

  it("only an admin removes one, and its folder stays as <slug>.previous", async () => {
    expect((await as("rui", "DELETE", "/api/share/library/reporter")).status).toBe(403);
    expect(await as("adele", "DELETE", "/api/share/library/reporter")).toMatchObject({ status: 200, body: { ok: true } });
    expect((await as("adele", "GET", "/api/share/library")).body.templates).toEqual([]);
    expect(existsSync(join(templates(), "reporter"))).toBe(false);
    expect(existsSync(join(templates(), "reporter.previous", "bot.md"))).toBe(true);
    expect((await as("adele", "POST", "/api/share/import?preview=1", { library: "reporter" })).status).toBe(404);
  }, hostTimeout(60_000));
});
