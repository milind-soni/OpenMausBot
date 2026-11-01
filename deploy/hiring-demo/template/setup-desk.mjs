// Builds the Recruiting Desk inside the OpenMausBot server of this stack: the Desk Manager (the server's Chief of
// Staff), nine teammates in four teams, the Desk HQ room, the deskats MCP server (Desk ATS) switched on, and the
// webhook the ATS uses to wake the Desk Manager. Safe to re-run: existing pieces are updated, never duplicated.
//
// Runs in the `ats` container, which shares the server's network namespace (the server trusts its owner on loopback):
//   docker compose exec ats node template/setup-desk.mjs              first setup (and any time after an upgrade)
//   docker compose exec ats node template/setup-desk.mjs --fresh-room  before a new client: keeps the last Desk HQ
//                                                                      under a dated name, opens a clean one, resets
//                                                                      the ATS
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OMB = `http://127.0.0.1:${process.env.OMB_PORT ?? "8799"}`;
const WEBHOOK_BASE = `http://127.0.0.1:${process.env.OMB_WEBHOOK_PORT ?? "8800"}`;
const ATS = `http://127.0.0.1:${process.env.ATS_PORT ?? "4100"}`;
const FOLDER = process.env.DESK_FOLDER ?? "/desk/recruiting-desk";
const ATS_CONFIG = process.env.ATS_CONFIG ?? join(HERE, "..", "ats", "config.json");
const ENGINE = process.env.DESK_ENGINE ?? "claude";
const STRONG = { instanceId: ENGINE, model: process.env.DESK_STRONG_MODEL ?? "claude-opus-5-5" };
const FAST = { instanceId: ENGINE, model: process.env.DESK_FAST_MODEL ?? "claude-sonnet-5-5" };
const TEAMS = ["Sourcing", "Screening", "Client Delivery", "Onboarding & Billing"];
const FRESH_ROOM = process.argv.includes("--fresh-room");

// ---- the template ------------------------------------------------------------------------------------------
const md = readFileSync(join(HERE, "DESK-MANAGER-PROMPT.md"), "utf8");
function block(afterHeading) {
  const at = md.indexOf(afterHeading);
  if (at < 0) throw new Error(`template is missing: ${afterHeading}`);
  const m = /```\n([\s\S]*?)```/.exec(md.slice(at));
  if (!m) throw new Error(`template has no code block after: ${afterHeading}`);
  return m[1].trim();
}
const DESK_MANAGER_SOUL = block("## 1. Desk Manager soul");
const EVENT_PLAYBOOK = block("## Event playbook");
const TEAMMATES = [
  { name: "Job Board Sourcer", section: "Sourcing", model: FAST, title: "Posts JDs and runs Boolean searches", description: "Posts each requirement to Dice, Monster and LinkedIn and pulls matching profiles into the ATS." },
  { name: "Vendor Bench", section: "Sourcing", model: FAST, title: "Works the C2C vendor bench", description: "Mass-mails C2C vendors about each requirement and imports the consultants they send." },
  { name: "Matcher", section: "Screening", model: STRONG, title: "Scores resumes against the JD", description: "Scores sourced profiles against the requirement and shortlists the top 3 with reasons." },
  { name: "Phone Screener", section: "Screening", model: FAST, title: "Screens candidates by phone and text", description: block("### PHONE SCREENER DESCRIPTION") },
  { name: "Paperwork", section: "Screening", model: FAST, title: "RTR, rate confirmation, NDA, work authorization", description: "Gets the RTR, confirmed rate, NDA and work-authorization documents for every screened candidate." },
  { name: "Submission Writer", section: "Client Delivery", model: STRONG, title: "Writes client submissions, sends after approval", description: "Drafts client submission emails and sends them only after the recruiter approves." },
  { name: "Interview Coordinator", section: "Client Delivery", model: FAST, title: "Schedules interview rounds and collects feedback", description: "Schedules interview rounds, sends reminders and logs client feedback." },
  { name: "Onboarding", section: "Onboarding & Billing", model: FAST, title: "Offer letters, MSAs, background checks, start dates", description: "Runs onboarding after an offer: W-2 offer letter or C2C MSA, background check, laptop, start date." },
  { name: "Timesheets", section: "Onboarding & Billing", model: FAST, title: "Monthly timesheets and billing", description: "Chases monthly timesheets, records client approval and marks hours billed." },
].map((t) => ({ ...t, soul: block(`### ${t.name}\n`) }));
const BULLETIN = [
  "Desk HQ: the recruiting desk's room. The Desk Manager hands out work here; each step's result shows up here.",
  "Try it: say \"start the demo\" (a client requirement arrives), later \"next morning\" (stages 6–7), and \"reset the demo\" to start over.",
  "Shared folder: recruiting-desk (playbook.md first; scoring-rubric.md, screening-checklist.md, submission-template.md, feedback.md, runs-log.md, desk-status.md).",
  "Playing the candidate on the phone screen? You're Kiran Rao: Senior Java Developer, 11 years, Irving TX, H-1B valid to Sept 2028 (C2C through your employer), $66/hr, 2 weeks notice, can start Nov 10, hybrid Tue–Thu in Dallas is fine.",
  "ATS: Desk ATS, reached through the deskats tools. All data is made up.",
  "Rules: only the Desk Manager hands out work; every ATS write passes actor = your bot name; nobody contacts anyone outside the ATS; no submission goes to a client without the recruiter's approval.",
].join("\n");

