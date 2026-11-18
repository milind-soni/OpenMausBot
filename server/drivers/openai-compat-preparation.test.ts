import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { forgetServedModels } from "./ollama-context.ts";

afterEach(() => forgetServedModels());

async function preparingModel() {
  let received!: () => void;
  const preparing = new Promise<void>((resolve) => { received = resolve; });
  const pending: ServerResponse[] = [];
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let creates = 0;
  const json = (response: ServerResponse, body: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  };
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    switch (request.url) {
      case "/api/version": return json(response, { version: "0.40.16" });
      case "/api/show": return json(response, { model_info: { "qwen3.context_length": 65_536 } });
      case "/api/ps": return json(response, { models: [] });
      case "/api/tags": return json(response, { models: [{ name: "fixture:latest", size: 1024 ** 3 }] });
      case "/api/create":
        creates++;
        pending.push(response);
        received();
        return;
      case "/v1/models": return json(response, { data: [{ id: "fixture:latest" }] });
      case "/v1/chat/completions":
        requests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"index":0,"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      default:
        response.statusCode = 404;
        return json(response, {});
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Preparing local model", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_KEY", model: "fixture:latest", tools: false },
    environment: { FIXTURE_KEY: "synthetic-test-key" },
  });
  await instance.refreshModels?.();
  const recorder = recordEvents(instance.adapter);
  const release = () => { for (const response of pending.splice(0)) json(response, { status: "success" }); };
  return {
    instance, recorder, preparing, requests, release,
    get creates() { return creates; },
    async close() {
      release();
      await instance.dispose();
      recorder.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

it.each(["interrupt", "stopAll", "dispose"] as const)("%s releases a turn while Ollama is still preparing its model", async (action) => {
  const fixture = await preparingModel();
  try {
    await fixture.instance.adapter.sendTurn({ threadId: "stopped", text: "This turn is stopped." });
    await fixture.preparing;
    const stopped = action === "interrupt" ? fixture.instance.adapter.interruptTurn("stopped")
      : action === "stopAll" ? fixture.instance.adapter.stopAll() : fixture.instance.dispose();
    const event = await fixture.recorder.until((event) => event.type === "turn.completed", 2_000);
    expect(event).toMatchObject({ threadId: "stopped", ok: false, stopReason: "interrupted" });
    await stopped;
    expect(fixture.instance.adapter.hasSession("stopped")).toBe(false);
    expect(fixture.requests).toEqual([]);
    expect(fixture.creates).toBe(1);
  } finally { await fixture.close(); }
});

it("stopping one turn leaves another turn's shared model preparation available", async () => {
  const fixture = await preparingModel();
  try {
    await fixture.instance.adapter.sendTurn({ threadId: "stopped", text: "This turn is stopped." });
    await fixture.preparing;
    await fixture.instance.adapter.sendTurn({ threadId: "continuing", text: "This turn should finish." });
    const stopped = fixture.instance.adapter.interruptTurn("stopped");
    await fixture.recorder.until((event) => event.type === "turn.completed" && event.threadId === "stopped", 2_000);
    await stopped;
    expect(fixture.instance.adapter.hasSession("continuing")).toBe(true);
    expect(fixture.requests).toEqual([]);
    fixture.release();
    const event = await fixture.recorder.until((event) => event.type === "turn.completed" && event.threadId === "continuing");
    expect(event).toMatchObject({ ok: true });
    expect(fixture.creates).toBe(1);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].messages.at(-1)).toMatchObject({ content: "This turn should finish." });
  } finally { await fixture.close(); }
});
