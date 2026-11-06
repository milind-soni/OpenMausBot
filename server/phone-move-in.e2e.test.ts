// A phone's pocket home moves into its paired computer under the owner's grant, through the companion's request path:
// the test plays the companion (its headers), the server runs as the desktop app's own server, in a disposable home.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { PHONE_MOVE_REFUSAL } from "./phone-move-in.ts";
import { phoneMoveKeyAAD } from "./phone-secret.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { keyMaterial, seal } from "./testing/phone-secret-seal.ts";

const MAUS = "pocket-maus-000001", MAUS_THREAD = "pocket-maus-main-01";
const SCOUT = "pocket-scout-00001", SCOUT_THREAD = "pocket-scout-main-1";
const ATTACHMENT = "3f2a-map.png";
const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const NOTES = "Pack the charger.\n";
const MEMORY = "Scout likes window seats.\n";
const KEY = `sk-ant-fake-e2e-${randomBytes(8).toString("hex")}`;
const SKILL = "---\nname: trip-planner\ndescription: Plans a trip.\n---\nPlan the trip.\n";
const token = () => randomBytes(32).toString("base64url");

async function fixture(test: (f: Awaited<ReturnType<typeof boot>>) => Promise<void>) {
  const session = await launchVerificationServer();
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await waitForExit(session.child, { signal: "SIGTERM" });
    server = await boot(session.info);
    await test(server);
  } finally {
    if (server) await waitForExit(server.child, { signal: "SIGTERM" });
    await session.close();
  }
}