// ---- helpers -----------------------------------------------------------------------------------------------
async function api(method, path, body, base = OMB) {
  const init = body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}
async function waitFor(url, what) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not answer at ${url}`);
}
const step = (s) => console.log(`\n▸ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);

// ---- 0. Both services up -----------------------------------------------------------------------------------
step("Waiting for OpenMausBot and Desk ATS");
await waitFor(`${OMB}/api/health`, "OpenMausBot");
await waitFor(`${ATS}/api/state`, "Desk ATS");
ok("both answer");

// ---- 1. The bots' shared folder ----------------------------------------------------------------------------
step(`Shared folder ${FOLDER}`);
mkdirSync(FOLDER, { recursive: true });
const source = join(HERE, "recruiting-desk");
for (const file of readdirSync(source)) {
  const target = join(FOLDER, file);
  if (!existsSync(target)) cpSync(join(source, file), target);
}
// The server runs as an unprivileged user; let its bots write feedback.md, runs-log.md and the rest.
chmodSync(FOLDER, 0o777);
for (const file of readdirSync(FOLDER)) chmodSync(join(FOLDER, file), 0o666);
ok(`${readdirSync(FOLDER).length} files ready`);

// ---- 2. ATS connection -------------------------------------------------------------------------------------
step("ATS connection (deskats MCP server)");
const servers = await api("GET", "/api/mcp/servers");
const all = servers.servers ?? servers;
const listed = Array.isArray(all) ? all.some((x) => x.name === "deskats") : Boolean(all.deskats);
// OpenMausBot always saves a new server switched off; it is turned on in a second call.
if (!listed) await api("POST", "/api/mcp/servers", { name: "deskats", type: "http", url: `${ATS}/mcp` });
await api("PATCH", "/api/mcp/servers/deskats", { enabled: true });
const tested = await api("POST", "/api/mcp/servers/deskats/test", {});
const after = (await api("GET", "/api/mcp/servers")).servers ?? (await api("GET", "/api/mcp/servers"));
const entry = Array.isArray(after) ? after.find((x) => x.name === "deskats") : after.deskats;
if (entry?.enabled !== true) throw new Error("deskats is still switched off after enabling it");
ok(`deskats on, ${(tested.tools ?? tested.result?.tools ?? []).length || "?"} tools`);

// ---- 3. Desk Manager (the server's Chief of Staff) ---------------------------------------------------------
step("Desk Manager");
let { bots } = await api("GET", "/api/bots");
const managerProfile = {
  name: "Desk Manager", title: "Runs the recruiting desk",
  description: "Takes in client requirements, hands every stage to the right team, watches time-to-submit.",
};
let manager = bots.find((b) => b.chiefOfStaff) ?? bots.find((b) => b.name === "Desk Manager");
if (!manager) {
  manager = (await api("POST", "/api/bots", { ...managerProfile, modelSelection: STRONG,
    settings: { soul: DESK_MANAGER_SOUL, cwd: FOLDER, approvalMode: "full", chiefOfStaff: true } })).bot;
  ok(`created ${manager.id}`);
} else {
  await api("PATCH", `/api/bots/${manager.id}`, { ...managerProfile, soul: DESK_MANAGER_SOUL, cwd: FOLDER, approvalMode: "full", modelSelection: STRONG });
  ok(`${manager.id} set up`);
}

