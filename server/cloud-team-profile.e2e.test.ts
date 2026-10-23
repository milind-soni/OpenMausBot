// A real Team Cloud (OMB_CLOUD_ROLE=team) with two people: who "you" is. Each person's profile (name, picture, About you)
// is their own, keyed by their verified claim; the server's one profile from config.json is nobody's there: it moves to
// the person whose address it names. Bots name the person a conversation is for, and each group chat line its speaker.
// The engine is the synthetic Claude CLI, so this proves the plumbing, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedTeamProfile } from "../electron/team-profile-seed.mjs";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "admin" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const DEE = { email: "dee@acme.test", role: "member" as const };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ADA_PHOTO = "/api/attachments/ada-photo.png";
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.HOME + "/dump.json";`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", bob = "";
let bot: { id: string; mainThreadId: string };

type Profile = { name: string; email: string; aboutMe?: string; avatarUrl?: string };
const configFile = () => join(team.home, ".openmausbot", "config.json");
const serverProfile = () => (JSON.parse(readFileSync(configFile(), "utf8")) as { profile?: Record<string, string> }).profile ?? {};
const you = async (token: string) => {
  const config = await team.as(token, "GET", "/api/config");
  expect(config.status, JSON.stringify(config.body)).toBe(200);
  return config.body.profile as Profile;
};
const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; prompt: unknown };
const messages = async (token: string, threadId: string) =>
  (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ role: string; kind: string; text?: string; sender?: { name: string; id?: string } }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function turn(token: string, threadId: string, text: string, room?: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = (await messages(token, threadId)).length;
  const sent = room
    ? await team.as(token, "POST", `/api/groups/${room}/messages`, { text, threadId })
    : await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  return dump();
}

/** The config frames a person's own event stream carries until one passes `until`, after `trigger` runs. */
async function configFrames(token: string, trigger: () => Promise<unknown>, until: (frame: { profile: Profile }) => boolean): Promise<Array<{ profile: Profile }>> {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ profile: Profile }> = [];
  let buffered = "";
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the stream ended before the config frame");
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const frame = JSON.parse(line.slice("data: ".length)) as { kind: string; profile: Profile };
        if (frame.kind !== "config") continue;
        frames.push(frame);
        if (until(frame)) return frames;
      }
    }
  })();
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await trigger();
    return await Promise.race([read, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no such config frame in ${JSON.stringify(frames)}`)), 15_000))]);
  } finally {
    controller.abort();
    await read.catch(() => {});
  }
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-profile-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  // A Team Cloud from before: its owner set Settings → Profile inside the team, into the server's one profile.
  const config = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
  writeFileSync(configFile(), JSON.stringify({ ...config, profile: { name: "Ada Lovelace", email: "Ada@Acme.test", avatarUrl: ADA_PHOTO, aboutMe: "I run Acme and like tea." } }));
  await team.relaunch();
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));

it("shows a second member himself, never the owner's server-wide profile, in his config and on his own stream", async () => {
  bob = (await team.pair(BOB)).token!;
  const bobs = await you(bob);
  expect(bobs).toEqual({ name: "", email: BOB.email, aboutMe: "" });
  expect(JSON.stringify(await team.as(bob, "GET", "/api/config"))).not.toContain("Ada Lovelace");
  expect((await team.as(bob, "GET", "/api/me")).body).toMatchObject({ name: "", email: BOB.email, aboutMe: "" });
  // Nobody with that address has signed in yet: the server's profile waits for its person, shown to no one.
  expect(serverProfile()).toMatchObject({ name: "Ada Lovelace" });
  const frames = await configFrames(bob, () => team.as(bob, "PUT", "/api/me", { aboutMe: "Bob does the books." }), (frame) => frame.profile.aboutMe === "Bob does the books.");
  for (const frame of frames) expect(frame.profile).toMatchObject({ name: "", email: BOB.email });
}, hostTimeout(60_000));

it("moves the server's profile to the member whose address it names when she signs in, and clears it", async () => {
  ada = (await team.pair(ADA)).token!;
  expect(await you(ada)).toEqual({ name: "Ada Lovelace", email: ADA.email, aboutMe: "I run Acme and like tea.", avatarUrl: ADA_PHOTO });
  expect(serverProfile()).toEqual({ name: "", email: "", aboutMe: "", avatarUrl: "" });
  expect(await you(bob)).toEqual({ name: "", email: BOB.email, aboutMe: "Bob does the books." });
  // A restart keeps hers and brings nothing back.
  await team.relaunch();
  expect(await you(ada)).toMatchObject({ name: "Ada Lovelace", avatarUrl: ADA_PHOTO });
  expect((await you(bob)).name).toBe("");
}, hostTimeout(90_000));

