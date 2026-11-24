// A bot moving back from My Cloud to this computer, server side, end to end: this computer's server and a Cloud home, with
// the test standing in for the app's main process (which a later change drives the move from), doing each step it will:
// hold the bot's line here as returning, hold the bot on My Cloud with a lapsing hold, carry its fields, a routine, a
// webhook and a file into this computer over the app's own capability, then switch: My Cloud keeps its line, this computer
// makes it live. Each place is killed at the move's crash points. Then the bot goes to My Cloud again. Disposable homes; no
// network.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { parseSendSummary, planSend } from "../electron/cloud-send-parts.mjs";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
beforeAll(async () => { fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-back-${randomBytes(8).toString("hex")}`, env: { OMB_ENVIRONMENT_LABEL: "MacBook Air" } }); }, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const MY_CLOUD = { id: "my-cloud", name: "My Cloud" };
const LAPTOP = { id: "computer-inst-macbook", name: "MacBook Air" };
type Side = CloudSendFixture["local"];
type Bot = { id: string; name: string; title?: string; threadId: string; hidden?: boolean; movedTo?: { state: string; team: { id: string }; back?: boolean; archived?: boolean; lapseAt?: number } };
const botOn = async (side: Side, id: string) => ((await side("GET", "/api/bots")).body.bots as Bot[]).find((bot) => bot.id === id);
const live = (bot: Bot | undefined) => Boolean(bot && !bot.movedTo && !bot.hidden);
/** The bot is live in exactly one of the two places, and that place is `where`. */
async function liveOnlyOn(id: string, where: "computer" | "cloud") {
  const [here, there] = [await botOn(fx.local, id), await botOn(fx.onCloud, id)];
  expect([live(here), live(there)], JSON.stringify({ here: here?.movedTo, there: there?.movedTo })).toEqual(where === "computer" ? [true, false] : [false, true]);
}
const routinesOn = async (side: Side) => (await side("GET", "/api/routines")).body.routines as Array<{ id: string; botId: string; enabled: boolean }>;
const hooksOn = async (side: Side) => (await side("GET", "/api/webhooks")).body.webhooks as Array<{ id: string; botId: string; enabled: boolean }>;
const move = (side: Side, id: string, body: Record<string, unknown>) => side("POST", `/api/bot-moves/${id}`, { v: 1, ...body });
/** One item, read from My Cloud and written here, as the move carries it. */
async function carry(key: string) {
  const held = await fx.onCloud("GET", `/api/cloud-send/kind?key=${encodeURIComponent(key)}`);
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  return fx.local("PUT", "/api/cloud-send/kind", { v: 1, key, dataDir: held.body.dataDir, record: held.body.record, ...(held.body.runs ? { runs: held.body.runs } : {}) });
}
/** A bot file sent into this computer's server as main sends it: the app's capability, no page. */
async function sendFile(path: string, text: string, headers: Record<string, string> = { "x-openmausbot-desktop-owner": fx.ownerCapability }) {
  const bytes = Buffer.from(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const query = new URLSearchParams({ path, size: String(bytes.length), sha256, offset: "0", mode: "new" });
  const response = await fetch(`${fx.desktopBase}/api/cloud-send/files?${query}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const moves = () => { const file = join(dirname(fx.journalFile), "bot-moves.json"); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { moves: Array<{ phase: string }> } : { moves: [] }; };

let rover: Bot;

it("this computer's server takes a move's writes only from the app's own main process, and both places say they move bots back", async () => {
  for (const side of [fx.local, fx.onCloud]) expect((await side("GET", "/.well-known/openmausbot/environment")).body.capabilities.moveBack).toBe(1);
  const write = { v: 1, key: "routine:nothing-here", dataDir: "/x", record: {} };
  const page = { "x-openmausbot-desktop-owner": fx.ownerCapability, origin: fx.desktopBase, "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };
  const put = async (headers: Record<string, string>) => {
    const response = await fetch(`${fx.desktopBase}/api/cloud-send/kind`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(write) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  expect(await put(page), "the app's own page is a renderer, not main").toMatchObject({ status: 403, body: { error: "Only My Cloud's owner can move things into it." } });
  expect((await put({})).status, "a program on this computer without the app's capability").toBe(403);
  expect((await put({ "x-openmausbot-desktop-owner": "not-the-capability" })).status).toBe(403);
  expect((await sendFile("workspaces/nobody/a.txt", "x", page)).status, "files too").toBe(403);
  // Main's own call gets past the owner check, to the item itself.
  expect(await fx.local("PUT", "/api/cloud-send/kind", write)).toMatchObject({ status: 400 });
  // My Cloud takes nothing from a program on its own machine: only from its owner's session.
  const onCloudLoopback = await fetch(`${fx.cloudBase}/api/cloud-send/kind`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(write) });
  expect(onCloudLoopback.status).toBe(403);
}, hostTimeout(60_000));

it("a bot that went to My Cloud comes back: its line here is brought up to date, never made again; it is live in one place at every step, also across crashes", async () => {
  rover = (await fx.local("POST", "/api/bots", { name: "Rover", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as Bot;
  expect((await fx.local("PATCH", `/api/bots/${rover.id}`, { soul: "You are Rover." })).status).toBe(200);
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  await fx.call("cloud-send:move-bots", "local", [rover.id]);
  await expect.poll(() => moves().moves.length > 0 && moves().moves.every((entry) => entry.phase === "done"), { timeout: 120_000, interval: 250, message: JSON.stringify(moves()) }).toBe(true);
  await liveOnlyOn(rover.id, "cloud");

  // What it did on My Cloud since: a new title, a routine that is on and a webhook.
  expect((await fx.onCloud("PATCH", `/api/bots/${rover.id}`, { title: "Field reporter" })).status).toBe(200);
  const made = (await fx.onCloud("POST", "/api/routines", { name: "Evening", prompt: "Report.", botId: rover.id, schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
  const evening = (made.routine ?? made).id as string;
  const hooked = (await fx.onCloud("POST", "/api/webhooks", { name: "Orders", prompt: "File it.", botId: rover.id })).body;
  const orders = (hooked.webhook ?? hooked).id as string;

  // Crash before the copy: this computer held its line as returning, then the app was killed. The move stops: the line is
  // what it was, and the bot never stopped working on My Cloud.
  expect(await move(fx.local, rover.id, { state: "returning", team: MY_CLOUD })).toMatchObject({ status: 200, body: { movedTo: { state: "moving", back: true } } });
  await fx.relaunch({ kill: true });
  expect((await fx.local("GET", `/api/bot-moves/${rover.id}`)).body.movedTo).toMatchObject({ back: true });
  expect((await fx.local("DELETE", `/api/bot-moves/${rover.id}`)).status).toBe(200);
  expect(await botOn(fx.local, rover.id)).toMatchObject({ hidden: true, movedTo: { state: "moved", team: MY_CLOUD } });
  await liveOnlyOn(rover.id, "cloud");

  // Returning, the line is compared, not made again, and what My Cloud has wins over what it kept.
  expect((await move(fx.local, rover.id, { state: "returning", team: MY_CLOUD })).status).toBe(200);
  const here = parseSendSummary((await fx.local("GET", "/api/cloud-send?move=1")).body);
  const there = parseSendSummary((await fx.onCloud("GET", "/api/cloud-send?move=1")).body);
  expect(here?.items.find((item) => item.key === `bot:${rover.id}`)).toMatchObject({ returning: true });
  const plan = planSend({ local: there, cloud: here });
  const row = plan.rows.find((entry) => entry.key === `bot:${rover.id}`);
  expect(row?.state, "brought up to date, so never a second bot of the same id").toBe("to-update");
  expect(row?.parts).toEqual(expect.arrayContaining(["title", "archived"]));
  expect((await fx.local("POST", "/api/bots", { id: rover.id, threadId: rover.threadId, name: "Rover" })).status, "made again, it would be refused").toBe(409);

  // My Cloud holds it, with a hold that lapses unless renewed; its routine and webhook go off there.
  const holding = await move(fx.onCloud, rover.id, { state: "moving", team: LAPTOP, lapse: true });
  expect(holding.status, JSON.stringify(holding.body)).toBe(200);
  expect(holding.body.movedTo.held).toEqual(expect.arrayContaining([`routine:${evening}`, `webhook:${orders}`]));
  expect(holding.body.movedTo.lapseAt).toBeGreaterThan(Date.now() + 25 * 60_000);

  // The copy, over the app's own capability: its fields (its archived switch waits for the arrival), routine, webhook and a
  // file its old line kept here, which gives way to the newer one and is kept aside.
  expect((await fx.local("PATCH", `/api/bots/${rover.id}`, { title: "Field reporter" })).status).toBe(200);
  const others = async () => ((await fx.local("GET", "/api/bots")).body.bots as Array<Bot & Record<string, unknown>>).filter((bot) => bot.id !== rover.id)
    .map((bot) => [bot.id, bot.hidden ?? false, bot.chiefOfStaff ?? false, Boolean(bot.defaultBot)]);
  const before = await others();
  expect((await carry(`bot:${rover.id}`)).status).toBe(200);
  expect(await others(), "a bot coming back changes none of this computer's other bots").toEqual(before);
  expect(await botOn(fx.local, rover.id), "still hidden while it comes").toMatchObject({ hidden: true, movedTo: { back: true } });
  expect((await fx.local("PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${rover.id}`, dataDir: "/omb-data", record: { hidden: false } })).status).toBe(200);
  expect(await botOn(fx.local, rover.id), "a shown switch waits for the arrival").toMatchObject({ hidden: true, movedTo: { back: true, archived: false } });
  expect((await carry(`routine:${evening}`)).status).toBe(200);
  expect((await carry(`webhook:${orders}`)).status).toBe(200);
  const notes = `workspaces/${rover.id}/notes.md`;
  mkdirSync(join(fx.desktopDataDir, "workspaces", rover.id), { recursive: true });
  writeFileSync(join(fx.desktopDataDir, notes), "old notes\n");
  expect(await sendFile(notes, "newer notes from My Cloud\n")).toMatchObject({ status: 201, body: { stored: true, setAside: true } });
  expect(readFileSync(join(fx.desktopDataDir, notes), "utf8")).toBe("newer notes from My Cloud\n");
  const returningAt = (await botOn(fx.local, rover.id))!.movedTo as unknown as { at: number };
  expect(readFileSync(join(fx.desktopDataDir, "move-back-kept", `${rover.id}-${returningAt.at}`, notes), "utf8")).toBe("old notes\n");
  expect((await routinesOn(fx.local)).find((routine) => routine.id === evening)?.enabled, "nothing runs here before the switch").toBe(false);

  // Crash after the copy, before the switch: both places are killed. The move stops: My Cloud lets the bot go on, its
  // routine and webhook on again; this computer's line is a line again.
  await fx.relaunch({ kill: true, cloud: {} });
  expect((await fx.onCloud("GET", `/api/bot-moves/${rover.id}`)).body.movedTo).toMatchObject({ state: "moving", lapseAt: holding.body.movedTo.lapseAt });
  expect((await fx.onCloud("DELETE", `/api/bot-moves/${rover.id}`)).status).toBe(200);
  expect((await fx.local("DELETE", `/api/bot-moves/${rover.id}`)).status).toBe(200);
  await liveOnlyOn(rover.id, "cloud");
  expect((await routinesOn(fx.onCloud)).find((routine) => routine.id === evening)?.enabled).toBe(true);
  expect((await hooksOn(fx.onCloud)).find((hook) => hook.id === orders)?.enabled).toBe(true);
  expect(await botOn(fx.local, rover.id)).toMatchObject({ hidden: true, movedTo: { state: "moved" } });

  // Again, to the end: hold both, the switch on My Cloud first, then a crash, then the arrival here.
  expect((await move(fx.local, rover.id, { state: "returning", team: MY_CLOUD })).status).toBe(200);
  const held = (await move(fx.onCloud, rover.id, { state: "moving", team: LAPTOP, lapse: true })).body.movedTo.held as string[];
  expect((await carry(`bot:${rover.id}`)).status).toBe(200);
  const switched = await move(fx.onCloud, rover.id, { state: "moved", team: LAPTOP });
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);
  expect(switched.body.stays, "what stays on My Cloud: counts and names, never a value").toMatchObject({ logins: expect.any(Number), secrets: expect.any(Number), onePassword: expect.any(Boolean), connections: expect.any(Array) });
  await fx.relaunch({ kill: true });
  // Between the two switch steps the bot is live nowhere: paused, never in both.
  expect([live(await botOn(fx.local, rover.id)), live(await botOn(fx.onCloud, rover.id))]).toEqual([false, false]);
  const arrived = await move(fx.local, rover.id, { state: "arrived", team: MY_CLOUD, on: held });
  expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
  expect(arrived.body.arrived).toMatchObject({ place: "computer", from: MY_CLOUD, on: { routines: [{ id: evening, name: "Evening" }], webhooks: [] }, offHere: { webhooks: [{ id: orders, name: "Orders" }] } });
  expect((await move(fx.local, rover.id, { state: "arrived", team: MY_CLOUD, on: held })).body, "asked again, the same").toEqual(arrived.body);
  expect((await fx.local("GET", `/api/bot-moves/${rover.id}`)).body.arrived).toEqual(arrived.body.arrived);
  await liveOnlyOn(rover.id, "computer");
  expect(await botOn(fx.local, rover.id)).toMatchObject({ title: "Field reporter" });
  expect((await routinesOn(fx.local)).find((routine) => routine.id === evening)?.enabled, "routines run here now").toBe(true);
  expect((await hooksOn(fx.local)).find((hook) => hook.id === orders)?.enabled, "a webhook nobody can reach here stays off").toBe(false);
  const cloudCopy = await botOn(fx.onCloud, rover.id);
  expect(cloudCopy).toMatchObject({ hidden: true, movedTo: { state: "moved", team: LAPTOP } });
  expect((await routinesOn(fx.onCloud)).find((routine) => routine.id === evening)?.enabled, "kept on My Cloud, off").toBe(false);
  expect((await fx.onCloud("POST", `/api/bots/${rover.id}/messages`, { text: "Still there?", threadId: rover.threadId })).status).toBe(409);
  expect((await fx.local("POST", `/api/bots/${rover.id}/messages`, { text: "Welcome back.", threadId: rover.threadId })).status).toBe(202);
}, hostTimeout(400_000));

it("goes to My Cloud a second time: its line there comes back to life instead of a stub in both places", async () => {
  await expect.poll(async () => !(await botOn(fx.local, rover.id) as Bot & { busy?: boolean })?.busy, { timeout: 60_000, interval: 100 }).toBe(true);
  expect(await move(fx.onCloud, rover.id, { state: "returning", team: LAPTOP })).toMatchObject({ status: 200, body: { movedTo: { back: true } } });
  expect(parseSendSummary((await fx.onCloud("GET", "/api/cloud-send?move=1")).body)?.items.find((item) => item.key === `bot:${rover.id}`)).toMatchObject({ returning: true });
  // This computer's hold never lapses: My Cloud takes the bot first on this way, so letting go here later would make two.
  const held = await move(fx.local, rover.id, { state: "moving", team: MY_CLOUD, lapse: true });
  expect(held.body.movedTo, "a lapse asked for here is not taken").not.toHaveProperty("lapseAt");
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  const on = held.body.movedTo.held as string[];
  const arrived = await move(fx.onCloud, rover.id, { state: "arrived", team: LAPTOP, on });
  expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
  expect(arrived.body.arrived).toMatchObject({ place: "cloud", offHere: { webhooks: [], appEvents: [], mcpServers: [] } });
  expect((await move(fx.local, rover.id, { state: "moved", team: MY_CLOUD })).status).toBe(200);
  await liveOnlyOn(rover.id, "cloud");
  expect((await routinesOn(fx.onCloud)).find((routine) => routine.botId === rover.id && routine.enabled), "what ran here runs there").toBeTruthy();
}, hostTimeout(120_000));

it("a bot born on My Cloud arrives here held from its first write; a stopped first arrival is the line of where it lives, and a bot of the person's here is never taken", async () => {
  const nova = (await fx.onCloud("POST", "/api/bots", { name: "Nova", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as Bot;
  const mine = (await fx.local("POST", "/api/bots", { name: "Mine", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as Bot;
  expect(await move(fx.local, mine.id, { state: "returning", team: MY_CLOUD }), "a live bot of the same id here").toMatchObject({ status: 409, body: { here: true } });
  expect(live(await botOn(fx.local, mine.id))).toBe(true);
  const creation = { id: nova.id, threadId: nova.threadId, name: "Nova", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, arriving: { team: MY_CLOUD } };
  const page = await fetch(`${fx.desktopBase}/api/bots`, { method: "POST", body: JSON.stringify(creation), headers: { "content-type": "application/json",
    "x-openmausbot-desktop-owner": fx.ownerCapability, origin: fx.desktopBase, "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" } });
  expect(page.status, "only the move's own caller makes an arriving bot").toBe(403);
  expect(await botOn(fx.local, nova.id)).toBeUndefined();
  // Made already held: never live here, not even if the app quits before the move holds it.
  const made = await fx.local("POST", "/api/bots", creation);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(await botOn(fx.local, nova.id)).toMatchObject({ hidden: true, movedTo: { back: true, arrival: true } });
  await liveOnlyOn(nova.id, "cloud");
  await fx.relaunch({ kill: true });
  expect(await move(fx.local, nova.id, { state: "returning", team: MY_CLOUD }), "a later try takes it").toMatchObject({ status: 200, body: { movedTo: { arrival: true } } });
  await liveOnlyOn(nova.id, "cloud");
  expect((await fx.local("DELETE", `/api/bot-moves/${nova.id}`)).status).toBe(200);
  expect(await botOn(fx.local, nova.id), "kept, as the line of where it lives").toMatchObject({ hidden: true, movedTo: { state: "moved", team: MY_CLOUD } });
  await liveOnlyOn(nova.id, "cloud");
  expect(await move(fx.local, nova.id, { state: "returning", team: MY_CLOUD }), "the next try takes that line").toMatchObject({ status: 200, body: { movedTo: { back: true } } });
  expect((await fx.local("DELETE", `/api/bot-moves/${nova.id}`)).status).toBe(200);
}, hostTimeout(120_000));
