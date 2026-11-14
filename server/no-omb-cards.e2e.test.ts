// Real server, fake engine: a bot at Full access and one at Approve for me (auto) change a profile, a working folder,
// a teammate's profile, a skill, the team and team memory with no card of OpenMausBot's own. Each change leaves one
// applied notice in the conversation, and its Undo puts the change back.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "no-omb-cards-capability";
let fixture: VerificationServer;
let child: ChildProcess;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const mint = async (botId: string, threadId: string) => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind: "agents", skillAuthoring: true }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
const bot = async (name: string) => (await api("GET", "/api/bots")).body.bots.find((candidate: any) => candidate.name === name);
const cards = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[]).filter((message) => message.card);
/** The change's one card is an applied notice, and nothing in the conversation waits on a person. */
const notice = async (threadId: string, requestId: string) => {
  const all = await cards(threadId);
  expect(all.filter((message) => !message.card.answered && !message.card.dismissed && !message.card.expired)).toEqual([]);
  const card = all.find((message) => message.card.requestId === requestId)?.card;
  expect(card).toMatchObject({ autoApplied: true, answered: "allow", options: [] });
  return card;
};
const undo = (threadId: string, requestId: string) => api("POST", `/api/threads/${threadId}/undo`, { requestId });
/** The audit row says the change applied on its own, and under which level. */
const decided = async (requestId: string, level: "full" | "auto") => {
  const dir = join(fixture.info.dataDir, "decisions");
  const rows = () => existsSync(dir) ? readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf8").trim().split("\n"))
    .filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.requestId === requestId) : [];
  await expect.poll(rows, { timeout: 5_000 }).toEqual([expect.objectContaining({ decision: "auto-approved", source: level === "full" ? "full-access" : "level" })]);
};

