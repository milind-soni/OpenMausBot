import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

let child: ChildProcess;
let home: string;
let base: string;
let log = "";
const tokens: Record<string, string> = {};
const reading = new Map<string, () => void>();
const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 };

async function api(method: string, path: string, body?: unknown, as = "admin") {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tokens[as]}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

async function hold(method: string, path: string) {
  const id = randomUUID();
  const ready = new Promise<void>((resolve) => reading.set(id, resolve));
  const req = request(base + path, { method, headers: { authorization: `Bearer ${tokens.member}`, "content-type": "application/json", "x-omb-fixture-body": id } });
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
  });
  req.flushHeaders();
  await ready;
  return { send: (body: unknown) => req.end(JSON.stringify(body)), response };
}

async function target(kind: string) {
  const created = await api("POST", "/api/bots", { name: `Fixture ${randomUUID()}` });
  expect(created.status).toBe(201);
  const botId = created.body.bot.id as string;
  if (kind === "bot") return { botId, ref: { botId } };
  const coordinator = await api("POST", "/api/bots", { name: "Visible coordinator" });
  expect(coordinator.status).toBe(201);
  const group = await api("POST", "/api/groups", { name: "Fixture room", memberIds: [botId, coordinator.body.bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(group.status).toBe(201);
  return { botId, ref: { botId: coordinator.body.bot.id as string, groupId: group.body.group.id as string, target: "room-goal" } };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-request-visibility-"));
  const data = join(home, ".openmausbot");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: ["admin@example.test"], members: ["member@example.test"] },
    instances: Object.fromEntries(["claude", "codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])) }));
  const sessions = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: (email) => email === "admin@example.test" ? ["admin", "client"] : ["client"] });
  for (const as of ["admin", "member"]) tokens[as] = sessions.issue({ label: as, email: `${as}@example.test`, scopes: as === "admin" ? ["admin", "client"] : ["client"] }).token;
  sessions.close();
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", new URL("./testing/request-body-ready.ts", import.meta.url).href, fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.on("message", (message) => {
    const id = (message as { reading?: string }).reading;
    if (id) { reading.get(id)?.(); reading.delete(id); }
  });
  child.stdout!.on("data", (chunk) => { log += chunk; });
  child.stderr!.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Fixture failed to start: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("authorization after a held request body", () => {
  it("refuses a channel rename on an initially unrestricted shared workspace after the channel becomes hidden", async () => {
    const { botId, ref } = await target("group");
    const path = `/api/groups/${ref.groupId}`;
    const held = await hold("PATCH", path);
    expect((await api("PATCH", `/api/bots/${botId}`, { visibility: "admins" })).status).toBe(200);
    expect((await api("PATCH", `/api/groups/${ref.groupId}`, { bulletin: "PRIVATE AFTER REVOCATION" })).status).toBe(200);
    const body = { name: "Unauthorized rename" };
    expect((await api("PATCH", path, body, "member")).status).toBe(404);
    held.send(body);
    const response = await held.response;
    const group = (await api("GET", "/api/bots?messages=0")).body.groups.find((g: any) => g.id === ref.groupId);
    expect({ response, name: group.name }).toEqual({ response: { status: 404, body: { error: "no such channel" } }, name: "Fixture room" });
  });

  it.each(["POST", "PATCH"].flatMap((method) => ["bot", "group"].map((kind) => ({ method, kind }))))("refuses $method of a routine with a revoked body-only $kind target", async ({ method, kind }) => {
    const { botId, ref } = await target(kind);
    let path = "/api/routines";
    let before: unknown;
    if (method === "PATCH") {
      const own = await target("bot");
      const created = await api("POST", path, { name: "Existing", prompt: "Original", ...own.ref, schedule, enabled: false });
      expect(created.status).toBe(201);
      path += `/${created.body.routine.id}`;
      before = created.body.routine;
    }
    await api("GET", "/api/bots?messages=0", undefined, "member");
    const held = await hold(method, path);
    expect((await api("PATCH", `/api/bots/${botId}`, { visibility: "admins" })).status).toBe(200);
    const name = `Revoked ${randomUUID()}`;
    const body = { name, prompt: "Do fixture work", ...ref, schedule, enabled: true };
    expect((await api(method, path, body, "member")).status).toBe(404);
    held.send(body);
    const response = await held.response;
    const routines = (await api("GET", "/api/routines")).body.routines as Array<{ id: string; name: string }>;
    expect({ status: response.status, unauthorized: routines.filter((r) => r.name === name) }).toEqual({ status: 404, unauthorized: [] });
    if (before) expect(routines.find((r) => r.id === (before as { id: string }).id)).toEqual(before);
  });

  it.each(["POST", "PATCH"].flatMap((method) => ["bot", "group"].map((kind) => ({ method, kind }))))("accepts a held $method when the body-only $kind target stays visible", async ({ method, kind }) => {
    const { ref } = await target(kind);
    let path = "/api/routines";
    if (method === "PATCH") {
      const created = await api("POST", path, { name: "Visible", prompt: "Original", ...ref, schedule, enabled: false });
      expect(created.status).toBe(201);
      path += `/${created.body.routine.id}`;
    }
    const held = await hold(method, path);
    held.send({ name: "Still visible", prompt: "Do fixture work", ...ref, schedule, enabled: false });
    expect(await held.response).toMatchObject({ status: method === "POST" ? 201 : 200, body: { routine: { ...ref, name: "Still visible" } } });
  });
});
