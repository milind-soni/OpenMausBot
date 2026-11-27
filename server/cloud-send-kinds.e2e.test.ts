// Everything else the one-time move carries, end to end: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them and the connected-apps service with a fake
// Composio behind it. Automations, bot files, memory, the bot and conversation fields, a row over 1 MB, skill extras and
// a model on the home network; then the check, and a move run again. Disposable homes; no network.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import type { CloudSendOutcome } from "../electron/cloud-send.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-kinds-${randomBytes(8).toString("hex")}`;
const HOME_MODEL_KEY = `sk-fake-home-${randomBytes(8).toString("hex")}`;
let broker: BrokerFake;
let fx: CloudSendFixture;
let replyFile = "";

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, desktopEngine: `process.env.FAKE_CLAUDE_REPLY_FILE = process.env.HOME + "/long-reply.txt";` });
  replyFile = join(fx.root, "desktop", "long-reply.txt");
}, hostTimeout(90_000));
afterAll(async () => {
  await fx?.close();
  await broker?.close();
});

type Side = CloudSendFixture["local"];
type Row = { id: string; parentId?: string | null; kind: string; role: string; text?: string; at: number; sender?: { id?: string } };
const dataDir = (side: "desktop" | "cloud") => join(fx.root, side, ".openmausbot");
async function rows(side: Side, threadId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let before: string | null = null, more = true; more;) {
    const page: { messages: Row[]; hasMore?: boolean } = (await side("GET", `/api/threads/${threadId}/messages?limit=500${before ? `&before=${before}` : ""}`)).body;
    out.unshift(...page.messages);
    more = page.hasMore === true;
    before = page.messages[0]?.id ?? null;
  }
  return out;
}
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string }, threadId: string, text: string) {
  const before = (await rows(side, threadId)).length;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await rows(side, threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const botOn = async (side: Side, id: string) => ((await side("GET", "/api/bots")).body.bots as Array<Record<string, any>>).find((bot) => bot.id === id)!;
const memoryText = async (side: Side, botId: string, path: string) => (await side("GET", `/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`)).body.text as string;
const entries = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

let nova: { id: string; threadId: string };
let old: { id: string; threadId: string };
let plan: { threadId: string };
let room: { id: string; threadId: string };
let project = "";
let routineId = "", callId = "", webhookId = "", appEventId = "";
let webhookHere: { endpointId: string; secret: string };
let finishedRun = "";
let longRow = "";
let first: CloudSendOutcome;

it("a move carries the automations, files, memory, fields and skills, and its check finds all of it there", async () => {
  const { local, onCloud } = fx;
  nova = (await local("POST", "/api/bots", { name: "Nova", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect((await local("PATCH", `/api/bots/${nova.id}`, { soul: "You are Nova.", section: "Ops" })).status).toBe(200);
  await turn(local, nova, nova.threadId, "Hello Nova.");
  // Nova reached My Cloud once before, with an older app's Send: from then on each side keeps its own memory.
  expect((await fx.olderSend({ keys: [itemKey.bot(nova.id)] })).result.bots).toEqual(["Nova"]);

  // Memory on both sides: one fact both have (dated and marked differently), one only each side has.
  const put = (side: Side, path: string, text: string) => side("PUT", `/api/bots/${nova.id}/memory/file`, { path, text });
  expect((await put(local, "MEMORY.md", "- 2026-10-01 · from chat · Acme pays on the 5th.\n- 2026-10-02 · from chat · Ship on Fridays.\n")).status).toBe(200);
  expect((await put(local, "memory/clients.md", "---\ntitle: Clients\n---\n- 2026-10-02 · from chat · Acme's contact is Dana.\n")).status).toBe(200);
  expect((await put(local, "memory/log/2026-10-20.md", "- 09:10 · from chat · Sent the invoice.\n")).status).toBe(200);
  expect((await put(onCloud, "MEMORY.md", "- 2026-10-05 · from chat · Acme pays on the 5th. · updated 2026-10-06\n- 2026-10-04 · from chat · Prefers email.\n")).status).toBe(200);
  const journalHere = (await local("GET", `/api/bots/${nova.id}/memory/journal?limit=50`)).body.entries as Array<{ id: string }>;
  expect(journalHere.length).toBeGreaterThanOrEqual(3);

  // What Nova learned about the person, and the team's shared context and memory, on both sides.
  const fact = { id: randomUUID(), text: "Lives in Pune", line: "- 2026-10-03 · learned by Nova · Lives in Pune", botId: nova.id, botName: "Nova", at: Date.now() };
  writeFileSync(join(dataDir("desktop"), "profile-learned.json"), JSON.stringify({ learned: [fact], removed: ["Hates spam"] }));
  expect((await local("PATCH", "/api/config", { profile: { name: "Amit", aboutMe: `Runs a shop.\n${fact.line}` } })).status).toBe(200);
  expect((await local("PUT", "/api/section-context?section=Ops", { text: "Ops handles invoices.\n" })).status).toBe(200);
  expect((await onCloud("PUT", "/api/section-context?section=Ops", { text: "Ops is two people.\n" })).status).toBe(200);
  expect((await local("POST", "/api/team-memory?section=Ops", { kind: "person", name: "Dana", detail: "Acme's contact." })).status).toBeLessThan(300);
  expect((await local("POST", "/api/team-memory?section=Ops", { kind: "term", name: "PO", detail: "A purchase order." })).status).toBeLessThan(300);
  expect((await onCloud("POST", "/api/team-memory?section=Ops", { kind: "person", name: "Dana", detail: "Acme's contact." })).status).toBeLessThan(300);

  // The bot fields Send everything left out, and a bot archived here.
  project = (await local("POST", `/api/bots/${nova.id}/projects`, { name: "Launch", emoji: "🚀" })).body.project.id;
  expect((await local("PATCH", `/api/bots/${nova.id}`, { pinned: true, chiefOfStaff: true, fallback: [{ instanceId: "claude", model: "claude-haiku-5" }] })).status).toBe(200);
  old = (await local("POST", "/api/bots", { name: "Old" })).body.bot;
  expect((await local("PATCH", `/api/bots/${old.id}`, { soul: "Retired.", hidden: true })).status).toBe(200);

  // A conversation with its own project, model, approval and snooze; a room conversation with its own time limit.
  plan = (await local("POST", `/api/bots/${nova.id}/tasks`, { title: "Plan", projectId: project })).body.task;
  await turn(local, nova, plan.threadId, "Plan the launch.");
  const snooze = Date.now() + 86_400_000;
  expect((await local("PATCH", `/api/bots/${nova.id}/tasks/${plan.threadId}`, { snoozedUntil: snooze, approvalMode: "edits", modelSelection: { instanceId: "claude", model: "claude-opus-5" } })).status).toBe(200);
  room = (await local("POST", "/api/groups", { name: "Standup", memberIds: [nova.id], setup: { bulletin: "Daily.", defaultResponder: { kind: "mentions" } } })).body.group;
  expect((await local("POST", `/api/groups/${room.id}/messages`, { text: "Notes for the standup.", threadId: room.threadId })).status).toBeLessThan(300);
  expect((await local("PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, { turnTimeoutMinutes: 45 })).status).toBe(200);

  // A reply over 1 MB.
  longRow = `${"Report line. ".repeat(100_000)}End.`;
  writeFileSync(replyFile, longRow);
  await turn(local, nova, nova.threadId, "Write the long report.");
  rmSync(replyFile);

  // Skill extras: one imported, one of the person's Claude Code skills used in place, and a library skill Nova is given.
  const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`;
  const imported = join(dataDir("desktop"), "imported-skills", "invoice-check");
  mkdirSync(join(imported, "references"), { recursive: true });
  writeFileSync(join(imported, "SKILL.md"), skillMd("invoice-check", "Check an invoice."));
  writeFileSync(join(imported, "references", "rules.md"), "Totals must add up.\n");
  mkdirSync(join(dataDir("desktop"), "skill-state"), { recursive: true });
  writeFileSync(join(dataDir("desktop"), "skill-state", "imported-skills.json"), JSON.stringify({ "invoice-check": { description: "Check an invoice.", source: "codex",
    root: "~/.codex/skills", origin: "~/.codex/skills/invoice-check", label: "Codex/invoice-check", sha256: "0".repeat(64), filesSha256: "0".repeat(64),
    importedAt: new Date().toISOString(), warnings: [] } }));
  mkdirSync(join(fx.root, "desktop", ".claude", "skills", "tidy-notes"), { recursive: true });
  writeFileSync(join(fx.root, "desktop", ".claude", "skills", "tidy-notes", "SKILL.md"), skillMd("tidy-notes", "Tidy the notes."));
  expect((await local("PATCH", "/api/config", { features: { claudeUserSkills: true, skillsLibrary: true } })).status).toBe(200);
  expect((await onCloud("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);
  expect((await local("POST", "/api/skills-library", { text: skillMd("weekly-digest", "Write the weekly digest.") })).status).toBeLessThan(300);
  expect((await local("PUT", `/api/bots/${nova.id}/skills-library`, { skills: ["weekly-digest"] })).status).toBe(200);

  // Bot files, one of which My Cloud already has another version of.
  mkdirSync(join(dataDir("desktop"), "workspaces", nova.id, "drafts"), { recursive: true });
  writeFileSync(join(dataDir("desktop"), "workspaces", nova.id, "notes.md"), "Notes from this computer.\n");
  writeFileSync(join(dataDir("desktop"), "workspaces", nova.id, "drafts", "launch.md"), "Launch draft.\n");
  mkdirSync(join(dataDir("desktop"), "task-workspaces", nova.id, plan.threadId), { recursive: true });
  writeFileSync(join(dataDir("desktop"), "task-workspaces", nova.id, plan.threadId, "report.csv"), "a,b\n1,2\n");
  mkdirSync(join(dataDir("desktop"), "workspaces", nova.id, "node_modules", "left"), { recursive: true });
  writeFileSync(join(dataDir("desktop"), "workspaces", nova.id, "node_modules", "left", "index.js"), "left out\n");
  mkdirSync(join(dataDir("cloud"), "workspaces", nova.id), { recursive: true });
  writeFileSync(join(dataDir("cloud"), "workspaces", nova.id, "notes.md"), "Notes My Cloud wrote.\n");

  // Automations: a routine naming this computer's folder with a finished run, a scheduled call, a webhook and an app event.
  const routine = (await local("POST", "/api/routines", { name: "Morning report", prompt: `Read ${dataDir("desktop")}/workspaces/${nova.id}/notes.md and report.`,
    botId: nova.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
  routineId = (routine.routine ?? routine).id;
  expect((await local("POST", `/api/routines/${routineId}/run`)).status).toBeLessThan(300);
  await expect.poll(async () => ((await local("GET", "/api/routines")).body.runs as Array<{ routineId: string; status: string; id: string }>)
    .find((run) => run.routineId === routineId && run.status === "completed")?.id ?? "", { timeout: 60_000, interval: 250 }).not.toBe("");
  finishedRun = ((await local("GET", "/api/routines")).body.runs as Array<{ routineId: string; status: string; id: string }>).find((run) => run.routineId === routineId && run.status === "completed")!.id;
  await expect.poll(() => idle(local), { timeout: 30_000, interval: 100 }).toBe(true);
  callId = (await local("POST", "/api/calendar-calls", { name: "Weekly sync", botIds: [nova.id], schedule: { type: "daily", time: "10:00", weekdays: [1] } })).body.call.id;
  const webhook = (await local("POST", "/api/webhooks", { name: "Orders", prompt: "File the order.", botId: nova.id })).body;
  webhookId = webhook.webhook.id;
  webhookHere = { endpointId: webhook.webhook.endpointId, secret: webhook.credential.secret };
  broker.account(fx.desktopInstallation!.userId, "gmail");
  const trigger = await local("POST", "/api/app-triggers", { botId: nova.id, name: "Invoices", prompt: "File the invoice.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE" });
  expect(trigger.status, JSON.stringify(trigger.body)).toBeLessThan(300);
  appEventId = trigger.body.trigger.id;

  // A model on the home network, which stays here.
  expect((await local("PATCH", "/api/config", { openaiCompat: { key: HOME_MODEL_KEY, url: "http://192.168.1.20:11434/v1", model: "llama" } })).status).toBe(200);

  first = await fx.move();
  expect(first.result.failed, JSON.stringify(first.result.failed)).toEqual([]);
  const triggersThere = async () => (await onCloud("GET", "/api/app-triggers")).body.triggers as Array<{ id: string; enabled: boolean }>;
  expect(await triggersThere(), "an app event goes only when this computer lets go of it").toEqual([]);
  const final = await fx.move({ final: true });
  expect(final.result.failed, JSON.stringify(final.result.failed)).toEqual([]);

  const report = await fx.check();
  expect(report.gaps, JSON.stringify(report.gaps)).toEqual({ items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [], files: [], runs: [], journal: [], learned: [], teams: [], settings: [] });
  expect(report.chats.filter((entry) => entry.missing || entry.unstamped || entry.path === "broken")).toEqual([]);
  expect(report.ok).toBe(true);

  // Automations arrive switched off, under the same ids, as the owner's, with this computer's folder named as My Cloud's.
  const there = (await onCloud("GET", "/api/routines")).body as { routines: Array<{ id: string; enabled: boolean; prompt: string; nextRunAt: number | null }>; runs: Array<{ id: string }> };
  const routineThere = there.routines.find((entry) => entry.id === routineId)!;
  expect(routineThere).toMatchObject({ enabled: false, nextRunAt: null });
  expect(routineThere.prompt).toBe(`Read ${join(dataDir("cloud"), "workspaces", nova.id, "notes.md")} and report.`);
  expect(there.runs.map((run) => run.id)).toContain(finishedRun);
  const owner = (await rows(onCloud, plan.threadId)).find((row) => row.role === "user")!.sender!.id!;
  expect(owner).toMatch(/^p_/u);
  expect(JSON.parse(readFileSync(join(dataDir("cloud"), "lending-routines.json"), "utf8")).writers[routineId]).toBe(owner);
  expect(((await onCloud("GET", "/api/calendar-calls")).body.calls as Array<{ id: string; nextRunAt: number | null }>).find((call) => call.id === callId)).toMatchObject({ nextRunAt: null });
  const hooks = (await onCloud("GET", "/api/webhooks")).body.webhooks as Array<{ id: string; enabled: boolean; endpointId: string }>;
  const hookThere = hooks.find((hook) => hook.id === webhookId)!;
  expect(hookThere.enabled).toBe(false);
  const address = (await onCloud("GET", `/api/webhooks/${webhookId}/address`)).body.credential as { endpointUrl: string; secret: string };
  expect(hookThere.endpointId).not.toBe(webhookHere.endpointId);
  expect(address.secret).not.toBe(webhookHere.secret);
  expect(address.endpointUrl.endsWith(`/hooks/${hookThere.endpointId}`)).toBe(true);
  expect((await triggersThere()).find((entry) => entry.id === appEventId)).toMatchObject({ enabled: false });
  expect(((await local("GET", "/api/app-triggers")).body.triggers as Array<{ id: string }>).map((entry) => entry.id), "this computer no longer collects it").not.toContain(appEventId);

  // Memory merged: every fact once.
  const merged = entries(await memoryText(onCloud, nova.id, "MEMORY.md"));
  expect(merged.filter((line) => line.includes("Acme pays on the 5th"))).toHaveLength(1);
  expect(merged.some((line) => line.includes("Ship on Fridays")) && merged.some((line) => line.includes("Prefers email"))).toBe(true);
  expect(merged).toHaveLength(3);
  expect(await memoryText(onCloud, nova.id, "memory/log/2026-10-20.md")).toBe("- 09:10 · from chat · Sent the invoice.\n");
  expect(await memoryText(onCloud, nova.id, "memory/clients.md")).toContain("title: Clients");
  const journalThere = new Set(((await onCloud("GET", `/api/bots/${nova.id}/memory/journal?limit=200`)).body.entries as Array<{ id: string }>).map((entry) => entry.id));
  for (const entry of journalHere) expect(journalThere.has(entry.id)).toBe(true);
  const aboutThere = (await onCloud("GET", "/api/config")).body.profile.aboutMe as string;
  expect(aboutThere.split("\n").filter((line) => line.includes("Lives in Pune"))).toHaveLength(1);
  expect(((await onCloud("GET", "/api/section-context?section=Ops")).body.text as string).split("\n").filter(Boolean)).toEqual(["Ops is two people.", "Ops handles invoices."]);
  const team = (await onCloud("GET", "/api/team-memory?section=Ops")).body.entries as Array<{ name: string }>;
  expect(team.map((entry) => entry.name).sort()).toEqual(["Dana", "PO"]);

  // The bot and conversation fields.
  expect(await botOn(onCloud, nova.id)).toMatchObject({ pinned: true, chiefOfStaff: true, fallback: [{ instanceId: "claude", model: "claude-haiku-5" }], projects: [{ id: project, name: "Launch", emoji: "🚀" }] });
  expect(await botOn(onCloud, old.id)).toMatchObject({ hidden: true });
  const planThere = ((await botOn(onCloud, nova.id)).tasks as Array<Record<string, any>>).find((task) => task.threadId === plan.threadId)!;
  expect(planThere).toMatchObject({ projectId: project, snoozedUntil: snooze, approvalMode: "edits", modelSelection: { instanceId: "claude", model: "claude-opus-5" } });
  const roomThere = ((await onCloud("GET", "/api/cloud-send/chats")).body.conversations as Array<{ threadId: string; settings: Record<string, unknown> }>).find((head) => head.threadId === room.threadId);
  expect(roomThere?.settings).toMatchObject({ turnTimeoutMinutes: 45 });

  // A row over 1 MB arrives whole.
  expect((await rows(onCloud, nova.threadId)).find((row) => row.text?.length === longRow.length)?.text).toBe(longRow);

  // Skill extras.
  const skillsThere = (await onCloud("GET", `/api/bots/${nova.id}/skills`)).body as { skills: Array<{ name: string; origin?: string }>; assignedSkills?: string[] };
  expect(skillsThere.skills.filter((skill) => skill.origin === "imported").map((skill) => skill.name).sort()).toEqual(["invoice-check", "tidy-notes"]);
  expect(skillsThere.assignedSkills).toEqual(["weekly-digest"]);
  expect(readFileSync(join(dataDir("cloud"), "imported-skills", "invoice-check", "references", "rules.md"), "utf8")).toBe("Totals must add up.\n");

  // Files: a conflict keeps both, nothing excluded goes, and no part is left over.
  const filesThere = join(dataDir("cloud"), "workspaces", nova.id);
  expect(readFileSync(join(filesThere, "notes.md"), "utf8")).toBe("Notes My Cloud wrote.\n");
  const keptBeside = readdirSync(filesThere).filter((name) => /^notes \(.+\)\.md$/u.test(name));
  expect(keptBeside).toHaveLength(1);
  expect(readFileSync(join(filesThere, keptBeside[0]!), "utf8")).toBe("Notes from this computer.\n");
  expect(readFileSync(join(filesThere, "drafts", "launch.md"), "utf8")).toBe("Launch draft.\n");
  expect(readFileSync(join(dataDir("cloud"), "task-workspaces", nova.id, plan.threadId, "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  expect(existsSync(join(filesThere, "node_modules"))).toBe(false);
  expect(readdirSync(join(dataDir("cloud"), "tmp", "move-files")).filter((name) => name.endsWith(".partial"))).toEqual([]);
  expect(first.result.files).toMatchObject({ kept: 1 });

  // The model on the home network stayed here.
  const connections = (await onCloud("GET", "/api/cloud-connections")).body.connections as Array<{ id: string }>;
  expect(connections.map((entry) => entry.id)).not.toContain("key:openaiCompat");
  for (const where of [...fx.answers, fx.logs()]) expect(where).not.toContain(HOME_MODEL_KEY);
}, hostTimeout(600_000));

it("a move run again changes nothing on My Cloud, and its check still finds everything there", async () => {
  const manifest = async () => (await fx.onCloud("GET", "/api/cloud-send/manifest")).body;
  const before = await manifest();
  const again = await fx.move({ final: true });
  expect(again.result).toMatchObject({ bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: [], failed: [], moved: 0, memory: 0,
    files: { sent: 0, kept: 0 }, conversationSettings: 0, chats: { conversations: 0, messages: 0, left: 0 } });
  expect(await manifest()).toEqual(before);
  expect((await fx.check()).ok).toBe(true);
}, hostTimeout(300_000));
