// "Move to Acme" end to end: the person's My Cloud (OMB_CLOUD_ROLE=home) and their team's Cloud (OMB_CLOUD_ROLE=team)
// as real servers (scripts/testing/cloud-send-fixture.ts), the Admin's signed team pairing faked as the fixture fakes it,
// and main's own wiring (team-move-main.mjs through one-home-main.mjs) moving one bot between them. The engine is the
// synthetic Claude CLI, so this proves the plumbing, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ACME = { id: "team-acme-1", name: "Acme" };
// Facts only Ada's notes on My Cloud hold: they must never reach Acme.
const NOTE = "Ada drinks oolong-7731 every morning.";
const ABOUT = "Ada's partner is Fernando-4471.";
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";`;

let fx: CloudSendFixture, team: CloudTeamFixture;
const tokens: Record<string, string> = {};
const adaKey = personKey({ id: "", email: ADA.email });
type Bot = { id: string; threadId: string; name: string; tasks?: Array<{ threadId: string; private?: true; title?: string }>; movedTo?: { team: { id: string; name: string }; state: string }; hidden?: boolean };

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-move-${randomBytes(8).toString("hex")}`, team: { ...ACME, engine: ENGINE } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ olive: OWNER, ben: ADMIN, ada: ADA, cleo: CLEO })) tokens[who] = (await team.pair(member)).token!;
  // Ada's MausBot Cloud sign-in lists Acme, and the Admin pairs her there as herself.
  fx.account.state.teams = [{ ...ACME, role: "member", machine: { origin: team.base, status: "ready", state: "ready" } }];
  fx.account.pairTeam = async (id) => { if (id !== ACME.id) throw Object.assign(new Error("not in that team"), { gone: true }); return team.grant(ADA); };
  expect((await fx.onCloud("PATCH", "/api/config", { profile: { name: "Ada", aboutMe: ABOUT } })).status).toBe(200);
  await nameSeededChiefs();
}, hostTimeout(180_000));
const watchers: Array<() => void> = [];
afterAll(async () => { for (const stop of watchers) stop(); await fx?.close(); }, hostTimeout(60_000));
/** Main's channel as My Cloud's page calls it, a refusal as the page gets it. */
const ask = <T>(channel: string, page: "local" | "cloud", ...args: unknown[]) => (async () => fx.call<T>(channel, page, ...args))();

const idle = async (side: CloudSendFixture["onCloud"]) => ((await side("GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
const rows = async (side: CloudSendFixture["onCloud"], threadId: string) => ((await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body?.messages ?? []) as Array<{ id: string; role: string; text?: string; sender?: { id?: string } }>;
async function say(bot: { id: string }, threadId: string, text: string) {
  const before = (await rows(fx.onCloud, threadId)).length;
  expect((await fx.onCloud("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
  await expect.poll(async () => await idle(fx.onCloud) && (await rows(fx.onCloud, threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const onTeam = (who: string) => (method: string, path: string, body?: unknown) => team.as(tokens[who]!, method, path, body);
const teamBots = async (who: string) => (await onTeam(who)("GET", "/api/bots")).body.bots as Bot[];
const cloudBots = async () => (await fx.onCloud("GET", "/api/bots")).body.bots as Bot[];
const cloudHome = (...rest: string[]) => join(fx.root, "cloud", ".openmausbot", ...rest);
const teamHome = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);

/** A bot on My Cloud with two chats, a routine that is on, two files and notes about Ada. */
async function botWithEverything(name: string) {
  const created = await fx.onCloud("POST", "/api/bots", { name, soul: `You are ${name}. You plan trips.`, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as Bot;
  await say(bot, bot.threadId, `${name}: plan Lisbon for May.`);
  const task = await fx.onCloud("POST", `/api/bots/${bot.id}/tasks`, { title: "Budget" });
  expect(task.status, JSON.stringify(task.body)).toBe(201);
  const budget = task.body.task.threadId as string;
  await say(bot, budget, `${name}: keep it under 900.`);
  expect((await fx.onCloud("PUT", `/api/bots/${bot.id}/memory/file`, { path: "MEMORY.md", text: `# Notes\n\n- ${NOTE}\n` })).status).toBe(200);
  const routine = await fx.onCloud("POST", "/api/routines", { name: `${name} brief`, prompt: "Say good morning.", botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 6 * 60 * 60_000 } });
  expect(routine.status, JSON.stringify(routine.body)).toBe(201);
  expect(routine.body.routine.enabled).toBe(true);
  mkdirSync(cloudHome("workspaces", bot.id, "plans"), { recursive: true });
  writeFileSync(cloudHome("workspaces", bot.id, "report.md"), `# ${name} report\nLisbon, May.\n`);
  writeFileSync(cloudHome("workspaces", bot.id, "plans", "day-one.txt"), "Belem, then Alfama.\n");
  return { bot, main: bot.threadId, budget, routine: routine.body.routine.id as string };
}