it("lets Bob's Settings → Profile change only Bob's, whichever route his app saves through", async () => {
  // An app from before saves the profile with PUT /api/config, as an admin may: it lands on his own.
  const saved = await team.as(bob, "PUT", "/api/config", { profile: { name: "Bob Builder", email: "ada@acme.test", avatarUrl: "/api/attachments/bob-photo.png" } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.profile).toEqual({ name: "Bob Builder", email: BOB.email, aboutMe: "Bob does the books.", avatarUrl: "/api/attachments/bob-photo.png" });
  expect(await you(ada)).toEqual({ name: "Ada Lovelace", email: ADA.email, aboutMe: "I run Acme and like tea.", avatarUrl: ADA_PHOTO });
  expect(serverProfile()).toEqual({ name: "", email: "", aboutMe: "", avatarUrl: "" });
  // The app's own route, with the About you beside it; what Ada's stream then gets is still hers.
  const adaFrames = await configFrames(ada, async () => {
    expect((await team.as(bob, "PUT", "/api/me", { name: "Bob Builder", aboutMe: "Bob does payroll." })).status).toBe(200);
  }, () => true);
  for (const frame of adaFrames) expect(frame.profile).toEqual({ name: "Ada Lovelace", email: ADA.email, aboutMe: "I run Acme and like tea.", avatarUrl: ADA_PHOTO });
  expect((await team.as(bob, "PUT", "/api/me", { avatarUrl: "https://tracker.example/pixel.png" })).status).toBe(400);
  // Another setting in the same save still saves, and the profile still goes to him alone.
  const both = await team.as(bob, "PUT", "/api/config", { profile: { aboutMe: "Bob does the books and payroll." }, language: "en" });
  expect(both.status, JSON.stringify(both.body)).toBe(200);
  expect((await you(bob)).aboutMe).toBe("Bob does the books and payroll.");
  expect((await you(ada)).aboutMe).toBe("I run Acme and like tea.");
}, hostTimeout(60_000));

it("names Bob, not the owner, in his private chat's system prompt, with his About you only", async () => {
  // A server profile naming someone who has not signed in yet waits, read by nobody's turn.
  const config = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
  writeFileSync(configFile(), JSON.stringify({ ...config, profile: { name: "Olive Owner", email: "olive@acme.test", aboutMe: "Olive likes sailing." } }));
  await team.relaunch();
  expect(JSON.stringify(await you(bob))).not.toContain("Olive");
  const created = await team.as(ada, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  const thread = (await team.as(bob, "POST", `/api/bots/${bot.id}/tasks`, { title: "Bob and Scout" })).body.task.threadId as string;
  const bobs = await turn(bob, thread, "Who am I talking to?");
  expect(bobs.systemPrompt).toContain(JSON.stringify("Bob Builder"));
  expect(bobs.systemPrompt).toContain("payroll");
  expect(bobs.systemPrompt).not.toContain("Ada Lovelace");
  expect(bobs.systemPrompt).not.toContain("like tea");
  expect(bobs.systemPrompt).not.toContain("Olive");
  const adaThread = (await team.as(ada, "POST", `/api/bots/${bot.id}/tasks`, { title: "Ada and Scout" })).body.task.threadId as string;
  const adas = await turn(ada, adaThread, "And now?");
  expect(adas.systemPrompt).toContain(JSON.stringify("Ada Lovelace"));
  expect(adas.systemPrompt).toContain("like tea");
  expect(adas.systemPrompt).not.toContain("Bob Builder");
  expect(adas.systemPrompt).not.toContain("Olive");
  expect(serverProfile()).toMatchObject({ name: "Olive Owner" });
}, hostTimeout(120_000));

it("puts each speaker's own name on a group chat's lines, for the people and for the bot", async () => {
  const created = await team.as(ada, "POST", "/api/groups", { name: "Launch", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const room = created.body.group.id as string, roomThread = created.body.group.threadId as string;
  await turn(ada, roomThread, "@Scout the launch is on Tuesday.", room);
  const seen = await turn(bob, roomThread, "@Scout I can do Wednesday.", room);
  const lines = (await messages(ada, roomThread)).filter((line) => line.role === "user");
  expect(lines.map((line) => line.sender?.name)).toEqual(["Ada Lovelace", "Bob Builder"]);
  const prompt = JSON.stringify(seen.prompt);
  expect(prompt).toContain("Ada Lovelace: @Scout the launch is on Tuesday.");
  expect(prompt).toContain("Bob Builder: @Scout I can do Wednesday.");
  expect(seen.systemPrompt).toContain("Ada Lovelace, Bob Builder");
  expect(seen.systemPrompt).not.toContain("like tea");
  expect(seen.systemPrompt).not.toContain("payroll");
}, hostTimeout(120_000));

it("leaves My Cloud's one profile as it was: the owner's, saved and shown as before", async () => {
  const saved = await fx.onCloud("PUT", "/api/config", { profile: { name: "Milo", email: "milo@example.test" } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await fx.onCloud("GET", "/api/config")).body.profile).toMatchObject({ name: "Milo", email: "milo@example.test" });
  expect((await fx.onCloud("GET", "/api/me")).status).toBe(404);
}, hostTimeout(30_000));

/** The desktop app's seed, as main runs it when a team opens: this person's own team session, and a computer whose
 * Settings → Profile is `local`. `sent` is every request that reached the team. */
function seedFrom(token: string, local: { name?: string; avatarUrl?: string; email?: string }) {
  const sent: Array<{ method: string; path: string; body?: string }> = [];
  const run = () => seedTeamProfile({
    origin: team.base,
    teamFetch: (async (url: string, init: RequestInit = {}) => {
      sent.push({ method: init.method ?? "GET", path: new URL(url).pathname, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      return fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...fx.edge, authorization: `Bearer ${token}` } });
    }) as typeof fetch,
    localRequest: async (route) => route === "/api/config" ? Response.json({ profile: { aboutMe: "Private notes from this computer.", ...local } })
      : route === local.avatarUrl ? new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.byteLength) } })
        : new Response("not found", { status: 404 }),
    tries: 1,
  });
  return { sent, run };
}

