import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProviderInstance } from "../contracts.ts";
import { parseJson, type JsonValue } from "../schema.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { decodeFleetLocalSelector, LocalDriver } from "./local.ts";

let server: Server | null = null;
let instance: ProviderInstance | null = null;
let recorder: EventRecorder | null = null;
const requests: Array<{ url: string; body: JsonValue | null }> = [];
const chatRequestSchema = z.object({ model: z.string() }).passthrough();

async function fakeHost(finalFrameWithoutNewline = false): Promise<string> {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const body = raw ? parseJson(raw) : null;
      requests.push({ url: request.url ?? "", body });
      const json = (payload: JsonValue) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url === "/v1/models") return json({ data: [{ id: "qwen3.8:27b-mlx" }] });
      if (request.url === "/api/ps") return json({
        models: [{ name: "qwen3.8:27b-mlx", context_length: 65_536 }],
      });
      if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (finalFrameWithoutNewline) {
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`);
          return;
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404).end();
    });
  });
  const running = server;
  return new Promise((resolve) => running.listen(0, "127.0.0.1", () => {
    // SAFETY: a TCP server listening on an ephemeral IPv4 port returns an AddressInfo object.
    const address = running.address() as { port: number };
    resolve(`http://127.0.0.1:${address.port}/v1`);
  }));
}

afterEach(async () => {
  recorder?.stop();
  recorder = null;
  await instance?.dispose();
  instance = null;
  const running = server;
  await new Promise<void>((resolve) => {
    if (!running) return resolve();
    running.closeIdleConnections();
    running.close(() => resolve());
  });
  server = null;
  requests.length = 0;
});

describe("fleet local selectors", () => {
  it("keeps Mac and Windows namespaces disjoint", () => {
    expect(decodeFleetLocalSelector("ollama-mac/qwen3.8:27b-mlx", "mac")).toBe("qwen3.8:27b-mlx");
    expect(decodeFleetLocalSelector("ollama-windows/qwen3.8:27b-mlx", "mac")).toBeNull();
    expect(decodeFleetLocalSelector("bad model", "mac")).toBeNull();
  });

  it("runs the canonical Mac selector as the host-native model", async () => {
    instance = await LocalDriver.create({
      instanceId: "localMac",
      displayName: "Mac M5 models",
      environment: {},
      enabled: true,
      config: { host: "custom", url: await fakeHost(), fleetHost: "mac" },
    });
    recorder = recordEvents(instance.adapter);
    // The transport checks only readiness; the guarded fleet projection owns
    // every picker row and its chat/non-chat classification.
    expect(instance.models.options).toEqual([]);
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    await instance.adapter.sendTurn({
      threadId: "local-turn",
      text: "hi",
      model: "ollama-mac/qwen3.8:27b-mlx",
    });
    await recorder.until((event) => event.type === "turn.completed");
    const chatRequest = requests.find((request) => request.url === "/v1/chat/completions");
    expect(chatRequestSchema.parse(chatRequest?.body).model).toBe("qwen3.8:27b-mlx");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "hello" }));
  });

  it("processes a final SSE frame without a trailing newline", async () => {
    instance = await LocalDriver.create({
      instanceId: "localMac",
      displayName: "Mac M5 models",
      environment: {},
      enabled: true,
      config: { host: "custom", url: await fakeHost(true), fleetHost: "mac" },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "local-tail-turn",
      text: "hi",
      model: "ollama-mac/qwen3.8:27b-mlx",
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "tail" }));
  });
});
