import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let BASE: string;
const posixOnly = describe.skipIf(process.platform === "win32");
const BOSS = "boss@example.test";
const ADA = "ada@example.test";
const BOB = "bob@example.test";
const CAPABILITY_KEY = "bot-visibility-fixture-capability";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let child: ChildProcess;
let home: string;
let log = "";
const tokens: Record<string, string> = {};

const headers = (as?: string, json = true) => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
});
const api = async (method: string, path: string, body?: unknown, as?: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(as, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const status = async (method: string, path: string, as?: string, body?: unknown) => (await api(method, path, body, as)).status;

async function start() {
  const port = await freePortBlock([0, 1]);
  BASE = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "hold-search-result.ts")).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitFor<T>(read: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** `lastEventId` resumes from a cursor the way a browser's EventSource does. */
function openStream(as: string, lastEventId?: string) {
  const controller = new AbortController();
  const frames: any[] = [];
  const state: { hello: any; ended: boolean; cursor?: string } = { hello: null, ended: false };
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { ...headers(as, false), ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) state.cursor = line.slice(4);
            if (!line.startsWith("data: ")) continue;
            const frame = JSON.parse(line.slice(6));
            if (frame.kind === "hello") {
              state.hello = frame;
              state.cursor = frame.cursor;
            } else if (frame.kind !== "ping") frames.push(frame);
          }
        }
      }
      state.ended = true;
    } catch {
    }
  })();
  return { frames, state, ready: () => waitFor(() => state.hello, 10_000), close: () => controller.abort() };
}

const ids = { pub: "", pubThread: "", hr: "", hrThread: "", board: "", roomPub: "", roomMixed: "", roomMixedThread: "", hrRoutine: "", hrHook: "", hrImage: "", avatar: "", fresh: "" };

async function makeBot(name: string, section?: string) {
  const created = await api("POST", "/api/bots", { name, ...(section ? { section } : {}) }, BOSS);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, { modelSelection: { instanceId: "grok", model: "fake-model" } }, BOSS);
  expect(patched.status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}

