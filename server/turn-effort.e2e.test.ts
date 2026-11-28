import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
let choice = "high";
let probability = 0.96;
let failureStatus = 200;
const requests: Array<Record<string, unknown>> = [];
const helper = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw) as { questions: { answer: { type?: string; options?: Record<string, string> } } };
    const options = body.questions.answer.options ?? {};
    if (body.questions.answer.type !== "choice") {
      res.end(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.99 } } }));
      return;
    }
    requests.push(body);
    if (failureStatus !== 200) { res.writeHead(failureStatus); res.end(); return; }
    const chosen = choice;
    const others = Object.keys(options).filter((level) => level !== chosen);
    const probabilities = Object.fromEntries([[chosen, probability], ...others.map((level) => [level, (1 - probability) / Math.max(1, others.length)])]);
    res.end(JSON.stringify({ answers: { answer: { type: "choice", choice: chosen, probabilities } } }));
  });
});

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { origin: fixture.info.url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${text}`).toBe(true);
  return text ? JSON.parse(text) : null;
};
const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[] };
const effortArg = () => { const { argv } = dump(); const at = argv.indexOf("--effort"); return at >= 0 ? argv[at + 1] : undefined; };

let botId: string;
let model: string;
async function send(text: string) {
  const sent = await api("POST", `/api/bots/${botId}/messages`, { text });
  await expect.poll(async () => {
    const bot = (await api("GET", "/api/bots?messages=200")).bots.find((one: { id: string }) => one.id === botId);
    return !bot.busy && bot.messages.some((message: { role: string; kind: string; at: number }) => message.role === "bot" && message.kind === "text" && message.at >= sent.message.at);
  }, { timeout: 25_000, interval: 100 }).toBe(true);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => helper.listen(0, "127.0.0.1", resolve));
  fixture = await launchVerificationServer();
  await api("PUT", "/api/config", { decider: { baseUrl: `http://127.0.0.1:${(helper.address() as AddressInfo).port}` } });
  await api("PUT", "/api/config", { decider: { enabled: true, key: "tsk_fixture_only" } });
  const catalog = await runControlOmb(["models", "--url", fixture.info.url]) as { instances: Array<{ instanceId: string; models: { options: Array<{ id: string; effortLevels?: string[] }> } }> };
  const options = catalog.instances.find((item) => item.instanceId === "claude")!.models.options;
  model = (options.find((item) => /sonnet|opus/i.test(item.id)) ?? options[0]!).id;
  botId = (await api("POST", "/api/bots", { name: "Effort fixture", modelSelection: { instanceId: "claude", model } })).bot.id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  helper.closeAllConnections();
  await new Promise<void>((resolve) => helper.close(() => resolve()));
});

it("asks the person's own decision model for effort and passes its choice to the engine", async () => {
  await send("arruma o login");
  expect(requests.at(-1)).toMatchObject({ state: expect.objectContaining({ message: "arruma o login" }) });
  expect(effortArg()).toBe("high");
  const bot = (await api("GET", "/api/bots?messages=0")).bots.find((one: { id: string }) => one.id === botId);
  expect(bot.modelSelection).toEqual({ instanceId: "claude", model });
}, 30_000);

it("keeps today's behaviour when the choice is uncertain or the helper fails", async () => {
  try {
    probability = 0.5;
    await send("plan the migration");
    expect(effortArg()).toBeUndefined();
    failureStatus = 503;
    await send("plan the migration again");
    expect(effortArg()).toBeUndefined();
  } finally {
    probability = 0.96;
    failureStatus = 200;
  }
}, 60_000);

it("leaves a fixed effort alone without asking the helper", async () => {
  await api("PATCH", `/api/bots/${botId}`, { modelSelection: { instanceId: "claude", model, effort: "low" } });
  const count = requests.length;
  await send("arruma o login de novo");
  expect(effortArg()).toBe("low");
  expect(requests).toHaveLength(count);
}, 30_000);