async function boot({ dataDir, url, logPath }: { dataDir: string; url: string; logPath: string }) {
  const owner = token(), companion = token();
  const material = await keyMaterial();
  const saved = join(dataDir, "saved-keys.jsonl");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types",
    "--import", pathToFileURL(fileURLToPath(new URL("./testing/desktop-parent.mjs", import.meta.url))).href,
    fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      OMB_DESKTOP_PARENT: "1", OMB_TEST_DESKTOP_OWNER_TOKEN: owner, OMB_TEST_DESKTOP_COMPANION_TOKEN: companion,
      OMB_TEST_DESKTOP_PHONE_SECRET_KEY: JSON.stringify(material.message), OMB_TEST_DESKTOP_SAVED_KEYS: saved,
    },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  await expect.poll(async () => {
    try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);

  const call = async (headers: Record<string, string>, method: string, path: string, body?: unknown) => {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(url + path, {
      method, headers: { ...(raw || body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const asOwner = (method: string, path: string, body?: unknown) => call({ origin: url, "x-openmausbot-desktop-owner": owner }, method, path, body);
  const phone = (move: boolean) => (method: string, path: string, body?: unknown) => call({
    "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-1", "x-openmausbot-companion-auth": companion,
    ...(move ? { "x-openmausbot-companion-move": "1" } : {}),
  }, method, path, body);
  const moving = phone(true), paired = phone(false);
  const answers: unknown[] = [];
  const m = async (...args: Parameters<typeof moving>) => { const out = await moving(...args); answers.push(out); return out; };

  const rows = (bot: string, thread: string, extra: object = {}) => [
    { id: `${bot}-user-1`, at: 1_000, parentId: null, role: "user", kind: "text", text: "Hello from my phone." },
    { id: `${bot}-bot-1`, at: 2_000, parentId: `${bot}-user-1`, role: "bot", kind: "text", text: "Hello back.", ...extra },
  ].map((row) => ({ ...row, threadId: thread }));
  const conversation = (bot: string, threadId: string, extra: object = {}) =>
    ({ bot, threadId, task: null, rows: rows(bot, threadId, extra), leaf: `${bot}-bot-1`, sent: false });

  const moveAll = async (arrive = true) => {
    await m("GET", "/api/bots?messages=0");
    const created: number[] = [];
    for (const [id, threadId, name] of [[MAUS, MAUS_THREAD, "MausBot"], [SCOUT, SCOUT_THREAD, "Scout"]]) {
      created.push((await m("POST", "/api/bots", { id, threadId, name, useDefaults: false })).status);
      expect((await m("PATCH", `/api/bots/${id}`, { soul: `You are ${name}.` })).status).toBe(200);
    }
    expect((await m("PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${MAUS}`, dataDir: "/phone", record: { defaultBot: {}, chiefOfStaff: true } })).status).toBe(200);
    const listed = (await m("GET", `/api/bots/${SCOUT}/skills`)).body.skills as Array<{ name: string }>;
    if (!listed.some((skill) => skill.name === "trip-planner")) {
      expect((await m("POST", `/api/bots/${SCOUT}/skill-template`, { name: "trip-planner", description: "Plans a trip.", warnings: [], source: "iPhone", text: SKILL, enabled: true })).status).toBe(201);
    }
    const chats = await m("POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [
      conversation(MAUS, MAUS_THREAD), conversation(SCOUT, SCOUT_THREAD, { text: `See ![map](/phone/attachments/${ATTACHMENT})` }),
    ] });
    expect(chats.status).toBe(200);
    expect((await m("POST", "/api/cloud-send/chats/verify", { v: 1, conversations: [{ threadId: SCOUT_THREAD, ids: [`${SCOUT}-user-1`, `${SCOUT}-bot-1`] }] })).body.conversations[0].missing).toEqual([]);
    const missing = (await m("POST", "/api/cloud-send/chats/attachments", { names: [ATTACHMENT] })).body.missing as string[];
    if (missing.includes(ATTACHMENT)) expect((await m("POST", `/api/cloud-send/chats/attachment/${ATTACHMENT}`, PNG)).status).toBe(201);
    expect((await m("PUT", "/api/cloud-send/kind", { v: 1, key: "routine:pocket-routine-01", dataDir: "/phone", record: {
      id: "pocket-routine-01", name: "Morning flights", prompt: "Check flights.", target: "bot", botId: SCOUT, runOn: "maus",
      schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 5, createdAt: 1_000, enabled: true } })).status).toBe(200);
    expect((await m("POST", "/api/cloud-send/memory", { v: 1, bot: SCOUT, files: [{ path: "MEMORY.md", text: MEMORY }] })).status).toBe(200);
    const sha = createHash("sha256").update(NOTES).digest("hex");
    expect((await m("POST", `/api/cloud-send/files?path=workspaces/${SCOUT}/notes.md&size=${Buffer.byteLength(NOTES)}&sha256=${sha}&offset=0&mode=new`, Buffer.from(NOTES))).status).toBeLessThan(300);
    expect((await m("PATCH", "/api/routines/pocket-routine-01", { enabled: true })).status).toBe(200);
    if (arrive) await arrived();
    return { created, chats: chats.body };
  };
  // After it, the bots are closed to the move: a phone resends only until it has said arrived.
  const arrived = async () => expect(await m("POST", "/api/cloud-send/arrived", { v: 1, computer: "Pocket iPhone", webhooks: [], bots: [MAUS, SCOUT] }))
    .toEqual({ status: 200, body: { v: 1, told: 0 } });

  const fields = { version: 1 as const, keyId: material.keyId, deviceId: "phone-1", target: "anthropicApiKey", requestKey: "move-key-1" };
  const moveKey = async () => m("POST", "/api/phone-move/key", await seal(fields, phoneMoveKeyAAD(fields), material.publicKey, KEY));

  const snapshot = async () => {
    const bots = ((await asOwner("GET", "/api/bots")).body.bots as any[]).map((bot) => ({ id: bot.id, defaultBot: bot.defaultBot ?? null, hidden: bot.hidden === true }));
    const lines = async (thread: string) => ((await asOwner("GET", `/api/threads/${thread}/messages?limit=500`)).body.messages as any[]).map((row) => row.id);
    const routines = ((await asOwner("GET", "/api/routines")).body.routines as any[]).map((r) => ({ id: r.id, enabled: r.enabled }));
    const file = join(dataDir, "workspaces", SCOUT, "notes.md");
    return {
      bots: bots.sort((a, b) => a.id.localeCompare(b.id)),
      threads: { [MAUS_THREAD]: await lines(MAUS_THREAD), [SCOUT_THREAD]: await lines(SCOUT_THREAD) },
      routines,
      skills: ((await asOwner("GET", `/api/bots/${SCOUT}/skills`)).body.skills as any[]).map((s) => s.name).sort(),
      memory: (await asOwner("GET", `/api/bots/${SCOUT}/memory/file?path=MEMORY.md`)).body.text,
      file: existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
    };
  };
  const savedKeys = () => existsSync(saved) ? readFileSync(saved, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { child, dataDir, logPath, asOwner, moving, paired, moveAll, arrived, moveKey, snapshot, savedKeys, answers, sha: createHash("sha256").update(NOTES).digest("hex") };
}

it("moves a pocket home's bots in under the grant, and a resend adds nothing twice", () => fixture(async (f) => {
  const starter = ((await f.asOwner("GET", "/api/bots")).body.bots as any[])[0].id as string;
  const first = await f.moveAll(false);
  expect(first.created).toEqual([201, 201]);
  expect(f.answers.length).toBeGreaterThan(10);
  const moved = await f.snapshot();
  expect(moved.bots.find((bot) => bot.id === MAUS)?.defaultBot).toEqual({});
  expect(moved.bots.find((bot) => bot.id === starter)?.hidden).toBe(true);
  expect(moved.threads).toEqual({ [MAUS_THREAD]: [`${MAUS}-user-1`, `${MAUS}-bot-1`], [SCOUT_THREAD]: [`${SCOUT}-user-1`, `${SCOUT}-bot-1`] });
  expect(moved.routines).toEqual([{ id: "pocket-routine-01", enabled: true }]);
  expect(moved.skills).toContain("trip-planner");
  expect(moved.memory).toContain(MEMORY.trim());
  expect(moved.file).toBe(f.sha);

  const again = await f.moveAll(false);
  expect(again.created).toEqual([409, 409]);
  expect(again.chats.messages).toBe(0);
  expect(await f.snapshot()).toEqual(moved);

  await f.arrived();
  // arrived closed the move records: Scout is now any other bot.
  const closed = await f.moving("PATCH", `/api/bots/${SCOUT}`, { soul: "again" });
  expect(closed.status).toBe(403);
  expect(closed.body.error).toMatch(/a paired device may change how a bot looks, not "soul"/);

  // One ticked key: saved on the computer, and the key string never in an answer or the server's output.
  expect(await f.moveKey()).toEqual({ status: 200, body: { v: 1, saved: true } });
  expect(f.savedKeys()).toEqual([{ target: "anthropicApiKey", value: KEY }]);
  expect(JSON.stringify(f.answers)).not.toContain(KEY);
  expect(readFileSync(f.logPath, "utf8")).not.toContain(KEY);
}), 120_000);

it("a phone without the grant gets today's refusals, and the move never touches the computer's own bots", () => fixture(async (f) => {
  const starter = ((await f.asOwner("GET", "/api/bots")).body.bots as any[])[0].id as string;
  const before = JSON.stringify([(await f.asOwner("GET", "/api/bots")).body, (await f.asOwner("GET", "/api/routines")).body]);
  const invalid = { status: 403, body: { error: "forbidden: invalid companion request" } };
  expect(await f.paired("POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [] })).toEqual(invalid);
  expect(await f.paired("POST", "/api/phone-move/key", {})).toEqual(invalid);
  const look = await f.paired("PATCH", `/api/bots/${starter}`, { approvalMode: "full" });
  expect(look.status).toBe(403);
  expect(look.body.error).toMatch(/a paired device may change how a bot looks/);
  const lapsed = { status: 403, body: { error: "Allow this move on the computer first." } };
  expect(await f.paired("POST", "/api/bots", { id: SCOUT, threadId: SCOUT_THREAD, name: "Scout", useDefaults: false })).toEqual(lapsed);
  expect(await f.paired("POST", "/api/bots", { id: starter, name: "Scout", useDefaults: false })).toEqual(lapsed);

  const soul = await f.moving("PATCH", `/api/bots/${starter}`, { soul: "x" });
  expect(soul.status).toBe(403);
  expect(soul.body.error).toMatch(/a paired device may change how a bot looks, not "soul"/);
  for (const [method, path, body] of [
    ["PUT", "/api/cloud-send/kind", { v: 1, key: "routine:r-x", dataDir: "/phone", record: { id: "r-x", botId: starter, target: "bot" } }],
    ["GET", `/api/bots/${starter}/skills`, undefined],
  ] as const) {
    const out = await f.moving(method, path, body);
    expect(out.status).toBe(403);
    expect(out.body.error).toBe(PHONE_MOVE_REFUSAL);
  }
  expect(JSON.stringify([(await f.asOwner("GET", "/api/bots")).body, (await f.asOwner("GET", "/api/routines")).body])).toBe(before);
  const everyday = await f.paired("POST", "/api/bots", { name: "Notes" });
  expect(everyday.status).toBe(201);
  expect(everyday.body.bot.id).not.toBe(SCOUT);
}), 120_000);

it("a starter with a user line stays main, and the phone's MausBot arrives beside it as an ordinary bot", () => fixture(async (f) => {
  const starter = ((await f.asOwner("GET", "/api/bots")).body.bots as any[])[0];
  expect((await f.asOwner("POST", `/api/bots/${starter.id}/messages`, { text: "hello there", threadId: starter.threadId })).status).toBeLessThan(300);
  await f.moveAll();
  const bots = (await f.asOwner("GET", "/api/bots")).body.bots as any[];
  expect(bots.find((bot) => bot.id === starter.id)?.hidden).not.toBe(true);
  const maus = bots.find((bot) => bot.id === MAUS);
  expect(maus.hidden).not.toBe(true);
  expect(maus.chiefOfStaff).not.toBe(true);
}), 120_000);
