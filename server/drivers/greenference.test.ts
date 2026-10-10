import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_USER_TOOL_DEFINITION } from "../../shared/ask-question.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { GreenferenceDriver } from "./greenference.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const create = (config = {}) => GreenferenceDriver.create({
  instanceId: "greenference-test", displayName: "Greenference", enabled: true,
  config: GreenferenceDriver.decodeConfig(config), environment: { GREENFERENCE_TOKEN: "fixture-token" },
});
const streamed = () => new Response(': ping\n\ndata: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
{ headers: { "content-type": "text/event-stream" } });

describe("Greenference provider", () => {
  it("uses the documented endpoint and validates configuration", () => {
    expect(GreenferenceDriver.defaultConfig().url).toBe("https://llm.eu.greenference.com/v1");
    expect(GreenferenceDriver.decodeConfig({ url: "http://127.0.0.1:1234/v1/" }).url).toBe("http://127.0.0.1:1234/v1");
    for (const config of [{ tools: "false" }, { url: "http://example.com/v1" }, { url: "https://user:secret@example.com/v1" }, { url: "https://example.com/v1?key=secret" }]) {
      expect(() => GreenferenceDriver.decodeConfig(config)).toThrow();
    }
  });

  it("does not contact the provider or use another provider's key when unconfigured", async () => {
    vi.stubEnv("GREENFERENCE_TOKEN", "");
    vi.stubEnv("OPENAI_API_KEY", "not-greenference");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const instance = await GreenferenceDriver.create({ instanceId: "empty", displayName: "Greenference", enabled: true,
      config: GreenferenceDriver.defaultConfig(), environment: {} });
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Greenference API token") });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await instance.dispose(); }
  });

  it("never forwards the server's Greenference token to a custom endpoint without its own credential", async () => {
    vi.stubEnv("GREENFERENCE_TOKEN", "private-server-token");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const instance = await GreenferenceDriver.create({ instanceId: "custom", displayName: "Private", enabled: true,
      config: GreenferenceDriver.decodeConfig({ url: "https://private.example.test/v1" }), environment: {} });
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await instance.dispose(); }
  });

  it("discovers exact live IDs and context windows, filters unavailable/non-text models, and preserves a private model", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [
      { id: "greenference/vision", name: "Vision", context_length: 262144, input_modalities: ["text", "image"], output_modalities: ["text"], is_ready: true },
      { id: "greenference/text" }, { id: "greenference/text" }, { id: "offline", is_ready: false },
      { id: "audio", output_modalities: ["audio"] }, null, { id: "" },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    const instance = await create({ model: "private-model" });
    try {
      expect(instance.models).toEqual({ default: "private-model", options: [
        { id: "private-model", label: "private-model", custom: true },
        { id: "greenference/vision", label: "Vision", contextWindow: 262144 },
        { id: "greenference/text", label: "greenference/text" },
      ] });
      expect(fetcher.mock.calls[0]).toMatchObject(["https://llm.eu.greenference.com/v1/models", {
        headers: { authorization: "Bearer fixture-token" }, redirect: "error",
      }]);
      fetcher.mockImplementation(async () => { throw new Error("offline"); });
      await instance.refreshModels?.();
      expect(instance.models.options).toHaveLength(3);
      fetcher.mockImplementation(async () => Response.json({ data: [] }));
      await instance.refreshModels?.();
      expect(instance.models.options).toEqual([{ id: "private-model", label: "private-model", custom: true }]);
    } finally { await instance.dispose(); }
  });

  it("streams text and metered usage with the shared tools, without undocumented request extensions", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "greenference/text" }] });
      expect(String(url)).toBe("https://llm.eu.greenference.com/v1/chat/completions");
      request = init; return streamed();
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "chat", text: "hello" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
      expect(JSON.parse(String(request?.body))).toEqual({ model: "greenference/text", stream: true,
        messages: [{ role: "user", content: "hello" }], tools: [ASK_USER_TOOL_DEFINITION] });
      expect(request?.headers).toMatchObject({ authorization: "Bearer fixture-token" });
    } finally { recorder.stop(); await instance.dispose(); }
  });

  it.each([true, false])("uses the model's advertised image input: %s", async (vision) => {
    const directory = mkdtempSync(join(tmpdir(), "omb-greenference-image-"));
    const path = join(directory, "image.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    writeFileSync(path, bytes);
    let body: { messages: Array<{ content: unknown }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture", input_modalities: vision ? ["text", "image"] : ["text"] }] });
      body = JSON.parse(String(init?.body)); return streamed();
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "image", text: "Describe this.", images: [{ path, mime: "image/png", bytes: bytes.length }] });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      if (vision) expect(body?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "Describe this." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
      ]);
      else expect(body?.messages.at(-1)?.content).toEqual(expect.stringContaining("this model cannot see images"));
    } finally { recorder.stop(); await instance.dispose(); await removeTempDir(directory); }
  });
});