/** Both sides' switch of one routine, sampled while a move runs: it must never be on in both places. */
function watchRoutine(id: string) {
  const seen: Array<{ mine: boolean | null; theirs: boolean | null }> = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      try {
        const [mine, theirs] = await Promise.all([fx.onCloud("GET", "/api/routines"), onTeam("olive")("GET", "/api/routines")]);
        const find = (body: any) => (body?.routines as Array<{ id: string; enabled: boolean }> | undefined)?.find((routine) => routine.id === id)?.enabled ?? null;
        seen.push({ mine: find(mine.body), theirs: find(theirs.body) });
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  })();
  watchers.push(() => { stop = true; });
  return { seen, stop: async () => { stop = true; await done; } };
}

/** Each home seeds its Chief under a random bot name, Scout and Quill among them; these bots must be the only ones so named. */
async function nameSeededChiefs() {
  for (const [side, name] of [[fx.onCloud, "Ada's Chief"], [onTeam("olive"), "Acme's Chief"]] as const) {
    for (const bot of (await side("GET", "/api/bots")).body.bots as Bot[]) expect((await side("PATCH", `/api/bots/${bot.id}`, { name })).status).toBe(200);
  }
}

const move = async (bot: Bot) => { await fx.teamMove.start({ bot: { id: bot.id, name: bot.name }, team: { ...ACME, origin: team.base } }); };
const phaseOf = (id: string) => (fx.teamMove.journal()?.moves as Array<{ bot: { id: string }; phase: string; failing?: true }> | undefined)?.find((entry) => entry.bot.id === id);

let scout: Awaited<ReturnType<typeof botWithEverything>>;

