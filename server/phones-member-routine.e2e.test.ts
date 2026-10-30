// Off a Cloud home a client-scope device (the front desk's iPad) may write, edit and run routines on the Chief, but no
// such routine reaches the owner's phone: its run mounts no device server, a device call made in that run is refused
// before any job is queued, so the phone never hears of it, and the desk editing the owner's own routine takes the phone
// away from that routine until the owner rewrites it. Where sign-in lets several people in, the desktop offers no phone.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { PHONE_MCP_SERVER } from "../shared/phone-apps.ts";
import { PHONE_INTERNAL_MCP_PATH } from "./phones/rpc.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "isolated-phone-member-routine";
const PHONE_NAME = "Omkar's iPhone";
const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";
const RANGE = { from: "2026-10-23T00:00:00+05:30", to: "2026-10-24T00:00:00+05:30" };
const SCHEDULE = () => ({ type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60 * 60_000 });
let fixture: VerificationServer;
let child: ChildProcess;
let url: string;
let chief: { id: string; threadId: string };
let pairing: { token: string; session: { id: string } };
let desk: { token: string; session: { id: string } };
/** While this file exists every hanging fake turn ends normally (FAKE_CLAUDE_RELEASE). */
let release: string;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const phone = (method: string, path: string, body?: unknown) => api(method, path, body, pairing.token);
const pair = async (label: string, scopes: string[]) => {
  const opened = await api("POST", "/api/auth/pairing", { label, scopes });
  expect(opened.status).toBe(200);
  const paired = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body as typeof pairing;
  expect(paired.token).toMatch(/^omb_sess_/u);
  return paired;
};
const rpc = async (token: string, method: string, params: unknown = {}) => {
  const response = await fetch(url + PHONE_INTERNAL_MCP_PATH, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const mint = async (botId: string, threadId: string) => {
  const response = await fetch(url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind: "device" }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
type Launch = { prompt: unknown; mcpConfig: { mcpServers: Record<string, { env: Record<string, string> }> } | null };
/** Starts whatever begins a turn and returns the MCP servers of the launch whose prompt carries `marker`. */
const launched = async (marker: string, start: () => Promise<void>) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  await start();
  const launch = await vi.waitFor(() => {
    expect(existsSync(fixture.fixtureDumpPath)).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Launch;
    expect(JSON.stringify(dump.prompt)).toContain(marker);
    expect(dump.mcpConfig).not.toBeNull();
    return dump as Launch & { mcpConfig: NonNullable<Launch["mcpConfig"]> };
  }, { timeout: 15_000 });
  return Object.keys(launch.mcpConfig.mcpServers);
};
/** Starts a routine run with `token` (none: this machine): the launch's MCP servers and the run's thread. */
const run = async (routineId: string, prompt: string, token?: string) => {
  let runId = "";
  const servers = await launched(prompt, async () => {
    const started = await api("POST", `/api/routines/${routineId}/run`, undefined, token);
    expect(started.status).toBe(201);
    runId = started.body.run.id;
  });
  const threadId = (await api("GET", "/api/routines")).body.runs.find((one: { id: string }) => one.id === runId).threadId as string;
  return { servers, threadId };
};
const routine = async (name: string, token?: string) => {
  const prompt = `${name}: tell me where the boss is today.`;
  const created = await api("POST", "/api/routines", { name, prompt, botId: chief.id, schedule: SCHEDULE() }, token);
  expect(created.status).toBe(201);
  return { id: created.body.routine.id as string, prompt };
};
/** Ends every hanging turn and waits for the Chief to be idle; the turns after it hang again. */
const settle = async () => {
  writeFileSync(release, "");
  try {
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === chief.id).busy, { timeout: 20_000 }).toBe(false);
  } finally {
    rmSync(release, { force: true });
  }
};
/** No job waits for the phone: a queued job answers a poll at once, so a poll still open after a second found none. */
const noJobReachesThePhone = async () => {
  const polled = fetch(url + "/api/phones/self/jobs", { headers: { authorization: `Bearer ${pairing.token}`, origin: url }, signal: AbortSignal.timeout(1_000) });
  await expect(polled).rejects.toMatchObject({ name: "TimeoutError" });
  expect((await phone("GET", "/api/phones")).body.phones).toMatchObject([{ registration: { name: PHONE_NAME }, busy: false }]);
};

