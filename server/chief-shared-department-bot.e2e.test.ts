// Real server, fake engine: a Chief of Staff changes the setup of a bot shared with different people when that bot is in
// a department the Chief is in charge of, and still may not for one outside its departments.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "chief-shared-department-bot-capability";
let fixture: VerificationServer;
let child: ChildProcess;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const bot = async (name: string) => (await api("GET", "/api/bots")).body.bots.find((candidate: any) => candidate.name === name);

beforeAll(async () => {
  fixture = await launchVerificationServer();
  const port = Number(new URL(fixture.info.url).port);
  for (const [name, section] of [["Dept Chief", "Work"], ["Editor", "Editing"], ["Payroll", "Private"]]) {
    const created = await api("POST", "/api/bots", { name, section });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
  const chief = await api("PATCH", `/api/bots/${(await bot("Dept Chief")).id}`, { chiefOfStaff: true, managedSections: ["Editing"], acknowledgePeerScope: true });
  expect(chief.status, JSON.stringify(chief.body)).toBe(200);
  for (const name of ["Editor", "Payroll"]) {
    const shared = await api("PATCH", `/api/bots/${(await bot(name)).id}`, { visibility: "admins" });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  }
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

it("lets the Chief list and change a shared bot in its department, and not one outside it", async () => {
  const chief = await bot("Dept Chief");
  const editor = await bot("Editor");
  const payroll = await bot("Payroll");
  expect(chief).toMatchObject({ chiefOfStaff: true, managedSections: ["Editing"] });
  expect([editor.visibility, payroll.visibility]).toEqual(["admins", "admins"]);
  const minted = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId: chief.id, threadId: chief.threadId, kind: "agents" }),
  });
  expect(minted.status).toBe(201);
  const token = (await minted.json() as any).token as string;

  const catalog = await api("GET", "/api/internal/team-setup-catalog", undefined, token);
  expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
  expect((catalog.body.bots as any[]).map((entry) => entry.name).sort()).toEqual(["Dept Chief", "Editor"]);

  const change = (target: any) => api("POST", "/api/internal/profile-requests", { fromBotId: chief.id, fromThreadId: chief.threadId,
    forBotId: target.id, changes: { title: "Proofreader" }, reason: "The person asked." }, token);
  const allowed = await change(editor);
  expect(allowed.body.state, JSON.stringify(allowed.body)).toBe("applied");
  expect((await bot("Editor")).title).toBe("Proofreader");
  const refused = await change(payroll);
  expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
  expect(refused.body.error).toContain("not in a department this Chief manages");
  expect((await bot("Payroll")).title).toBe("");
}, 60_000);