it("moves Scout with its two chats, its routine and its files; its notes about Ada stay on My Cloud", async () => {
  scout = await botWithEverything("Scout");
  const watch = watchRoutine(scout.routine);
  // Stopped the moment the check passed, before the switch: the routine is in Acme, off, and off on My Cloud too.
  fx.beforeTeamJournalWrite = (value) => {
    if ((value?.moves ?? []).some((entry: { bot: { id: string }; phase: string }) => entry.bot.id === scout.bot.id && entry.phase === "switch")) throw new Error("held at the switch");
  };
  await move(scout.bot);
  fx.beforeTeamJournalWrite = null;
  expect(phaseOf(scout.bot.id)?.phase).toBe("check");
  const routineOn = async (side: CloudSendFixture["onCloud"]) => ((await side("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>).find((routine) => routine.id === scout.routine)?.enabled;
  expect([await routineOn(fx.onCloud), await routineOn(onTeam("olive"))], "off on both sides until the switch").toEqual([false, false]);
  expect(fx.teamMove.view()?.phase).toBe("moving");
  await fx.teamMove.kick();
  await watch.stop();
  expect(phaseOf(scout.bot.id)?.phase, JSON.stringify(fx.teamMove.journal())).toBe("done");
  expect(fx.teamMove.view()).toEqual({ bot: { id: scout.bot.id, name: "Scout" }, team: ACME, phase: "done" });

  // Everyone in Acme has Scout.
  for (const who of ["olive", "ben", "ada", "cleo"]) expect((await teamBots(who)).some((bot) => bot.id === scout.bot.id && bot.name === "Scout"), who).toBe(true);
  // Its two chats are Ada's own there: private, never the team's main chat, with her lines as hers.
  const there = (await teamBots("ada")).find((bot) => bot.id === scout.bot.id)!;
  expect(there.threadId === scout.main || (there as { mainThreadId?: string }).mainThreadId === scout.main, "its main chat in Acme is a new one of the team's").toBe(false);
  for (const threadId of [scout.main, scout.budget]) {
    expect(there.tasks?.find((task) => task.threadId === threadId)?.private, threadId).toBe(true);
    const moved = await rows(onTeam("ada"), threadId);
    expect(moved.map((row) => row.id)).toEqual((await rows(fx.onCloud, threadId)).map((row) => row.id));
    expect(moved.filter((row) => row.role === "user").every((row) => row.sender?.id === adaKey)).toBe(true);
    expect((await onTeam("ben")("GET", `/api/threads/${threadId}/messages`)).status, "an Admin never sees it").toBe(404);
    expect((await onTeam("olive")("GET", `/api/threads/${threadId}/messages`)).status, "nor does the Owner").toBe(404);
    expect((await onTeam("cleo")("GET", `/api/threads/${threadId}/messages`)).status, "another Member never does").toBe(404);
  }
  expect((await teamBots("cleo")).find((bot) => bot.id === scout.bot.id)!.tasks?.some((task) => [scout.main, scout.budget].includes(task.threadId))).toBe(false);

  // The routine arrived off and was switched on after the check; it is gone from My Cloud, never on in both places.
  const routines = (await onTeam("ada")("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean; resultsThreadId?: string; botId: string }>;
  const carried = routines.find((routine) => routine.id === scout.routine)!;
  expect(carried).toMatchObject({ enabled: true, botId: scout.bot.id });
  expect(carried.resultsThreadId).not.toBe((there as { mainThreadId?: string }).mainThreadId);
  expect(there.tasks?.find((task) => task.threadId === carried.resultsThreadId)?.private, "its results conversation came with it, as Ada's").toBe(true);
  // It reports into Ada's own conversation there, never the team's main chat.
  const ran = await onTeam("olive")("POST", `/api/routines/${scout.routine}/run`);
  expect(ran.status, JSON.stringify(ran.body)).toBeLessThan(300);
  // Its run is Ada's: she sees it, and the Owner who started it never reads what it said.
  await expect.poll(async () => ((await onTeam("ada")("GET", "/api/routines")).body.runs as Array<{ routineId: string; status: string }>)
    .some((run) => run.routineId === scout.routine && run.status === "completed"), { timeout: 60_000, interval: 200 }).toBe(true);
  const report = ((await onTeam("ada")("GET", "/api/routines")).body.runs as Array<{ routineId: string; threadId?: string; resultsThreadId?: string }>).find((run) => run.routineId === scout.routine)!;
  expect(((await onTeam("olive")("GET", "/api/routines")).body.runs as Array<{ routineId: string }>).some((run) => run.routineId === scout.routine)).toBe(false);
  for (const threadId of new Set([report.threadId!, report.resultsThreadId ?? carried.resultsThreadId!])) {
    expect((await onTeam("ada")("GET", `/api/threads/${threadId}/messages`)).status, threadId).toBe(200);
    expect((await onTeam("cleo")("GET", `/api/threads/${threadId}/messages`)).status, threadId).toBe(404);
    expect((await onTeam("olive")("GET", `/api/threads/${threadId}/messages`)).status, threadId).toBe(404);
  }
  expect(((await fx.onCloud("GET", "/api/routines")).body.routines as Array<{ id: string }>).some((routine) => routine.id === scout.routine)).toBe(false);
  expect(watch.seen.some((sample) => sample.mine && sample.theirs), JSON.stringify(watch.seen)).toBe(false);

  // Its files are there.
  expect(readFileSync(teamHome("workspaces", scout.bot.id, "report.md"), "utf8")).toBe("# Scout report\nLisbon, May.\n");
  expect(readFileSync(teamHome("workspaces", scout.bot.id, "plans", "day-one.txt"), "utf8")).toBe("Belem, then Alfama.\n");

  // Its notes about Ada stayed on My Cloud, and nothing in Acme reads them.
  expect((await fx.onCloud("GET", `/api/bots/${scout.bot.id}/memory/file?path=MEMORY.md`)).body.text).toContain(NOTE);
  const teamNotes = teamHome("workspaces", scout.bot.id, "MEMORY.md");
  expect(existsSync(teamNotes) ? readFileSync(teamNotes, "utf8") : "").not.toContain("oolong");
  expect((await onTeam("ada")("GET", "/api/me")).body?.aboutMe ?? "").not.toContain("Fernando");
  rmSync(join(team.home, "dump.json"), { force: true });
  expect((await onTeam("ada")("POST", `/api/bots/${scout.bot.id}/messages`, { text: "What do I drink in the morning?", threadId: scout.main })).status).toBe(202);
  await expect.poll(() => existsSync(join(team.home, "dump.json")), { timeout: 60_000, interval: 100 }).toBe(true);
  await expect.poll(async () => idle(onTeam("ada")), { timeout: 60_000, interval: 100 }).toBe(true);
  const turn = readFileSync(join(team.home, "dump.json"), "utf8");
  expect(turn).not.toContain("oolong-7731");
  expect(turn).not.toContain("Fernando-4471");

  // My Cloud keeps Scout as the line that opens it in Acme, and Scout takes no turn there.
  const kept = (await cloudBots()).find((bot) => bot.id === scout.bot.id)!;
  expect(kept).toMatchObject({ hidden: true, movedTo: { team: ACME, state: "moved" } });
  const refused = await fx.onCloud("POST", `/api/bots/${scout.bot.id}/messages`, { text: "Still there?", threadId: scout.main });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("Scout lives in Acme now.");
  await fx.call("cloud-send:team-open", "cloud", ACME.id);
  expect(fx.spies.opened.at(-1)).toBe(`team:${ACME.id}`);
}, hostTimeout(240_000));

it("a move cut short, by the app killed while My Cloud holds the bot and by a dropped request, goes on to the end: nothing doubled, the routine never on in two places", async () => {
  const quill = await botWithEverything("Quill");
  const watch = watchRoutine(quill.routine);
  // A dropped request while the chats go is carried by the next pass; the Admin not answering the team pairing fails the
  // pass, and the move tries again later, the bot never held.
  let drops = 1;
  fx.intercept = (url, init) => (url.startsWith(team.base) && url.endsWith("/api/cloud-send/chats") && init.method === "POST" && drops-- > 0 ? new Response("gateway down", { status: 502 }) : null);
  const pairing = fx.account.pairTeam;
  let silent = 0;
  fx.account.pairTeam = async (id) => { if (silent++ === 0) throw new TypeError("fetch failed"); return pairing(id); };
  await move(quill.bot);
  fx.intercept = null;
  fx.account.pairTeam = pairing;
  expect(phaseOf(quill.bot.id)).toMatchObject({ phase: "copy", failing: true });
  expect(fx.teamMove.view()?.phase).toBe("failed");
  expect((await cloudBots()).find((bot) => bot.id === quill.bot.id)?.movedTo, "nothing held on My Cloud").toBeUndefined();
  // The app is killed on its way into the check, with My Cloud holding Quill.
  fx.beforeTeamJournalWrite = (value) => {
    if ((value?.moves ?? []).some((entry: { bot: { id: string }; phase: string }) => entry.bot.id === quill.bot.id && entry.phase === "check")) throw new Error("the app was killed");
  };
  await fx.teamMove.retry();
  fx.beforeTeamJournalWrite = null;
  expect(phaseOf(quill.bot.id)?.phase).toBe("final");
  expect((await cloudBots()).find((bot) => bot.id === quill.bot.id)?.movedTo?.state, "My Cloud still holds it").toBe("moving");
  const held = await fx.onCloud("POST", `/api/bots/${quill.bot.id}/messages`, { text: "Quill: one more thing.", threadId: quill.main });
  expect([held.status, held.body.error]).toEqual([409, "Quill is moving to Acme. It's ready there in a moment."]);
  await fx.relaunch();
  await fx.teamMove.kick();
  await watch.stop();
  expect(phaseOf(quill.bot.id)?.phase, JSON.stringify(fx.teamMove.journal())).toBe("done");

  const there = (await teamBots("olive")).filter((bot) => bot.id === quill.bot.id || bot.name.startsWith("Quill"));
  expect(there.map((bot) => bot.id)).toEqual([quill.bot.id]);
  for (const threadId of [quill.main, quill.budget]) {
    const ids = (await rows(onTeam("ada"), threadId)).map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual((await rows(fx.onCloud, threadId)).map((row) => row.id));
  }
  const routines = ((await onTeam("olive")("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>).filter((routine) => routine.id === quill.routine);
  expect(routines).toEqual([expect.objectContaining({ enabled: true })]);
  expect(watch.seen.some((sample) => sample.mine && sample.theirs), JSON.stringify(watch.seen)).toBe(false);
}, hostTimeout(300_000));

it("a bot whose name Acme already uses arrives as \"Scout (Ada)\"", async () => {
  const again = await fx.onCloud("POST", "/api/bots", { name: "Scout", soul: "Another Scout." });
  expect(again.status).toBe(201);
  const bot = again.body.bot as Bot;
  await say(bot, bot.threadId, "Hello, second Scout.");
  await move(bot);
  expect(phaseOf(bot.id)?.phase).toBe("done");
  expect((await teamBots("cleo")).find((entry) => entry.id === bot.id)?.name).toBe("Scout (Ada)");
  expect((await teamBots("cleo")).find((entry) => entry.id === scout.bot.id)?.name).toBe("Scout");
}, hostTimeout(180_000));

it("refuses a team the person isn't in, any page but My Cloud's, and Ada leaving Acme mid-move lets the bot go on on My Cloud", async () => {
  const pip = (await fx.onCloud("POST", "/api/bots", { name: "Pip", soul: "Pip." })).body.bot as Bot;
  await expect(ask("cloud-send:team-move", "cloud", pip.id, "team-beta-9", "Pip")).rejects.toThrow("You're not in that team.");
  await expect(ask("cloud-send:team-move", "local", pip.id, ACME.id, "Pip")).rejects.toThrow(/only available on My Cloud/);
  expect((await ask<{ teams: unknown[] }>("cloud-send:teams", "cloud")).teams).toEqual([{ ...ACME, ready: true }]);
  // Removed from Acme while My Cloud holds Pip (the app killed right then): Pip goes on on My Cloud, and the move stops.
  const listed = fx.account.state.teams;
  fx.beforeTeamJournalWrite = (value) => {
    if (!(value?.moves ?? []).some((entry: { bot: { id: string }; phase: string }) => entry.bot.id === pip.id && entry.phase === "final")) return;
    fx.account.state.teams = [];
    throw new Error("the app was killed");
  };
  await move(pip);
  expect((await cloudBots()).find((bot) => bot.id === pip.id)?.movedTo?.state).toBe("moving");
  fx.beforeTeamJournalWrite = null;
  await fx.teamMove.kick();
  expect(phaseOf(pip.id)).toMatchObject({ phase: "copy", failing: true, stopped: true, error: "You're no longer in Acme." });
  expect((await cloudBots()).find((bot) => bot.id === pip.id)?.movedTo).toBeUndefined();
  fx.account.state.teams = listed;
}, hostTimeout(180_000));

it("refuses someone else's bot: Acme's own, one another person moves, and anything but its own bot to a move-in sign-in", async () => {
  const olives = (await onTeam("olive")("POST", "/api/bots", { name: "Inbox Helper" })).body.bot as Bot;
  const begin = (who: string, id: string, name = "Mine") => onTeam(who)("POST", "/api/team-move-in", { v: 1, bot: { id, name }, label: who });
  expect(await begin("ada", olives.id)).toMatchObject({ status: 409, body: { error: "Acme already has this bot." } });
  expect((await begin("cleo", scout.bot.id)).status, "Ada moved Scout in; Cleo can't take it over").toBe(409);
  const id = `own-${randomBytes(6).toString("hex")}`;
  const ada = await begin("ada", id);
  expect(ada.status, JSON.stringify(ada.body)).toBe(200);
  expect((await begin("cleo", id)).body.error).toBe("Someone else is moving this bot into Acme.");
  const moveIn = (method: string, path: string, body?: unknown) => team.as(ada.body.token as string, method, path, body);
  expect((await moveIn("PATCH", `/api/bots/${olives.id}`, { soul: "Hijacked." })).status).toBe(403);
  expect((await moveIn("GET", "/api/bots")).status).toBe(403);
  expect((await moveIn("POST", "/api/bots", { id: olives.id, name: "Copy" })).status).toBe(403);
  expect((await moveIn("PUT", "/api/cloud-send/kind", { v: 1, key: `routine:${scout.routine}`, dataDir: "/x", record: { id: scout.routine, botId: id, target: "bot" } })).status).toBe(403);
  expect((await moveIn("POST", "/api/cloud-send/chats", { v: 1, dataDir: "/x", conversations: [{ bot: scout.bot.id, threadId: scout.main, task: null, rows: [], leaf: null, sent: false }] })).status).toBe(403);
  expect((await moveIn("POST", `/api/cloud-send/files?path=workspaces/${scout.bot.id}/x.txt&size=1&sha256=${"0".repeat(64)}&offset=0&mode=new`)).status).toBe(403);
  const manifest = await moveIn("GET", "/api/cloud-send/manifest");
  expect(manifest.status).toBe(200);
  expect(manifest.body.items, "it reads its own bot only, which isn't here yet").toEqual([]);
  expect(manifest.body.conversations).toEqual([]);
  expect((await moveIn("GET", "/api/cloud-send/files")).body.files, "never another bot's files").toEqual([]);
  expect((await moveIn("GET", "/api/cloud-send/chats")).body.conversations, "never another bot's conversations").toEqual([]);
  expect((await moveIn("GET", "/api/cloud-send?move=1")).body.items).toEqual([]);
  // A Member's own session never reaches the move routes.
  expect((await onTeam("cleo")("GET", "/api/cloud-send/manifest")).status).toBe(403);
}, hostTimeout(120_000));

it("Ada's moved chats are hers on any device: the server names them among the conversations she opened", async () => {
  const made = await team.as(tokens.ben!, "POST", `/api/bots/${scout.bot.id}/tasks`, {});
  expect(made.status).toBe(201);
  const adas = (await onTeam("ada")("GET", "/api/auth/session")).body.openedThreads as string[];
  expect(adas).toEqual(expect.arrayContaining([scout.main, scout.budget]));
  expect(adas).not.toContain(made.body.task.threadId);
  expect((await onTeam("ben")("GET", "/api/auth/session")).body.openedThreads).toContain(made.body.task.threadId);
}, hostTimeout(60_000));
