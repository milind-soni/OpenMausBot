import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";

afterEach(() => vi.unstubAllEnvs());

it.each(["json", "http-error", "truncated", "interrupt"] as const)("settles a real loopback %s response without hanging or reporting false success", async (mode) => {
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "1000");
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const upstream = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(mode === "http-error" ? 400 : 200, {
      "content-type": mode === "json" ? "application/json" : "text/event-stream",
    });
    res.flushHeaders();
    if (mode === "truncated") res.end('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n');
    received();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const inst = await OpenAICompatDriver.create({
    instanceId: `idle-${mode}`, displayName: "Loopback fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_KEY" },
    environment: { FIXTURE_KEY: "synthetic-not-a-secret" },
  });
  const recorder = recordEvents(inst.adapter);
  try {
    if (mode === "json") {
      await expect(inst.generateText!("fixture")).rejects.toMatchObject({ name: "AbortError" });
    } else {
      await inst.adapter.sendTurn({ threadId: "fixture", text: "fixture" });
      await requestReceived;
      if (mode === "interrupt") await inst.adapter.interruptTurn("fixture");
      const done = await recorder.until((event) => event.type === "turn.completed", 5000);
      expect(done).toMatchObject({ ok: false });
      expect(inst.adapter.hasSession("fixture")).toBe(false);
      expect(recorder.events.some((event) => event.type === "item.completed")).toBe(false);
    }
  } finally {
    recorder.stop();
    await inst.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 10_000);
