import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
let choice = "high";
let probability = 0.96;
let hold: Promise<void> | undefined;
const requests: Array<Record<string, any>> = [];
const helper = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", async () => {
    const body = JSON.parse(raw);
    const question = body.questions.answer;
    if (question.type === "noul") {
      res.end(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.99 } } }));
      return;
    }
    requests.push(body);
    const selected = choice;
    const p = probability;
    if (hold) await hold;
    const other = Object.keys(question.criteria).find((key) => key !== selected)!;
    res.end(JSON.stringify({ answers: { answer: { type: "choice", choice: selected, probabilities: { [selected]: p, [other]: 1 - p } } } }));
  });
});

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${text}`).toBe(true);
  return text ? JSON.parse(text) : null;
}

let botId: string;
const selection = { instanceId: "claude", model: "claude-sonnet-5" };
const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
const effortArg = () => { const args: string[] = dump().argv; return args[args.indexOf("--effort") + 1]; };
async function send(text: string) {
  const sent = await api("POST", `/api/bots/${botId}/messages`, { text });
  let bot: any;
  await expect.poll(async () => {
    bot = (await api("GET", "/api/bots?messages=200")).bots.find((one: any) => one.id === botId);
    return !bot.busy && bot.messages.some((message: any) => message.role === "bot" && message.kind === "text" && message.at >= sent.message.at);
  }, { timeout: 25_000, interval: 100 }).toBe(true);
  return bot.messages.find((message: any) => message.id === sent.message.id);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => helper.listen(0, "127.0.0.1", resolve));
  fixture = await launchVerificationServer({});
  await api("PUT", "/api/config", { decider: { baseUrl: `http://127.0.0.1:${(helper.address() as AddressInfo).port}` } });
  await api("PUT", "/api/config", { decider: { enabled: false, key: "tsk_fixture_only", jobs: { turnEffort: false } } });
  botId = (await api("POST", "/api/bots", { name: "Effort fixture", modelSelection: selection })).bot.id;
}, 45_000);

afterAll(async () => {
  await fixture?.close();
  helper.closeAllConnections();
  await new Promise<void>((resolve) => helper.close(() => resolve()));
});

it("loads a stored config with an unsupported provider and enables automatic effort once a provider is chosen", async () => {
  const before = await api("GET", "/api/config");
  expect(before.decider).toMatchObject({ enabled: false, turnEffortConfigured: true, jobs: { turnEffort: false } });
  const configFile = join(fixture.info.dataDir, "config.json");
  const stored = JSON.parse(readFileSync(configFile, "utf8"));
  stored.decider.provider = "gemini";
  writeFileSync(configFile, JSON.stringify(stored));
  const unchosen = await api("PUT", "/api/config", { decider: { enabled: true, jobs: { turnEffort: true } } });
  expect(unchosen.decider).toMatchObject({ enabled: false });
  const after = await api("PUT", "/api/config", { decider: { provider: "jev" } });
  expect(after.decider).toMatchObject({ enabled: true, provider: "jev", turnEffortConfigured: true, jobs: { turnEffort: true } });
});

it("uses Auto for default and conversational bots without changing model or saved effort", async () => {
  for (const replyStyle of ["default", "conversational"]) {
    await api("PATCH", `/api/bots/${botId}`, { replyStyle });
    const message = await send(replyStyle === "default" ? "arruma o login" : "исправь вход");
    expect(message.turnEffort).toBe("high");
    expect(effortArg()).toBe("high");
    const args: string[] = dump().argv;
    expect(args[args.indexOf("--model") + 1]).toBe(selection.model);
    const bot = (await api("GET", "/api/bots?messages=0")).bots.find((one: any) => one.id === botId);
    expect(bot.modelSelection).toEqual(selection);
  }
}, 60_000);

it("rejects invalid settings and applies a single bounded effort without a helper call", async () => {
  const invalid = await fetch(`${fixture.info.url}/api/bots/${botId}`, { method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ autoEffort: { min: "high", max: "low" } }) });
  expect(invalid.status).toBe(400);
  await api("PATCH", `/api/bots/${botId}`, { autoEffort: { min: "medium", max: "medium" } });
  const count = requests.length;
  expect((await send("hello")).turnEffort).toBe("medium");
  expect(effortArg()).toBe("medium");
  expect(requests).toHaveLength(count);
  await api("PATCH", `/api/bots/${botId}`, { autoEffort: null });
}, 30_000);

it("omits effort after an uncertain choice even after a previous explicit effort", async () => {
  probability = 0.5;
  expect((await send("arruma o login outra vez")).turnEffort).toBeUndefined();
  expect(dump().argv).not.toContain("--effort");
  probability = 0.96;
}, 30_000);

it("preserves fixed effort with the new job both on and off", async () => {
  await api("PATCH", `/api/bots/${botId}`, { modelSelection: { ...selection, effort: "high" } });
  for (const enabled of [true, false]) {
    await api("PUT", "/api/config", { decider: { jobs: { turnEffort: enabled } } });
    const count = requests.length;
    expect((await send("hi")).turnEffort).toBeUndefined();
    expect(effortArg()).toBe("high");
    expect(requests).toHaveLength(count);
  }
  await api("PATCH", `/api/bots/${botId}`, { modelSelection: selection });
  await api("PUT", "/api/config", { decider: { jobs: { turnEffort: true } } });
}, 60_000);

it("records the effort on the responding room member", async () => {
  const group = (await api("POST", "/api/groups", { name: "Effort room", memberIds: [botId] })).group;
  await api("PATCH", `/api/groups/${group.id}/setup`, { action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId } });
  const sent = await api("POST", `/api/groups/${group.id}/messages`, { text: "arruma o login" });
  let room: any;
  await expect.poll(async () => {
    room = (await api("GET", "/api/bots?messages=200")).groups.find((one: any) => one.id === group.id);
    return !room.working && room.messages.some((message: any) => message.role === "bot" && message.kind === "text");
  }, { timeout: 25_000, interval: 100 }).toBe(true);
  expect(room.messages.find((message: any) => message.turnEffort === "high")?.from.botId).toBe(botId);
  expect(room.messages.find((message: any) => message.id === sent.message.id).turnEffort).toBeUndefined();
  expect(effortArg()).toBe("high");
}, 30_000);

it("stops during classification without starting the engine", async () => {
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const count = requests.length;
  const before = existsSync(fixture.fixtureDumpPath) ? readFileSync(fixture.fixtureDumpPath, "utf8") : "";
  try {
    await api("POST", `/api/bots/${botId}/messages`, { text: "stop this pending choice" });
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBe(count + 1);
    await api("POST", `/api/bots/${botId}/interrupt`, {});
    release();
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((one: any) => one.id === botId).busy, { timeout: 5_000 }).toBe(false);
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).toBe(before);
  } finally { release(); hold = undefined; }
}, 15_000);

it("skips effort for a model without effort support on an effort-capable engine", async () => {
  await api("PATCH", `/api/bots/${botId}`, { modelSelection: { ...selection, model: "claude-haiku-4-5" }, replyStyle: "default" });
  const count = requests.length;
  expect((await send("arruma o login")).turnEffort).toBeUndefined();
  expect(requests).toHaveLength(count);
  expect(dump().argv).not.toContain("--effort");
}, 30_000);