/** This file's own server on the fixture's data, port and fake engine, with the test capability route open. */
const start = async () => {
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release, FAKE_CLAUDE_TEXT_DUMP: join(fixture.info.dataDir, "one-shot-dump.json") }, fixture.info.dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: key },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    try { if ((await fetch(url + "/api/health")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("isolated phone server did not start");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

beforeAll(async () => {
  fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  url = fixture.info.url;
  release = join(fixture.info.dataDir, "release-hanging-turns");
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  await start();
  const found = (await api("GET", "/api/bots")).body.bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
  chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  // The owner's own phone, paired with the owner's scopes, with its calendar allowed; the desk has the client scope only.
  pairing = await pair(PHONE_NAME, ["admin", "client"]);
  const registered = await phone("PUT", "/api/phones/self", { installId: "install-0001", name: PHONE_NAME, platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" } });
  expect(registered.status).toBe(200);
  desk = await pair("Front desk iPad", ["client"]);
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a routine a client session wrote never reaches the owner's phone, whoever runs it", async () => {
  const theirs = await routine("Desk look", desk.token);
  // The desk's own start: no device server, and a device call made in the run is refused before anything is queued.
  const started = await run(theirs.id, theirs.prompt, desk.token);
  expect(started.servers).not.toContain(PHONE_MCP_SERVER);
  const token = await mint(chief.id, started.threadId);
  expect((await rpc(token, "tools/list")).body.result.tools).toEqual([]);
  const refused = (await rpc(token, "tools/call", { name: "PHONE_LIST_EVENTS", arguments: RANGE })).body.result;
  expect(refused).toMatchObject({ isError: true, content: [{ text: NOT_OWNER_TEXT }] });
  await noJobReachesThePhone();
  await settle();
  // The owner starting it by hand does not make the desk's words the owner's.
  expect((await run(theirs.id, theirs.prompt)).servers).not.toContain(PHONE_MCP_SERVER);
  await settle();
}, 90_000);

it("the desk editing the owner's routine takes the phone away from it until the owner rewrites it", async () => {
  const mine = await routine("Owner look");
  expect((await run(mine.id, mine.prompt)).servers).toContain(PHONE_MCP_SERVER);
  await settle();
  // Any field, even only the name.
  expect((await api("PATCH", `/api/routines/${mine.id}`, { name: "Owner look (desk)" }, desk.token)).status).toBe(200);
  const edited = await run(mine.id, mine.prompt);
  expect(edited.servers).not.toContain(PHONE_MCP_SERVER);
  const refused = (await rpc(await mint(chief.id, edited.threadId), "tools/call", { name: "PHONE_LIST_EVENTS", arguments: RANGE })).body.result;
  expect(refused).toMatchObject({ isError: true, content: [{ text: NOT_OWNER_TEXT }] });
  await noJobReachesThePhone();
  await settle();
  // The owner touching another field does not take it back; rewriting its instructions does.
  expect((await api("PATCH", `/api/routines/${mine.id}`, { name: "Owner look" })).status).toBe(200);
  expect((await run(mine.id, mine.prompt)).servers).not.toContain(PHONE_MCP_SERVER);
  await settle();
  expect((await api("PATCH", `/api/routines/${mine.id}`, { prompt: mine.prompt })).status).toBe(200);
  expect((await run(mine.id, mine.prompt)).servers).toContain(PHONE_MCP_SERVER);
  await settle();
}, 120_000);

it("where sign-in lets several people in, the desktop offers no phone, even to the owner's own turn", async () => {
  // A turn of the owner's own at this machine, in a conversation of their own (the Chief's main chat now holds the
  // desk's routine reports), has the phone until then.
  const threadId = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "My morning" })).body.task.threadId as string;
  await settle();
  const ask = (text: string) => launched(text, async () => {
    expect((await api("POST", `/api/bots/${chief.id}/messages`, { threadId, text })).status).toBe(202);
  });
  expect(await ask("What is on my calendar this morning?")).toContain(PHONE_MCP_SERVER);
  await settle();
  await waitForExit(child, { signal: "SIGTERM" });
  const config = join(fixture.info.dataDir, "config.json");
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), signIn: { members: ["teammate@example.com"] } }));
  await start();
  expect(await phone("PUT", "/api/phones/self", { installId: "install-0001", name: PHONE_NAME, platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" } }))
    .toMatchObject({ status: 403 });
  expect(await ask("What is on my calendar this afternoon?")).not.toContain(PHONE_MCP_SERVER);
  await settle();
}, 90_000);
