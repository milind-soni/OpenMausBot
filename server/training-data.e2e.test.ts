// The whole path on a real server: an OpenAI-compatible model as a bot's engine, Training data turned on in Settings,
// a turn, and what Settings → Training data and Settings → Usage → Model performance then read back.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

let model: Server;
let fixture: VerificationServer;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${text}`).toBe(true);
  return path.endsWith(".jsonl") ? text : JSON.parse(text);
};

beforeAll(async () => {
  model = createServer(async (request, response) => {
    if (request.method !== "POST") { response.setHeader("content-type", "application/json"); response.end('{"data":[{"id":"fake-model"}]}'); return; }
    for await (const _part of request) { /* answered the same each time */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello from the fake model." }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  fixture = await launchVerificationServer();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  model?.closeAllConnections();
  await new Promise<void>((resolve) => model?.close(() => resolve()));
});

it("keeps a chat model's turn only while turned on, with its outcome, and shows the model's performance", async () => {
  const { port } = model.address() as AddressInfo;
  const { instanceId } = await api("POST", "/api/instances/openai-compat", { displayName: "Fake", url: `http://127.0.0.1:${port}/v1`, key: "fake-key-0123456789", models: ["fake-model"] });
  const { bot } = await runControlOmb(["new-bot", "--name", "Trainer", "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } };
  const threadId = bot.activeTaskId;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId, model: "fake-model" } });
  const turn = async (text: string) => {
    await runControlOmb(["send", "--bot", bot.id, "--task", threadId, "--text", text, "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "60", "--url", fixture.info.url]);
  };

  expect(await api("GET", "/api/training-data")).toMatchObject({ mode: "off", steps: 0, available: true });
  await turn("Before it was on.");
  expect(await api("GET", "/api/training-data")).toMatchObject({ steps: 0 });

  expect((await api("PATCH", "/api/config", { features: { trainingData: "local" } })).features).toMatchObject({ trainingData: "local" });
  await turn("Say hello, MARKER-7Q.");
  await expect.poll(async () => (await api("GET", "/api/training-data")).turns, { timeout: 10_000 }).toBe(1);
  const rows = (await api("GET", "/api/training-data.jsonl") as string).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.map((row) => row.kind)).toEqual(["step", "outcome"]);
  expect(rows[0]).toMatchObject({ model: "fake-model", driverKind: "openai-compat", local: true, completion: { content: "Hello from the fake model." } });
  expect(rows[0].messages[0]).toMatchObject({ role: "system" });
  expect(JSON.stringify(rows[0].messages)).toContain("MARKER-7Q");
  expect(rows[1]).toMatchObject({ kind: "outcome", ok: true, turnId: rows[0].turnId });
  expect(JSON.stringify(rows)).not.toContain("fake-key-0123456789");

  await api("PATCH", "/api/config", { features: { trainingData: "off" } });
  await turn("After it was turned off.");
  expect(await api("GET", "/api/training-data")).toMatchObject({ mode: "off", steps: 1 });

  const day = new Date().toISOString().slice(0, 10);
  const { models } = await api("GET", `/api/usage/models?from=${day}&to=${day}`);
  expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ model: "fake-model", driverKind: "openai-compat", turns: 3, ok: 3, ended: 3 })]));

  expect(await api("DELETE", "/api/training-data")).toMatchObject({ steps: 0 });
}, 180_000);
