import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAICompatDriver, onThisNetwork } from "./openai-compat.ts";
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

async function localServer(handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const upstream = createServer(handle);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const inst = await OpenAICompatDriver.create({
    instanceId: "local-wait", displayName: "Loopback fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_KEY", model: "fixture" },
    environment: { FIXTURE_KEY: "synthetic-not-a-secret" },
  });
  const recorder = recordEvents(inst.adapter);
  return {
    inst, recorder,
    async close() {
      recorder.stop();
      await inst.dispose();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

it("stops waiting soon after a local server stops answering, long before the reply wait", async () => {
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "60000");
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_PROBE_MS", "200");
  let frozen = false;
  const fixture = await localServer((req, res) => {
    if (req.url === "/v1/models" && !frozen) { res.end(JSON.stringify({ data: [] })); return; }
    frozen = true;
  });
  try {
    const started = Date.now();
    await fixture.inst.adapter.sendTurn({ threadId: "frozen", text: "fixture" });
    const done = await fixture.recorder.until((event) => event.type === "turn.completed", 10_000);
    expect(done).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fixture.recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("stopped answering") });
  } finally {
    await fixture.close();
  }
}, 15_000);

it("keeps waiting for a slow first token while the local server still answers", async () => {
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "60000");
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_PROBE_MS", "200");
  const fixture = await localServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [] })); return; }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"slow hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, 2_000);
  });
  try {
    await fixture.inst.adapter.sendTurn({ threadId: "slow", text: "fixture" });
    const done = await fixture.recorder.until((event) => event.type === "turn.completed", 10_000);
    expect(done).toMatchObject({ ok: true });
    expect(fixture.recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "slow hello" });
  } finally {
    await fixture.close();
  }
}, 15_000);

it("checks only servers on this machine or network, never a cloud provider", () => {
  for (const url of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1", "http://192.168.1.20:11434/v1", "http://10.0.0.5/v1", "http://172.20.1.2/v1", "http://studio.local:1234/v1"]) {
    expect(onThisNetwork(url), url).toBe(true);
  }
  for (const url of ["https://openrouter.ai/api/v1", "https://api.together.xyz/v1", "http://172.32.0.1/v1", "not a url"]) {
    expect(onThisNetwork(url), url).toBe(false);
  }
});
