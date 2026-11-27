// "Move to Acme" from this computer, end to end: a person whose only Cloud is their team's (no My Cloud of their own)
// moves three of this computer's bots into it, through main's own channels as this computer's page calls them
// (team-move-main.mjs through one-home-main.mjs). This computer's server and the Team Cloud (OMB_CLOUD_ROLE=team) are
// real servers (scripts/testing/cloud-send-fixture.ts), the Admin's signed team pairing is faked as the fixture fakes
// it, and the engine is the synthetic Claude CLI, so this proves the plumbing, not a model's judgement.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ACME = { id: "team-acme-1", name: "Acme" };
// A fact only Olive's notes on this computer hold: it must never reach Acme.
const NOTE = "Olive drinks oolong-5512 every morning.";

let fx: CloudSendFixture, team: CloudTeamFixture;
const tokens: Record<string, string> = {};
const oliveKey = personKey({ id: "", email: OWNER.email });
type Bot = { id: string; threadId: string; name: string; hidden?: boolean; defaultBot?: boolean; chiefOfStaff?: boolean; access?: unknown;
  tasks?: Array<{ threadId: string; private?: true }>; movedTo?: { team: { id: string; name: string }; state: string } };
type Routine = { id: string; botId: string; enabled: boolean };
type Many = { view?: { phase: string; batch?: Array<{ id: string; phase: string }> } | null; refused?: { code: string } };

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-move-computer-${randomBytes(8).toString("hex")}`, team: { ...ACME } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ olive: OWNER, ben: ADMIN, cleo: CLEO })) tokens[who] = (await team.pair(member)).token!;
  // Olive pays for Acme and has no My Cloud: her MausBot Cloud sign-in lists Acme and no machine of her own.
  fx.account.state = { status: "connected", account: { id: "acct-olive", email: OWNER.email }, entitlement: { plan: "pro", tier: "team", status: "active", expiresAt: null, version: 1 },
    teams: [{ ...ACME, role: "owner", machine: { origin: team.base, status: "ready", state: "ready" } }] };
  fx.account.pairTeam = async (id) => { if (id !== ACME.id) throw Object.assign(new Error("not in that team"), { gone: true }); return team.grant(OWNER); };
  expect((await fx.local("PATCH", "/api/config", { profile: { name: "Olive" } })).status).toBe(200);
}, hostTimeout(180_000));
const watchers: Array<() => void> = [];
afterAll(async () => { for (const stop of watchers) stop(); await fx?.close(); }, hostTimeout(60_000));

const ask = <T>(channel: string, ...args: unknown[]) => fx.call<T>(channel, "local", ...args);
const onTeam = (who: string) => (method: string, path: string, body?: unknown) => team.as(tokens[who]!, method, path, body);
const teamBots = async (who: string) => (await onTeam(who)("GET", "/api/bots")).body.bots as Bot[];
const localBots = async () => (await fx.local("GET", "/api/bots")).body.bots as Bot[];
const localRoutines = async () => (await fx.local("GET", "/api/routines")).body.routines as Routine[];
const teamRoutines = async (who: string) => (await onTeam(who)("GET", "/api/routines")).body.routines as Routine[];
const rows = async (side: CloudSendFixture["local"], threadId: string) => ((await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body?.messages ?? []) as Array<{ id: string; role: string; sender?: { id?: string } }>;
const idle = async () => ((await fx.local("GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
const desktopHome = (...rest: string[]) => join(fx.desktopDataDir, ...rest);
const teamHome = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const journal = () => (fx.teamMove.journal()?.moves ?? []) as Array<{ bot: { id: string }; phase: string; from?: string; failing?: true; stopped?: true; why?: string }>;
const settled = (ids: string[]) => expect.poll(() => ids.every((id) => journal().find((move) => move.bot.id === id)?.phase === "done"), { timeout: 240_000, interval: 250 }).toBe(true);

async function say(bot: { id: string }, threadId: string, text: string) {
  const before = (await rows(fx.local, threadId)).length;
  expect((await fx.local("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
  await expect.poll(async () => await idle() && (await rows(fx.local, threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}

/** A bot on this computer with a chat; `routine`: a routine that is on; `file`: a file in its folder; `engine`: then set
 * to run on an AI only this computer has. */
async function botHere(name: string, { routine = false, file = false, engine = "" } = {}) {
  const created = await fx.local("POST", "/api/bots", { name, soul: `You are ${name}.`, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as Bot;
  await say(bot, bot.threadId, `${name}: plan Porto for June.`);
  expect((await fx.local("PUT", `/api/bots/${bot.id}/memory/file`, { path: "MEMORY.md", text: `# Notes\n\n- ${NOTE}\n` })).status).toBe(200);
  let routineId: string | null = null;
  if (routine) {
    const made = await fx.local("POST", "/api/routines", { name: `${name} brief`, prompt: "Say good morning.", botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 6 * 60 * 60_000 } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.routine.enabled).toBe(true);
    routineId = made.body.routine.id as string;
  }
  if (engine) expect((await fx.local("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine, model: "llama-9" } })).status).toBe(200);
  if (file) {
    mkdirSync(desktopHome("workspaces", bot.id), { recursive: true });
    writeFileSync(desktopHome("workspaces", bot.id, "report.md"), `# ${name} report\nPorto, June.\n`);
  }
  return { bot, routine: routineId };
}

/** Both sides' switch of one routine, sampled while the moves run: it must never be on in both places. */
function watchRoutine(id: string) {
  const seen: Array<{ here: boolean | null; there: boolean | null }> = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      try {
        const [here, there] = await Promise.all([localRoutines(), teamRoutines("olive")]);
        seen.push({ here: here.find((routine) => routine.id === id)?.enabled ?? null, there: there.find((routine) => routine.id === id)?.enabled ?? null });
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  })();
  watchers.push(() => { stop = true; });
  return { seen, stop: async () => { stop = true; await done; } };
}

let moved: Array<Awaited<ReturnType<typeof botHere>>> = [];

it("offers Acme on this computer's page, and refuses the bots that stay: MausBot, the Chief of Staff, a team the person isn't in", async () => {
  expect(await ask("cloud-send:teams")).toEqual({ teams: [{ ...ACME, ready: true }], from: "computer" });
  const listed = await ask<{ bots: Array<{ id: string; name: string; stays?: string }> }>("cloud-send:team-choices");
  const here = await localBots();
  const mausBot = here.find((bot) => bot.defaultBot);
  if (mausBot) expect(listed.bots.find((bot) => bot.id === mausBot.id)?.stays).toBe("default");
  const chief = here.find((bot) => bot.chiefOfStaff && !bot.defaultBot);
  if (chief) expect(listed.bots.find((bot) => bot.id === chief.id)?.stays).toBe("chief");
  const staying = [mausBot, chief].filter((bot): bot is Bot => Boolean(bot)).map((bot) => bot.id);
  if (staying.length) expect(await ask<Many>("cloud-send:team-move-many", staying, ACME.id)).toEqual({ refused: expect.objectContaining({ code: "notABot" }) });
  expect(await ask<Many>("cloud-send:team-move-many", staying, "team-beta-9")).toEqual({ refused: expect.objectContaining({ code: "notInTeam" }) });
  expect(journal()).toEqual([]);
}, hostTimeout(60_000));

it("moves three bots, one after another, with their chats, a routine, a file and an AI only this computer has; the app quit half-way goes on where it was", async () => {
  moved = [await botHere("Scout", { routine: true }), await botHere("Quill", { file: true }), await botHere("Wren", { engine: "ollama-here" })];
  const ids = moved.map((entry) => entry.bot.id);
  const watch = watchRoutine(moved[0]!.routine!);
  // The app is killed while Quill, the second, is on its way into the check: Scout is in Acme, Quill held here.
  let killed = false;
  fx.beforeTeamJournalWrite = (value) => {
    if (killed || !(value?.moves ?? []).some((entry: { bot: { id: string }; phase: string }) => entry.bot.id === ids[1] && entry.phase === "check")) return;
    killed = true;
    throw new Error("the app was killed");
  };
  const started = await ask<Many>("cloud-send:team-move-many", ids, ACME.id);
  expect(started.view?.batch?.map((bot) => bot.id)).toEqual(ids);
  await expect.poll(() => killed, { timeout: 240_000, interval: 250 }).toBe(true);
  await fx.relaunch();
  fx.beforeTeamJournalWrite = null;
  expect(journal().find((move) => move.bot.id === ids[1])?.phase).toBe("final");
  expect(journal().find((move) => move.bot.id === ids[0])?.phase).toBe("done");
  expect(journal().find((move) => move.bot.id === ids[2])?.phase).toBe("copy");
  expect((await localBots()).find((bot) => bot.id === ids[1])?.movedTo?.state, "this computer holds Quill").toBe("moving");
  await fx.teamMove.kick();
  await settled(ids);
  await watch.stop();
  expect(journal().every((move) => move.from === "computer")).toBe(true);
  expect(fx.teamMove.view()).toMatchObject({ phase: "done", from: "computer", batch: ids.map((id) => ({ id, phase: "done" })) });

  const there = await teamBots("olive");
  for (const { bot } of moved) {
    const arrived = there.find((entry) => entry.id === bot.id)!;
    expect(arrived, bot.name).toMatchObject({ name: bot.name, access: { everyone: "none", people: {} } });
    // Its chat is Olive's own conversation there, private, never the team's main chat, with her lines as hers.
    expect(arrived.tasks?.find((task) => task.threadId === bot.threadId)?.private, bot.name).toBe(true);
    const carried = await rows(onTeam("olive"), bot.threadId);
    expect(carried.map((row) => row.id)).toEqual((await rows(fx.local, bot.threadId)).map((row) => row.id));
    expect(carried.filter((row) => row.role === "user").every((row) => row.sender?.id === oliveKey), JSON.stringify(carried)).toBe(true);
    // Its notes about Olive stayed on this computer.
    const notes = teamHome("workspaces", bot.id, "MEMORY.md");
    expect(existsSync(notes) ? readFileSync(notes, "utf8") : "").not.toContain("oolong");
  }
  expect(readFileSync(teamHome("workspaces", moved[1]!.bot.id, "report.md"), "utf8")).toBe("# Quill report\nPorto, June.\n");
  // Wren runs here on an AI Acme doesn't have: the move still finishes, and Wren arrives on one of Acme's own.
  type Engine = { modelSelection?: { instanceId: string } };
  expect(((await localBots()).find((entry) => entry.id === ids[2]) as Engine).modelSelection?.instanceId).toBe("ollama-here");
  expect((there.find((entry) => entry.id === ids[2]) as Engine).modelSelection?.instanceId).toBe("claude");

  // The routine is on in Acme, gone from this computer, and was never on in both places.
  expect((await teamRoutines("olive")).filter((routine) => routine.id === moved[0]!.routine)).toEqual([expect.objectContaining({ enabled: true, botId: ids[0] })]);
  expect((await localRoutines()).some((routine) => ids.includes(routine.botId))).toBe(false);
  expect(watch.seen.some((sample) => sample.here && sample.there), JSON.stringify(watch.seen.slice(-20))).toBe(false);
  expect(watch.seen.some((sample) => sample.there === true)).toBe(true);

  // This computer keeps each as the line that opens it in Acme: archived, its chats and files still on disk, no turns.
  const kept = await localBots();
  for (const { bot } of moved) expect(kept.find((entry) => entry.id === bot.id), bot.name).toMatchObject({ hidden: true, movedTo: { team: ACME, state: "moved" } });
  expect((await rows(fx.local, moved[0]!.bot.threadId)).length).toBeGreaterThan(0);
  expect(existsSync(desktopHome("workspaces", moved[1]!.bot.id, "report.md"))).toBe(true);
  const refused = await fx.local("POST", `/api/bots/${ids[0]}/messages`, { text: "Still there?", threadId: moved[0]!.bot.threadId });
  expect([refused.status, refused.body.error]).toEqual([409, "Scout lives in Acme now."]);
  await ask("cloud-send:team-open", ACME.id);
  expect(fx.spies.opened.at(-1)).toBe(`team:${ACME.id}`);
}, hostTimeout(420_000));

it("another Member of Acme sees nothing of the moved bots or their chats, and runs nothing of them", async () => {
  const ids = moved.map((entry) => entry.bot.id);
  expect((await teamBots("cleo")).some((bot) => ids.includes(bot.id))).toBe(false);
  for (const { bot } of moved) {
    expect((await onTeam("cleo")("GET", `/api/threads/${bot.threadId}/messages`)).status, bot.name).toBe(404);
    expect((await onTeam("cleo")("POST", `/api/bots/${bot.id}/messages`, { text: "hello" })).status, bot.name).toBe(404);
    // An Admin has the bot's row by the team's rule for a bot not shared yet, never Olive's chats.
    expect((await onTeam("ben")("GET", `/api/threads/${bot.threadId}/messages`)).status, bot.name).toBe(404);
  }
  expect((await teamRoutines("cleo")).some((routine) => ids.includes(routine.botId))).toBe(false);
  expect((await onTeam("cleo")("POST", `/api/routines/${moved[0]!.routine}/run`)).status).toBe(404);
}, hostTimeout(60_000));

it("the whole-computer move stays refused at the Team Cloud: a member's own session reaches no move route", async () => {
  expect((await onTeam("olive")("GET", "/api/cloud-send/manifest")).status).toBe(403);
  expect((await onTeam("olive")("GET", "/api/cloud-send?move=1")).status).toBe(403);
  expect((await onTeam("olive")("POST", "/api/cloud-send/chats", { v: 1, dataDir: "/x", conversations: [] })).status).toBe(403);
}, hostTimeout(60_000));

it("with a My Cloud that takes this computer's bots, a team is offered only once the person keeps them here", async () => {
  const teamOnly = fx.account.state;
  fx.account.state = { ...teamOnly, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  try {
    expect(await ask("cloud-send:teams")).toEqual({ teams: [] });
    expect((await ask<Many>("cloud-send:team-move-many", [moved[0]!.bot.id], ACME.id)).refused?.code).toBe("computerMoving");
    await ask("one-home:keep-set", true);
    expect(await ask("cloud-send:teams")).toEqual({ teams: [{ ...ACME, ready: true }], from: "computer" });
  } finally { fx.account.state = teamOnly; }
}, hostTimeout(60_000));