beforeAll(async () => {
  fixture = await launchVerificationServer();
  const port = Number(new URL(fixture.info.url).port);
  for (const name of ["Full Chief", "Auto Chief", "Full Mate", "Auto Mate"]) {
    const created = await api("POST", "/api/bots", { name, section: name.startsWith("Full") ? "Full team" : "Auto team" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
  for (const name of ["Full Chief", "Auto Chief"]) expect((await api("PATCH", `/api/bots/${(await bot(name)).id}`, { chiefOfStaff: true })).status).toBe(200);
  for (const name of ["Auto Chief", "Auto Mate"]) expect((await api("PATCH", `/api/bots/${(await bot(name)).id}`, { approvalMode: "auto" })).status).toBe(200);
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({}, fixture.info.dataDir, port), OMB_TEST_INTERNAL_CAPABILITY_KEY: key },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`server did not start; see ${fixture.info.logPath}`);
}, 60_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("creates new bots at Full access by default, and keeps the narrower level a person picked", async () => {
  expect((await bot("Full Chief")).approvalMode).toBe("full");
  expect((await bot("Full Mate")).approvalMode).toBe("full");
  expect((await bot("Auto Chief")).approvalMode).toBe("auto");
});

describe.each([["Full", "full"], ["Auto", "auto"]] as const)("a bot at %s", (prefix, level) => {
  it("changes its own profile and working folder, and a teammate's profile, with Undo on each", async () => {
    const chief = await bot(`${prefix} Chief`);
    const mate = await bot(`${prefix} Mate`);
    expect(chief.approvalMode).toBe(level);
    const token = await mint(chief.id, chief.threadId);
    const folder = join(fixture.info.dataDir, `${prefix}-folder`);
    mkdirSync(folder, { recursive: true });
    const own = await api("POST", "/api/internal/profile-requests", { fromBotId: chief.id, fromThreadId: chief.threadId,
      changes: { title: "Researcher", cwd: folder }, reason: "The person asked." }, token);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.state).toBe("applied");
    expect(await bot(`${prefix} Chief`)).toMatchObject({ title: "Researcher", cwd: folder });
    await notice(chief.threadId, own.body.requestId);
    await decided(own.body.requestId, level);
    const other = await api("POST", "/api/internal/profile-requests", { fromBotId: chief.id, fromThreadId: chief.threadId, forBotId: mate.id,
      changes: { title: "Analyst" }, reason: "The person asked." }, token);
    expect(other.body.state, JSON.stringify(other.body)).toBe("applied");
    expect((await bot(`${prefix} Mate`)).title).toBe("Analyst");
    await notice(chief.threadId, other.body.requestId);

    expect((await undo(chief.threadId, own.body.requestId)).body).toMatchObject({ ok: true, undone: true });
    expect(await bot(`${prefix} Chief`)).toMatchObject({ title: "" });
    expect((await bot(`${prefix} Chief`)).cwd).toBeUndefined();
    expect((await undo(chief.threadId, other.body.requestId)).body).toMatchObject({ ok: true, undone: true });
    expect((await bot(`${prefix} Mate`)).title).toBe("");
    expect((await cards(chief.threadId)).find((message) => message.card.requestId === own.body.requestId).card.undone).toBe(true);
  });

  it("adds a skill with no card, and Undo removes it", async () => {
    const chief = await bot(`${prefix} Chief`);
    const token = await mint(chief.id, chief.threadId);
    const name = `${level}-expense`;
    const staged = await api("POST", "/api/internal/skills/stage", { action: "create", source: "conversation",
      skill_md: `---\nname: ${name}\ndescription: Files an expense in the company portal.\n---\n\n# File expense\n\nOpen the portal and file it.\n` }, token);
    expect(staged.status, JSON.stringify(staged.body)).toBe(201);
    expect(staged.body.state).toBe("applied");
    const skills = async () => ((await api("GET", `/api/bots/${chief.id}/skills`)).body.skills as any[]).map((skill) => skill.name);
    expect(await skills()).toContain(name);
    const card = (await cards(chief.threadId)).find((message) => message.card.skillRequest?.name === name).card;
    await notice(chief.threadId, card.requestId);
    expect((await undo(chief.threadId, card.requestId)).body).toMatchObject({ ok: true, undone: true });
    expect(await skills()).not.toContain(name);
  });

  it("sets up the team with no card, and Undo deletes the unused bot it added", async () => {
    const chief = await bot(`${prefix} Chief`);
    const token = await mint(chief.id, chief.threadId);
    const created = await api("POST", "/api/internal/create-bot", { name: `${prefix} Checker`, role: "Checks the work",
      instructions: "Check every result before it ships." }, token);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ state: "applied", applied: true, name: `${prefix} Checker` });
    // A bot the Chief creates starts at the default level, Full access, whatever the Chief's own level.
    expect((await bot(`${prefix} Checker`)).approvalMode).toBe("full");
    const card = await notice(chief.threadId, created.body.requestId);
    expect(card.teamSetupRequest.undo.created).toEqual([created.body.id]);
    await decided(created.body.requestId, level);
    expect((await undo(chief.threadId, created.body.requestId)).body).toMatchObject({ ok: true, undone: true });
    expect(await bot(`${prefix} Checker`)).toBeUndefined();
    expect((await undo(chief.threadId, created.body.requestId)).body).toMatchObject({ alreadyUndone: true });
  });

  it("saves a team fact with no card, and Undo takes it back out", async () => {
    const chief = await bot(`${prefix} Chief`);
    const token = await mint(chief.id, chief.threadId);
    const saved = await api("POST", "/api/internal/team-memory", { fromBotId: chief.id, fromThreadId: chief.threadId,
      kind: "term", name: `${prefix} OKR`, detail: "The quarter's three goals." }, token);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.state).toBe("applied");
    const section = encodeURIComponent(`${prefix} team`);
    const terms = async () => ((await api("GET", `/api/team-memory?section=${section}`)).body.entries as any[]).filter((entry) => entry.status === "accepted").map((entry) => entry.name);
    expect(await terms()).toContain(`${prefix} OKR`);
    await notice(chief.threadId, saved.body.requestId);
    await decided(saved.body.requestId, level);
    expect((await undo(chief.threadId, saved.body.requestId)).body).toMatchObject({ ok: true, undone: true });
    expect(await terms()).not.toContain(`${prefix} OKR`);
  });
});