// ---- 4. Teammates ------------------------------------------------------------------------------------------
step("Teammates");
const ids = {};
for (const t of TEAMMATES) {
  const existing = bots.find((b) => b.name === t.name);
  if (existing) {
    await api("PATCH", `/api/bots/${existing.id}`, { title: t.title, description: t.description, soul: t.soul, cwd: FOLDER, section: t.section, approvalMode: "full", modelSelection: t.model });
    ids[t.name] = existing.id;
    ok(`${t.name} updated`);
  } else {
    const created = await api("POST", "/api/bots", { name: t.name, title: t.title, description: t.description, section: t.section,
      modelSelection: t.model, settings: { soul: t.soul, cwd: FOLDER, approvalMode: "full" } });
    ids[t.name] = created.bot.id;
    ok(`${t.name} created (${t.section})`);
  }
}
await api("PATCH", `/api/bots/${manager.id}`, { chiefOfStaff: true, managedSections: TEAMS, acknowledgePeerScope: true });
ok(`Desk Manager reaches ${TEAMS.join(", ")}`);

// ---- 5. Desk HQ room ---------------------------------------------------------------------------------------
step("Desk HQ room");
({ bots } = await api("GET", "/api/bots"));
const { groups = [] } = await api("GET", "/api/bots");
let room = groups.find((g) => g.name === "Desk HQ");
if (room && FRESH_ROOM) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  await api("PATCH", `/api/groups/${room.id}`, { name: `Desk HQ (run ${stamp})` });
  ok(`kept the last room as "Desk HQ (run ${stamp})"`);
  room = undefined;
}
if (!room) {
  room = (await api("POST", "/api/groups", {
    name: "Desk HQ", memberIds: [manager.id, ...TEAMMATES.map((t) => ids[t.name])],
    setup: { bulletin: BULLETIN, defaultResponder: { kind: "member", botId: manager.id } },
  })).group;
  ok(`created ${room.id} with 10 members`);
} else {
  ok(`already there (${room.id})`);
}

// ---- 6. Webhook: the ATS wakes the Desk Manager ------------------------------------------------------------
step("ATS events webhook");
const hookBody = {
  name: "Desk ATS events", prompt: EVENT_PLAYBOOK, botId: manager.id, enabled: true, delivery: "run",
  eventTypes: ["requirement.email_received", "screen.logged", "desk.morning_events"], maxPendingRuns: 10,
};
let hook = (await api("GET", "/api/webhooks")).webhooks.find((h) => h.name === "Desk ATS events");
if (!hook) {
  hook = (await api("POST", "/api/webhooks", hookBody)).webhook;
  ok(`created ${hook.id}`);
} else {
  await api("PATCH", `/api/webhooks/${hook.id}`, { prompt: EVENT_PLAYBOOK, enabled: true, eventTypes: hookBody.eventTypes, maxPendingRuns: 10 });
  ok(`updated ${hook.id}`);
}
const { credential } = await api("GET", `/api/webhooks/${hook.id}/address`);
const printed = credential?.url ?? credential?.address;
if (!printed) throw new Error("the webhook has no address yet");
// The printed address is the public one; the ATS sits on the same loopback, so it calls the receiver directly.
const local = `${WEBHOOK_BASE}${new URL(printed).pathname}`;
let current = {};
try { current = JSON.parse(readFileSync(ATS_CONFIG, "utf8")); } catch { /* first write */ }
mkdirSync(dirname(ATS_CONFIG), { recursive: true });
writeFileSync(ATS_CONFIG, JSON.stringify({ port: 4100, webhookSecret: null, delays: null, ...current, webhookUrl: local }, null, 2) + "\n");
ok("the ATS now wakes the Desk Manager (it reads this on the next event, no restart)");

// ---- 7. Clean ATS for a new client -------------------------------------------------------------------------
if (FRESH_ROOM) {
  await api("POST", "/api/demo/reset", {}, ATS);
  ok("ATS reset to its starting state");
}

console.log(`\nDone. Open Desk HQ and say "start the demo".`);