async function upload(): Promise<string> {
  const res = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${tokens[BOSS]}` }, body: new Uint8Array(PNG) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { path: string }).path;
}
const nameOf = (path: string) => path.split(/[\\/]/).pop()!;

const settledReply = (threadId: string, text: string) => waitFor(async () => {
  const { body } = await api("GET", `/api/threads/${threadId}/messages`, undefined, BOSS);
  const messages = (body.messages ?? []) as Array<{ role: string; text?: string }>;
  const asked = messages.findIndex((m) => m.role === "user" && m.text?.includes(text));
  return asked >= 0 && messages.slice(asked + 1).some((m) => m.role === "bot" && m.text) ? messages : null;
});

posixOnly("per-bot visibility on a shared workspace", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-bot-visibility-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      signIn: { admins: [BOSS], members: [ADA, BOB] },
      instances: {
        grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } },
        // repeats its whole prompt back, so a test can read what a bot was told
        grokecho: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "echo-gated" }, config: { cli: FAKE_CLI, fullAuto: false } },
      },
    }));
    const role = (email: string) => (email === BOSS ? ["admin", "client"] as const : ["client"] as const);
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: (email) => [...role(email)] });
    for (const email of [BOSS, ADA, BOB]) tokens[email] = registry.issue({ label: `${email.split("@")[0]}'s laptop`, email, scopes: [...role(email)] }).token;
    registry.close();
    await start();

    const pub = await makeBot("Helpdesk Otter", "Ops");
    const hr = await makeBot("Payroll Zebra", "People");
    const board = await makeBot("Board Heron", "People");
    Object.assign(ids, { pub: pub.id, pubThread: pub.threadId, hr: hr.id, hrThread: hr.threadId, board: board.id });
    const roomPub = await api("POST", "/api/groups", { memberIds: [pub.id], name: "Front desk" }, BOSS);
    const roomMixed = await api("POST", "/api/groups", { memberIds: [pub.id, hr.id], name: "Pay questions",
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } } }, BOSS);
    expect(roomPub.status).toBe(201);
    expect(roomMixed.status).toBe(201);
    ids.roomPub = roomPub.body.group.id;
    ids.roomMixed = roomMixed.body.group.id;
    const later = Date.now() + 86_400_000;
    const routine = await api("POST", "/api/routines", { name: "Payslips", botId: hr.id, prompt: "Prepare payslips.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: later } }, BOSS);
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    ids.hrRoutine = routine.body.routine.id;
    const hook = await api("POST", "/api/webhooks", { name: "Payroll feed", botId: hr.id, prompt: "Read the payroll event.", enabled: false }, BOSS);
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    ids.hrHook = hook.body.webhook.id;

    // An image sent in Payroll's thread, Payroll's avatar, and an image nothing uses yet.
    const inThread = await upload();
    ids.hrImage = nameOf(inThread);
    const sent = await api("POST", `/api/bots/${hr.id}/messages`, { text: `Salary sheet <attached-image path="${inThread}" />`, threadId: hr.threadId }, BOSS);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(await settledReply(hr.threadId, "Salary sheet"), log.slice(-2_000)).not.toBeNull();
    const avatar = await upload();
    ids.avatar = nameOf(avatar);
    expect((await api("PATCH", `/api/bots/${hr.id}`, { avatarUrl: `/api/attachments/${ids.avatar}` }, BOSS)).status).toBe(200);
    ids.fresh = nameOf(await upload());
    // The helpdesk and Payroll talk in their shared room before Payroll is restricted.
    expect((await api("POST", `/api/groups/${ids.roomMixed}/messages`, { text: "SECRET-ROOM-42 layoffs list" }, BOSS)).status).toBe(202);
    expect(await waitFor(async () => {
      const { body } = await api("GET", `/api/threads/${roomMixed.body.group.threadId}/messages`, undefined, BOSS);
      return (body.messages ?? []).some((m: any) => m.role === "bot" && m.from?.botId === pub.id && m.text);
    }), log.slice(-2_000)).toBe(true);
    ids.roomMixedThread = roomMixed.body.group.threadId;

    const restricted = await api("PATCH", `/api/bots/${hr.id}`, { visibility: { people: [" Ada@Example.test "] } }, BOSS);
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(200);
    expect(restricted.body.bot.visibility).toEqual({ people: [ADA] });
    expect((await api("PATCH", `/api/bots/${board.id}`, { visibility: "admins" }, BOSS)).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("lists only what a member may see, and never who else may", async () => {
    const bob = (await api("GET", "/api/bots?messages=5", undefined, BOB)).body;
    const bobBots = bob.bots.map((bot: any) => bot.id);
    expect(bobBots).toContain(ids.pub);
    expect(bobBots).not.toContain(ids.hr);
    expect(bobBots).not.toContain(ids.board);
    expect(bob.groups.map((group: any) => group.id)).toEqual([ids.roomPub]);
    expect(bob.sections).toEqual(["Ops"]);
    expect(Object.keys(bob.computerControl).sort()).toEqual([...bobBots].sort());
    const text = JSON.stringify(bob);
    for (const hidden of [ids.hr, ids.hrThread, ids.board, ids.roomMixed, "Payroll Zebra", "Board Heron"]) expect(text).not.toContain(hidden);

    const ada = (await api("GET", "/api/bots?messages=5", undefined, ADA)).body;
    expect(ada.bots.map((bot: any) => bot.id).sort()).toEqual([...bobBots, ids.hr].sort());
    expect(ada.groups.map((group: any) => group.id).sort()).toEqual([ids.roomPub, ids.roomMixed].sort());
    expect(ada.sections.sort()).toEqual(["Ops", "People"]);
    expect(ada.bots.find((bot: any) => bot.id === ids.hr).visibility).toBeUndefined();

    const boss = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body;
    expect(boss.bots.map((bot: any) => bot.id).sort()).toEqual([...bobBots, ids.hr, ids.board].sort());
    expect(boss.bots.find((bot: any) => bot.id === ids.board).visibility).toBe("admins");
    expect((await api("GET", "/api/bots?messages=0")).body.bots).toHaveLength(bobBots.length + 2);
  });

  it("answers a member's every route to a hidden bot, thread or room as not found", async () => {
    const hrMessage = (await api("GET", `/api/threads/${ids.hrThread}/messages`, undefined, BOSS)).body.messages[0].id;
    const refused: Array<[string, string, unknown?]> = [
      ["GET", `/api/threads/${ids.hrThread}/messages`],
      ["GET", `/api/threads/${ids.hrThread}/messages?around=${hrMessage}`],
      ["GET", `/api/threads/${ids.hrThread}/messages/${hrMessage}/image`],
      ["GET", `/api/threads/${ids.hrThread}/export`],
      ["GET", `/api/threads/${ids.hrThread}/export?format=json`],
      ["POST", `/api/threads/${ids.hrThread}/respond`, { requestId: "x", behavior: "deny" }],
      ["POST", `/api/threads/${ids.hrThread}/messages/${hrMessage}/reactions`, { emoji: "👍" }],
      ["POST", `/api/bots/${ids.hr}/messages`, { text: "hello", threadId: ids.hrThread }],
      ["POST", `/api/bots/${ids.hr}/tasks`, { title: "mine" }],
      ["POST", `/api/bots/${ids.hr}/read`, { threadId: ids.hrThread }],
      ["POST", `/api/bots/${ids.hr}/interrupt`, { threadId: ids.hrThread }],
      ["POST", `/api/bots/${ids.hr}/respond`, { requestId: "x", behavior: "deny", threadId: ids.hrThread }],
      ["PATCH", `/api/bots/${ids.hr}`, { pinned: true }],
      ["GET", `/api/bots/${ids.hr}/slack-management`],
      ["GET", `/api/bots/${ids.board}/slack-management`],
      ["POST", `/api/groups/${ids.roomMixed}/read`],
      ["POST", `/api/groups/${ids.roomMixed}/messages`, { text: "hi" }],
      ["PATCH", `/api/groups/${ids.roomMixed}`, { name: "mine now" }],
      ["PATCH", `/api/routines/${ids.hrRoutine}`, { enabled: true }],
      ["POST", `/api/routines/${ids.hrRoutine}/run`],
      ["DELETE", `/api/routines/${ids.hrRoutine}`],
      ["GET", `/api/attachments/${ids.hrImage}`],
      ["GET", `/api/attachments/${ids.avatar}`],
      ["GET", `/api/search?q=Zebra&threadId=${ids.hrThread}`],
    ];
    for (const [method, path, body] of refused) {
      const res = await api(method, path, body, BOB);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("forbidden");
    }
    expect(await status("POST", "/api/routines", BOB, { name: "Mine", botId: ids.hr, prompt: "x", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 } })).toBe(404);
    expect(await status("POST", "/api/groups", BOB, { memberIds: [ids.pub, ids.hr], name: "Sneaky" })).toBe(400);
    expect((await api("GET", "/api/routines", undefined, BOSS)).body.routines.find((r: any) => r.id === ids.hrRoutine).enabled).toBe(false);
    expect((await api("GET", `/api/bots?messages=0`, undefined, BOSS)).body.groups.find((g: any) => g.id === ids.roomMixed).name).toBe("Pay questions");

    expect(await status("GET", `/api/threads/${ids.hrThread}/messages`, ADA)).toBe(200);
    expect(await status("GET", `/api/threads/${ids.hrThread}/export`, ADA)).toBe(200);
    expect(await status("GET", `/api/attachments/${ids.hrImage}`, ADA)).toBe(200);
    const hrImage = await fetch(`${BASE}/api/attachments/${ids.hrImage}`, { headers: headers(ADA, false) });
    expect(hrImage.status).toBe(200);
    expect(hrImage.headers.get("cache-control")).toBe("private, no-store");
    expect(await status("GET", `/api/attachments/${ids.avatar}`, ADA)).toBe(200);
    expect(await status("GET", `/api/threads/${ids.hrThread}/messages`, ADA)).toBe(200);
    expect(await status("GET", `/api/threads/${ids.hrThread}/messages`, BOSS)).toBe(200);
    expect(await status("GET", `/api/attachments/${ids.fresh}`, BOB)).toBe(200);
    expect(await status("GET", `/api/threads/${ids.pubThread}/messages`, BOB)).toBe(200);
    expect(await status("POST", `/api/groups/${ids.roomPub}/read`, BOB)).toBe(200);
  });

  it("narrows search, routines, webhooks and the team map", async () => {
    const hits = async (as: string) => (await api("GET", "/api/search?q=Zebra", undefined, as)).body.hits as Array<{ threadId: string }>;
    expect((await hits(ADA)).some((hit) => hit.threadId === ids.hrThread)).toBe(true);
    expect(await hits(BOB)).toEqual([]);
    expect((await api("GET", "/api/search?q=Otter", undefined, BOB)).body.hits.length).toBeGreaterThan(0);

    const routines = async (as: string) => (await api("GET", "/api/routines", undefined, as)).body.routines.map((r: any) => r.id);
    expect(await routines(ADA)).toContain(ids.hrRoutine);
    expect(await routines(BOB)).not.toContain(ids.hrRoutine);
    const hooks = async (as: string) => (await api("GET", "/api/webhooks", undefined, as)).body.webhooks.map((w: any) => w.id);
    expect(await hooks(ADA)).toContain(ids.hrHook);
    expect(await hooks(BOB)).not.toContain(ids.hrHook);

    const map = (await api("GET", "/api/team-map", undefined, BOB)).body;
    expect(JSON.stringify(map)).not.toContain(ids.hr);
  });

  it("marks as seen only the failed routine runs a member may see", async () => {
    const failing = async (name: string, people?: string[]) => {
      const bot = await makeBot(name, "Ops");
      expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "missing-instance", model: "fake-model" } }, BOSS)).status).toBe(200);
      if (people) expect((await api("PATCH", `/api/bots/${bot.id}`, { visibility: { people } }, BOSS)).status).toBe(200);
      const routine = await api("POST", "/api/routines", { name: `${name} sweep`, botId: bot.id, prompt: `SECRET-${name}`, enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 } }, BOSS);
      expect(routine.status, JSON.stringify(routine.body)).toBe(201);
      const started = await api("POST", `/api/routines/${routine.body.routine.id}/run`, undefined, BOSS);
      expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
      return routine.body.routine.id as string;
    };
    const hidden = await failing("Ledger Lynx", [ADA]);
    const shown = await failing("Lobby Llama");
    const runOf = async (routineId: string) => (await api("GET", "/api/routines", undefined, BOSS)).body.runs.find((run: any) => run.routineId === routineId);
    expect(await waitFor(async () => (await runOf(hidden))?.status === "failed" && (await runOf(shown))?.status === "failed"), log.slice(-2_000)).toBe(true);

    const swept = await api("POST", "/api/routine-runs/seen-all", undefined, BOB);
    expect(swept.status).toBe(200);
    expect(swept.body.runs.map((run: any) => run.routineId)).toContain(shown);
    expect(JSON.stringify(swept.body)).not.toContain(hidden);
    expect(JSON.stringify(swept.body)).not.toContain("SECRET-Ledger Lynx");
    expect((await runOf(shown)).seenAt).toEqual(expect.any(Number));
    expect((await runOf(hidden)).seenAt).toBeUndefined();

    const adaSwept = await api("POST", "/api/routine-runs/seen-all", undefined, ADA);
    expect(adaSwept.body.runs.map((run: any) => run.routineId)).toContain(hidden);
    expect((await runOf(hidden)).seenAt).toEqual(expect.any(Number));
  });

  it("withdraws real scan results when an audience changes before the response", async () => {
    const hold = join(home, ".openmausbot", "hold-search-result");
    let pending: Promise<{ status: number; body: any }> | undefined;
    try {
      expect((await api("GET", "/api/search?q=Zebra", undefined, ADA)).body.hits).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: ids.hrThread }),
      ]));
      writeFileSync(hold, "fixture only");
      let finished = false;
      pending = api("GET", "/api/search?q=Zebra", undefined, ADA).finally(() => { finished = true; });
      expect(await waitFor(() => existsSync(`${hold}.ready`), 5000)).toBe(true);
      // The worker already found the private row; pause only delivery, so this cannot pass because revocation beat admission.
      expect(JSON.parse(readFileSync(`${hold}.ready`, "utf8"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: ids.hrThread }),
      ]));
      expect((await api("PATCH", `/api/bots/${ids.hr}`, { visibility: "admins" }, BOSS)).status).toBe(200);
      expect(finished).toBe(false);
      rmSync(hold);
      const result = await pending;
      expect(result.status).toBe(200);
      expect(result.body.hits).toEqual([]);
    } finally {
      rmSync(hold, { force: true });
      rmSync(`${hold}.ready`, { force: true });
      await pending;
      await api("PATCH", `/api/bots/${ids.hr}`, { visibility: { people: [ADA] } }, BOSS);
    }
  }, 20_000);

  it("keeps the audience an admin's setting", async () => {
    const member = await api("PATCH", `/api/bots/${ids.pub}`, { visibility: "admins" }, ADA);
    expect(member.status).toBe(403);
    expect(member.body.error).toContain("visibility");
    const invalid = await api("PATCH", `/api/bots/${ids.pub}`, { visibility: { people: ["not an address"] } }, BOSS);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/not an email address/);
    expect((await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.bots.find((b: any) => b.id === ids.pub).visibility).toBeUndefined();
  });

  it("streams a member only what they may see, and hands a fresh snapshot to every member stream when an audience changes", async () => {
    let bob = openStream(BOB);
    let ada = openStream(ADA);
    try {
      expect(await bob.ready()).toBeTruthy();
      expect(await ada.ready()).toBeTruthy();
      expect((await api("POST", `/api/bots/${ids.hr}/messages`, { text: "Quarterly bonus plan", threadId: ids.hrThread }, BOSS)).status).toBe(202);
      expect(await settledReply(ids.hrThread, "Quarterly bonus plan")).not.toBeNull();
      expect(await waitFor(() => ada.frames.some((f) => f.kind === "message" && f.threadId === ids.hrThread && f.message?.text?.includes("Quarterly bonus plan")))).toBe(true);
      expect(await waitFor(() => ada.frames.some((f) => f.kind === "runtime" && f.event?.threadId === ids.hrThread))).toBe(true);
      expect((await api("POST", `/api/bots/${ids.pub}/messages`, { text: "Printer help", threadId: ids.pubThread }, BOSS)).status).toBe(202);
      expect(await waitFor(() => bob.frames.some((f) => f.kind === "message" && f.threadId === ids.pubThread))).toBe(true);
      for (const hidden of [ids.hr, ids.hrThread, ids.board, ids.roomMixed, "Quarterly bonus plan", "Payroll Zebra"]) expect(JSON.stringify(bob.frames)).not.toContain(hidden);

      const admin = openStream(BOSS);
      expect(await admin.ready()).toBeTruthy();
      expect((await api("PATCH", `/api/bots/${ids.hr}`, { visibility: { people: [ADA, BOB] } }, BOSS)).status).toBe(200);
      const arrived = await waitFor(() => bob.frames.find((f) => f.kind === "bot" && f.bot?.id === ids.hr));
      expect(arrived?.bot.name).toBe("Payroll Zebra");
      expect(arrived?.bot.visibility).toBeUndefined();
      expect(await waitFor(() => bob.state.ended && ada.state.ended)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(admin.state.ended).toBe(false);
      admin.close();
      bob = openStream(BOB, bob.state.cursor);
      expect((await bob.ready())?.resumed).toBe(false);
      expect((await api("GET", "/api/bots?messages=5", undefined, BOB)).body.groups.map((g: any) => g.id)).not.toContain(ids.roomMixed);

      const away = bob.state.cursor;
      bob.close();
      ada.close();
      expect((await api("PATCH", `/api/bots/${ids.hr}`, { visibility: "admins" }, BOSS)).status).toBe(200);
      bob = openStream(BOB, away);
      expect((await bob.ready())?.resumed).toBe(false);
      const bobNow = (await api("GET", "/api/bots?messages=5", undefined, BOB)).body;
      expect(bobNow.bots.map((b: any) => b.id)).not.toContain(ids.hr);
      expect(bobNow.groups.map((g: any) => g.id)).not.toContain(ids.roomMixed);
      expect(await status("GET", `/api/threads/${ids.hrThread}/messages`, ADA)).toBe(404);
      expect((await api("PATCH", `/api/bots/${ids.pub}`, { color: "green" }, BOSS)).status).toBe(200);
      expect(await waitFor(() => bob.frames.some((f) => f.kind === "bot" && f.bot?.id === ids.pub))).toBe(true);
      const settled = openStream(BOB, bob.state.cursor);
      expect((await settled.ready())?.resumed).toBe(true);
      settled.close();
      const before = bob.frames.length;
      expect((await api("PATCH", `/api/bots/${ids.hr}`, { color: "purple" }, BOSS)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 500));
      expect(bob.frames.slice(before).some((f) => JSON.stringify(f).includes(ids.hr))).toBe(false);
    } finally {
      bob.close();
      ada.close();
      await api("PATCH", `/api/bots/${ids.hr}`, { visibility: { people: [ADA] } }, BOSS);
    }
  }, 90_000);

  it("never shows a member a bot created, copied or imported already restricted", async () => {
    const bob = openStream(BOB);
    try {
      expect(await bob.ready()).toBeTruthy();
      const created = await api("POST", "/api/bots", { name: "Layoffs Planning", visibility: "admins" }, BOSS);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.bot.visibility).toBe("admins");
      expect((await api("POST", "/api/bots", { name: "Bad", visibility: { people: ["nope"] } }, BOSS)).status).toBe(400);
      const manifest = await api("POST", "/api/teams/export", { name: "Copy" }, BOSS);
      expect(manifest.status, JSON.stringify(manifest.body)).toBe(200);
      const imported = await fetch(`${BASE}/api/teams/import?visibility=${encodeURIComponent(JSON.stringify({ people: [ADA] }))}`, {
        method: "POST", headers: headers(BOSS), body: JSON.stringify(manifest.body),
      });
      const importedBody = await imported.json() as { bots: Array<{ id: string; name: string }> };
      expect(imported.status, JSON.stringify(importedBody)).toBe(201);
      const importedIds = importedBody.bots.map((bot) => bot.id);
      expect(importedIds.length).toBeGreaterThan(0);
      const boss = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.bots;
      for (const id of importedIds) expect(boss.find((bot: any) => bot.id === id).visibility).toEqual({ people: [ADA] });
      expect((await fetch(`${BASE}/api/teams/import?visibility=nobody`, { method: "POST", headers: headers(BOSS), body: JSON.stringify(manifest.body) })).status).toBe(400);
      await new Promise((r) => setTimeout(r, 500));
      const seen = JSON.stringify(bob.frames);
      for (const hidden of [created.body.bot.id, created.body.bot.threadId, "Layoffs Planning", ...importedIds]) expect(seen).not.toContain(hidden);
      const list = (await api("GET", "/api/bots?messages=0", undefined, BOB)).body.bots.map((bot: any) => bot.id);
      for (const id of [created.body.bot.id, ...importedIds]) expect(list).not.toContain(id);
      for (const id of [created.body.bot.id, ...importedIds]) await api("DELETE", `/api/bots/${id}`, undefined, BOSS);
    } finally {
      bob.close();
    }
  }, 90_000);

  it("sends a member every bot without its audience list or hidden teammates, whichever route answers", async () => {
    expect((await api("PATCH", `/api/bots/${ids.hr}`, { peers: [ids.board, ids.pub] }, BOSS)).status).toBe(200);
    const task = await api("POST", `/api/bots/${ids.hr}/tasks`, { title: "Ada's thread" }, ADA);
    expect(task.status).toBe(201);
    const answers = [
      ["read", await api("POST", `/api/bots/${ids.hr}/read`, { threadId: ids.hrThread }, ADA)],
      ["display", await api("PATCH", `/api/bots/${ids.hr}`, { pinned: true }, ADA)],
      ["profile", await api("PATCH", `/api/bots/${ids.hr}/profile`, { title: "Payroll desk" }, ADA)],
      ["task", task],
      ["switch", await api("POST", `/api/bots/${ids.hr}/tasks/${ids.hrThread}`, {}, ADA)],
      ["list", await api("GET", "/api/bots?messages=0", undefined, ADA)],
    ] as const;
    for (const [route, answer] of answers) {
      expect(answer.status, `${route}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
      const bots = [answer.body.bot, ...(answer.body.bots ?? [])].filter((bot: any) => bot?.id === ids.hr);
      expect(bots.length, route).toBeGreaterThan(0);
      for (const bot of bots) {
        expect(bot.visibility, route).toBeUndefined();
        if (bot.peers) expect(bot.peers, route).toEqual([ids.pub]);
      }
      expect(JSON.stringify(answer.body), route).not.toContain(ADA);
    }
    expect((await api("PATCH", `/api/bots/${ids.hr}`, { pinned: false }, BOSS)).body.bot).toMatchObject({ visibility: { people: [ADA] }, peers: [ids.board, ids.pub] });
    expect((await api("PATCH", `/api/bots/${ids.hr}`, { peers: null, acknowledgePeerScope: true }, BOSS)).status).toBe(200);
  });

  it("keeps a room fewer people can see out of a visible bot's recall, and refuses to mix audiences in a room", async () => {
    // An engine that repeats its prompt shows exactly what the helpdesk was told.
    expect((await api("PATCH", `/api/bots/${ids.pub}`, { modelSelection: { instanceId: "grokecho", model: "fake-model" } }, BOSS)).status).toBe(200);
    const sent = await api("POST", `/api/bots/${ids.pub}/messages`, { text: "What have you been up to?", threadId: ids.pubThread }, BOB);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const reply = await settledReply(ids.pubThread, "What have you been up to?");
    expect(reply).not.toBeNull();
    const answer = JSON.stringify(reply!.slice(reply!.findIndex((m) => m.text?.includes("What have you been up to?"))));
    expect(answer).toContain("echo: ");
    expect(answer).not.toContain("Pay questions");
    expect(answer).not.toContain("SECRET-ROOM-42");
    expect((await api("PATCH", `/api/bots/${ids.pub}`, { modelSelection: { instanceId: "grok", model: "fake-model" } }, BOSS)).status).toBe(200);
    const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
      body: JSON.stringify({ botId: ids.pub, threadId: ids.pubThread }),
    });
    const { token } = await minted.json() as { token: string };
    const search = await fetch(`${BASE}/api/internal/session-search?fromBotId=${ids.pub}&q=SECRET-ROOM-42`, { headers: { authorization: `Bearer ${token}` } });
    const found = await search.json() as { hits: Array<{ threadId: string }>; memoryHits: unknown[] };
    expect(search.status, JSON.stringify(found)).toBe(200);
    expect(found.hits.map((hit) => hit.threadId)).not.toContain(ids.roomMixedThread);

    const logLines = () => {
      const dir = join(home, ".openmausbot", "workspaces", ids.pub, "memory", "log");
      let text = "";
      try {
        for (const file of readdirSync(dir)) text += readFileSync(join(dir, file), "utf8");
      } catch {
      }
      return text.split("\n").filter((line) => line.includes('from room "Pay questions"')).length;
    };
    const linesBefore = logLines();
    expect((await api("POST", `/api/groups/${ids.roomMixed}/messages`, { text: "SECRET-AFTER-77 severance list" }, BOSS)).status).toBe(202);
    expect(await waitFor(async () => {
      const { body } = await api("GET", `/api/threads/${ids.roomMixedThread}/messages`, undefined, BOSS);
      const messages = body.messages ?? [];
      const asked = messages.findIndex((m: any) => m.text?.includes("SECRET-AFTER-77"));
      return asked >= 0 && messages.slice(asked + 1).some((m: any) => m.role === "bot" && m.from?.botId === ids.pub && m.text);
    })).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(logLines()).toBe(linesBefore);
    const roomToken = await fetch(`${BASE}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
      body: JSON.stringify({ botId: ids.pub, threadId: ids.roomMixedThread }),
    });
    const note = await fetch(`${BASE}/api/internal/memory/log`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${(await roomToken.json() as { token: string }).token}` },
      body: JSON.stringify({ text: "SECRET-AFTER-77 noted" }),
    });
    expect(note.status).toBe(403);
    expect(((await note.json()) as { error: string }).error).toMatch(/visible to fewer people than you are/);
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { resetAudience: true }, BOSS)).status).toBe(200);
    const hrMinted = await fetch(`${BASE}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
      body: JSON.stringify({ botId: ids.hr, threadId: ids.hrThread }),
    });
    const hrSearch = await fetch(`${BASE}/api/internal/session-search?fromBotId=${ids.hr}&q=SECRET-ROOM-42`, {
      headers: { authorization: `Bearer ${(await hrMinted.json() as { token: string }).token}` },
    });
    expect(((await hrSearch.json()) as { hits: Array<{ threadId: string }> }).hits.map((hit) => hit.threadId)).toContain(ids.roomMixedThread);

    const mixed = await api("POST", "/api/groups", { memberIds: [ids.pub, ids.hr], name: "Another mix" }, BOSS);
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/Bots in one room must be visible to the same people\. .+ and .+ are not/);
    const added = await api("PATCH", `/api/groups/${ids.roomPub}`, { memberIds: [ids.pub, ids.board] }, BOSS);
    expect(added.status).toBe(400);
    expect(added.body.error).toMatch(/Bots in one room must be visible to the same people/);
    const later = Date.now() + 86_400_000;
    const call = await api("POST", "/api/calendar-calls", { name: "Comp committee", botIds: [ids.pub, ids.hr], schedule: { type: "once", at: later }, durationMinutes: 10 }, BOSS);
    expect(call.status).toBe(400);
    expect(call.body.error).toMatch(/Bots in one room must be visible to the same people/);
    const solo = await api("POST", "/api/calendar-calls", { name: "Helpdesk standup", botIds: [ids.pub], schedule: { type: "once", at: later }, durationMinutes: 10 }, BOSS);
    expect(solo.status, JSON.stringify(solo.body)).toBe(201);
    const moved = await api("PATCH", `/api/calendar-calls/${solo.body.call.id}`, { botIds: [ids.pub, ids.hr] }, BOSS);
    expect(moved.status).toBe(400);
    await api("DELETE", `/api/calendar-calls/${solo.body.call.id}`, undefined, BOSS);
  }, 90_000);

  it("gives a bot a restricted Chief creates the Chief's own audience", async () => {
    expect((await api("PATCH", `/api/bots/${ids.board}`, { chiefOfStaff: true, approvalMode: "ask" }, BOSS)).status).toBe(200);
    const bob = openStream(BOB);
    try {
      expect(await bob.ready()).toBeTruthy();
      const boardThread = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.bots.find((b: any) => b.id === ids.board).threadId;
      const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
        method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
        body: JSON.stringify({ botId: ids.board, threadId: boardThread }),
      });
      const { token } = await minted.json() as { token: string };
      const engine = (await api("GET", "/api/instances", undefined, BOSS)).body.instances.find((instance: any) => instance.instanceId === "grok");
      const created = await fetch(`${BASE}/api/internal/create-bot`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Layoff Modeler", role: "Models RIF scenarios", instructions: "SECRET-INSTR model the reduction",
          modelSelection: { instanceId: "grok", model: engine.models.default } }),
      });
      // Applies at Ask too: OpenMausBot adds no card of its own.
      const made = await created.json() as { id: string; state: string };
      expect(created.status, JSON.stringify(made)).toBe(201);
      expect(made.state).toBe("applied");
      const admin = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.bots.find((b: any) => b.id === made.id);
      expect(admin.visibility).toBe("admins");
      await new Promise((r) => setTimeout(r, 500));
      const list = (await api("GET", "/api/bots?messages=0", undefined, BOB)).body;
      expect(list.bots.map((b: any) => b.id)).not.toContain(made.id);
      for (const hidden of [made.id, "Layoff Modeler", "SECRET-INSTR"]) expect(JSON.stringify(bob.frames)).not.toContain(hidden);
      await api("DELETE", `/api/bots/${made.id}`, undefined, BOSS);
    } finally {
      bob.close();
      await api("PATCH", `/api/bots/${ids.board}`, { chiefOfStaff: false, approvalMode: "full" }, BOSS);
    }
  }, 60_000);

  it("keeps each person's reaction their own, sends each as that person's reply, and tells a session which are its", async () => {
    expect((await api("POST", `/api/bots/${ids.pub}/messages`, { text: "Shall we open the desk early?", threadId: ids.pubThread }, BOSS)).status).toBe(202);
    const replied = await settledReply(ids.pubThread, "Shall we open the desk early?");
    expect(replied, log.slice(-2_000)).not.toBeNull();
    const answer = (replied as Array<{ id: string; role: string; kind: string; text?: string }>)
      .findLast((message) => message.role === "bot" && message.kind === "text" && message.text)!;
    const react = (as: string, emoji: string) =>
      api("POST", `/api/threads/${ids.pubThread}/messages/${answer.id}/reactions`, { emoji, on: true }, as);
    const ada = await react(ADA, "👍");
    expect(ada.status, JSON.stringify(ada.body)).toBe(200);
    expect(ada.body.delivery).toBe("started");
    const bob = await react(BOB, "👍");
    expect(bob.status, JSON.stringify(bob.body)).toBe(200);
    const keyOf = async (as: string) => (await api("GET", "/api/auth/session", undefined, as)).body.reactor as string;
    const [adaKey, bobKey] = [await keyOf(ADA), await keyOf(BOB)];
    expect(adaKey).toMatch(/^p_[\w-]{22}$/);
    expect(bobKey).toMatch(/^p_[\w-]{22}$/);
    expect(adaKey).not.toBe(bobKey);
    expect(bob.body.message.reactions).toEqual([
      { emoji: "👍", by: adaKey, name: ADA, at: expect.any(Number) },
      { emoji: "👍", by: bobKey, name: BOB, at: expect.any(Number) },
    ]);
    const changed = await react(ADA, "👎");
    expect(changed.body.message.reactions.map((reaction: any) => [reaction.by, reaction.emoji])).toEqual([[bobKey, "👍"], [adaKey, "👎"]]);
    const lines = await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.bots.find((candidate: any) => candidate.id === ids.pub);
      const reactions = ((await api("GET", `/api/threads/${ids.pubThread}/messages`, undefined, BOSS)).body.messages as any[])
        .filter((message) => message.reaction && message.replyToId === answer.id);
      return !bot.busy && reactions.length === 3 ? reactions : null;
    });
    const thread = (await api("GET", `/api/threads/${ids.pubThread}/messages`, undefined, BOSS)).body.messages;
    expect(lines?.map((line: any) => [line.reaction, line.sender?.name]), JSON.stringify(thread.map((m: any) => [m.role, m.kind, m.text?.slice(0, 60), m.reaction]))).toEqual([["👍", ADA], ["👍", BOB], ["👎", ADA]]);
  }, 90_000);

  it("keeps bots with different audiences from reaching each other", async () => {
    // Payroll (Ada), Benefits (Ada) and Board (admins) share a team. Only the
    // two with the same audience are teammates to each other.
    const benefits = await makeBot("Benefits Lynx", "People");
    expect((await api("PATCH", `/api/bots/${benefits.id}`, { visibility: { people: [ADA] } }, BOSS)).status).toBe(200);
    const roster = async (id: string) => JSON.stringify((await api("GET", `/api/bots/${id}/system-prompt`, undefined, BOSS)).body);
    const hr = await roster(ids.hr);
    expect(hr).toContain("Benefits Lynx");
    expect(hr).not.toContain("Board Heron");
    expect(await roster(ids.board)).not.toContain("Payroll Zebra");
    expect((await api("PATCH", `/api/bots/${ids.board}`, { visibility: "everyone" }, BOSS)).status).toBe(200);
    expect(await roster(ids.hr)).not.toContain("Board Heron");
    expect((await api("PATCH", `/api/bots/${ids.board}`, { visibility: "admins" }, BOSS)).status).toBe(200);
  });

  it("never widens a room because a restricted bot left it; only an admin's reset does", async () => {
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { memberIds: [ids.pub] }, BOSS)).status).toBe(200);
    expect(await status("GET", `/api/threads/${ids.roomMixedThread}/messages`, BOB)).toBe(404);
    expect((await api("GET", "/api/bots?messages=0", undefined, BOB)).body.groups.map((g: any) => g.id)).not.toContain(ids.roomMixed);
    const floor = (await api("GET", "/api/bots?messages=0", undefined, BOSS)).body.groups.find((g: any) => g.id === ids.roomMixed).audienceFloor;
    expect(floor).toEqual({ people: [ADA] });
    expect(await status("GET", `/api/threads/${ids.roomMixedThread}/messages`, ADA)).toBe(200);
    expect(JSON.stringify((await api("GET", "/api/bots?messages=0", undefined, ADA)).body.groups)).not.toContain("audienceFloor");
    const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
      body: JSON.stringify({ botId: ids.pub, threadId: ids.pubThread }),
    });
    const search = await fetch(`${BASE}/api/internal/session-search?fromBotId=${ids.pub}&q=SECRET-ROOM-42`, {
      headers: { authorization: `Bearer ${(await minted.json() as { token: string }).token}` },
    });
    expect(((await search.json()) as { hits: Array<{ threadId: string }> }).hits.map((hit) => hit.threadId)).not.toContain(ids.roomMixedThread);
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { resetAudience: true }, ADA)).status).toBe(403);
    expect((await api("PATCH", `/api/groups/${ids.roomMixed}`, { resetAudience: true }, BOSS)).status).toBe(200);
    expect(await status("GET", `/api/threads/${ids.roomMixedThread}/messages`, BOB)).toBe(200);
    // Audit writes run after the response: the earlier admins → Ada reset may
    // be the newest row until this reset reaches disk. Wait for this receipt.
    const reset = await waitFor(async () => (await api("GET", "/api/admin-activity?what=visibility", undefined, BOSS)).body.entries.find((entry: any) =>
      entry.action === "room.audience-reset" && entry.target?.id === ids.roomMixed && entry.after?.audienceFloor === "everyone"), 3_000);
    expect(reset).toMatchObject({ who: BOSS, target: { id: ids.roomMixed }, before: { audienceFloor: { people: [ADA] } }, after: { audienceFloor: "everyone" } });
  });
});