it("fills a member's empty team profile once from their own computer's name and picture, and never what they set", async () => {
  const cleo = (await team.pair(CLEO)).token!;
  const others = { ada: await you(ada), bob: await you(bob) };
  const cleos = seedFrom(cleo, { name: "Cleo Desk", avatarUrl: "/api/attachments/cleo-desk.png", email: "cleo@home.example" });
  expect(await cleos.run()).toBe("seeded");
  const seeded = await you(cleo);
  expect(seeded).toMatchObject({ name: "Cleo Desk", email: CLEO.email });
  expect(seeded.avatarUrl).toMatch(/^\/api\/attachments\/[A-Za-z0-9-]+\.png$/);
  expect(seeded.avatarUrl).not.toBe("/api/attachments/cleo-desk.png");
  // Her picture is her own upload on the team, which she can load.
  expect((await fetch(`${team.base}${seeded.avatarUrl}`, { headers: { ...fx.edge, authorization: `Bearer ${cleo}` } })).status).toBe(200);
  // Only the name and the picture went up: never the computer's address or About me.
  expect(JSON.stringify(cleos.sent)).not.toContain("cleo@home.example");
  expect(JSON.stringify(cleos.sent)).not.toContain("Private notes");
  // Nobody else's profile moved.
  expect(await you(ada)).toEqual(others.ada);
  expect(await you(bob)).toEqual(others.bob);

  // Once: a later desktop change is not carried over, and a picture she removes on the team stays removed.
  expect((await team.as(cleo, "PUT", "/api/me", { avatarUrl: "" })).status).toBe(200);
  const again = seedFrom(cleo, { name: "Cleo Renamed", avatarUrl: "/api/attachments/cleo-new.png" });
  expect(await again.run()).toBe("nothing");
  expect(again.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /api/me"]);
  expect(await you(cleo)).toMatchObject({ name: "Cleo Desk" });
  expect((await you(cleo)).avatarUrl).toBeUndefined();
  // The server keeps that too, whatever an app sends.
  const refilled = await team.as(cleo, "PUT", "/api/me", { avatarUrl: seeded.avatarUrl, fillEmpty: true });
  expect(refilled.body).toMatchObject({ filled: [] });
  expect((await you(cleo)).avatarUrl).toBeUndefined();
  expect((await team.as(cleo, "GET", "/api/me")).body.seeded).toEqual(["name", "avatarUrl"]);

  // What a person set on the team is never overwritten, and nothing is uploaded for it.
  const bobs = seedFrom(bob, { name: "Desk Bob", avatarUrl: "/api/attachments/bob-desk.png" });
  expect(await bobs.run()).toBe("nothing");
  expect(bobs.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /api/me"]);
  expect(await you(bob)).toEqual(others.bob);
  // The server holds the line too: a fill never replaces what is there.
  const forced = await team.as(bob, "PUT", "/api/me", { name: "Desk Bob", fillEmpty: true });
  expect(forced.status).toBe(200);
  expect(forced.body).toMatchObject({ name: others.bob.name, filled: [] });
}, hostTimeout(60_000));

it("sends no picture for a person whose computer has none, and only fills their name", async () => {
  const dee = (await team.pair(DEE)).token!;
  const dees = seedFrom(dee, { name: "Dee" });
  expect(await dees.run()).toBe("seeded");
  expect(dees.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /api/me", "PUT /api/me"]);
  expect(JSON.parse(dees.sent[1]!.body!)).toEqual({ name: "Dee", fillEmpty: true });
  expect(await you(dee)).toEqual({ name: "Dee", email: DEE.email, aboutMe: "" });
  // Nothing at all to send: the team is never written to.
  const blank = seedFrom(dee, {});
  expect(await blank.run()).toBe("nothing");
  expect(blank.sent.map((request) => request.method)).toEqual(["GET"]);
}, hostTimeout(60_000));
