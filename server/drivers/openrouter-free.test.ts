import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { engineFailureKind } from "./engine-errors.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import {
  FREE_MODEL_PREFERENCE, OPENROUTER_FAILURES, freeDefault, freeLabel, freeToolModels, openRouterFailure,
  type OpenRouterModelRow,
} from "./openrouter-free.ts";
import { classifyError } from "./retry.ts";

type Row = OpenRouterModelRow & { id: string; name: string };
/** A trimmed copy of the public https://openrouter.ai/api/v1/models (Oct 19 2026). */
const CATALOG: Row[] = JSON.parse(readFileSync(new URL("../fixtures/openrouter-models.json", import.meta.url), "utf8")).data;
const FREE_TOOL_IDS = CATALOG
  .filter((row) => row.id.endsWith(":free") && (row.supported_parameters as string[]).includes("tools"))
  .map((row) => row.id);
const PREFERRED = "nvidia/nemotron-3-super-120b-a12b:free";
const OPENROUTER = "https://openrouter.ai/api/v1";

let keys = 0;
const fixtureKey = () => `sk-or-v1-fixture-${++keys}-0123456789abcdef`;

const sse = (text: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\ndata: [DONE]\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

function stubOpenRouter(options: {
  freeTier: boolean | "unknown";
  rows?: readonly Row[];
  modelsReady?: Promise<unknown>;
  chat?: (body: { model: string }) => Response;
}) {
  const calls: Array<{ url: string; authorization: string | null; redirect?: RequestInit["redirect"] }> = [];
  const bodies: Array<{ model: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url === `${OPENROUTER}/key`) {
      return options.freeTier === "unknown"
        ? new Response("upstream down", { status: 503 })
        : Response.json({ data: { is_free_tier: options.freeTier, label: "fixture", usage: 0 } });
    }
    if (url === `${OPENROUTER}/models`) {
      await options.modelsReady;
      return Response.json({ data: options.rows ?? CATALOG });
    }
    if (url === `${OPENROUTER}/chat/completions`) {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return options.chat?.(body) ?? sse("hi");
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return { calls, bodies };
}

const createOpenRouter = (key: string, config: Record<string, unknown> = {}) => OpenAICompatDriver.create({
  instanceId: "openrouter", displayName: "OpenRouter", enabled: true,
  config: OpenAICompatDriver.decodeConfig({ url: OPENROUTER, apiKeyEnv: "OMB_OPENROUTER_API_KEY", ...config }),
  environment: { OMB_OPENROUTER_API_KEY: key },
});

async function openRouterInstance(key: string, config: Record<string, unknown> = {}) {
  const instance = await createOpenRouter(key, config);
  await instance.startupModelRefresh;
  return instance;
}

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("free OpenRouter models", () => {
  it("finds the free models that take tools in OpenRouter's order", () => {
    expect(freeToolModels(CATALOG)).toEqual(FREE_TOOL_IDS);
    expect(FREE_TOOL_IDS).toHaveLength(15);
    // Free but without tools, zero-priced but not ":free", and the router are never a bot's default.
    expect(FREE_TOOL_IDS).not.toContain("nvidia/nemotron-3.5-content-safety:free");
    expect(FREE_TOOL_IDS).not.toContain("google/lyria-3-pro-preview");
    expect(FREE_TOOL_IDS).not.toContain("openrouter/free");
  });

  it("prefers the listed models, then the first free tool-capable model", () => {
    expect(freeDefault(FREE_TOOL_IDS)).toBe(PREFERRED);
    expect(freeDefault(FREE_TOOL_IDS.filter((id) => id !== PREFERRED))).toBe("google/gemma-4-31b-it:free");
    const unlisted = FREE_TOOL_IDS.filter((id) => !FREE_MODEL_PREFERENCE.includes(id));
    expect(freeDefault(unlisted)).toBe("xingchen-agi/xing4.0-29b-a4b:free");
    expect(freeDefault([])).toBeUndefined();
  });

  it("marks free models once, by id or by zero prices", () => {
    expect(freeLabel("NVIDIA: Nemotron 3 Super (free)", { id: PREFERRED })).toBe("NVIDIA: Nemotron 3 Super (free)");
    expect(freeLabel("vendor/model:free", { id: "vendor/model:free" })).toBe("vendor/model:free (free)");
    expect(freeLabel("Lyria", { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" } })).toBe("Lyria (free)");
    expect(freeLabel("Half free", { id: "vendor/half", pricing: { prompt: "0", completion: "0.000001" } })).toBe("Half free");
    expect(freeLabel("DeepSeek", { id: "deepseek/deepseek-v4.1-flash-1017", pricing: { prompt: "0.0000003", completion: "0.0000012" } })).toBe("DeepSeek");
  });

  it("gives a free-tier key a free tool-capable default and lists those models first", async () => {
    const key = fixtureKey();
    const { calls } = stubOpenRouter({ freeTier: true });
    const instance = await openRouterInstance(key);
    try {
      expect(instance.models.default).toBe(PREFERRED);
      expect(instance.models.options.slice(0, FREE_TOOL_IDS.length).map((option) => option.id)).toEqual(FREE_TOOL_IDS);
      expect(instance.models.options.map((option) => option.id).sort()).toEqual(CATALOG.map((row) => row.id).sort());
      const label = (id: string) => instance.models.options.find((option) => option.id === id)?.label;
      expect(label("google/lyria-3-pro-preview")).toBe("Google: Lyria 3 Pro Preview (free)");
      expect(label("deepseek/deepseek-v4.1-flash-1017")).toBe("DeepSeek: DeepSeek V4.1 Flash 1017");
      const keyCalls = calls.filter((call) => call.url.endsWith("/key"));
      expect(keyCalls).toEqual([{ url: `${OPENROUTER}/key`, authorization: `Bearer ${key}`, redirect: "manual" }]);
    } finally {
      await instance.dispose();
    }
  });

  it("falls back to the first free tool-capable model when no preferred one is listed", async () => {
    const rows = CATALOG.filter((row) => !FREE_MODEL_PREFERENCE.includes(row.id));
    stubOpenRouter({ freeTier: true, rows });
    const instance = await openRouterInstance(fixtureKey());
    try {
      expect(instance.models.default).toBe("xingchen-agi/xing4.0-29b-a4b:free");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps today's default and order for a paid key", async () => {
    stubOpenRouter({ freeTier: false });
    const instance = await openRouterInstance(fixtureKey());
    try {
      expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-1017");
      expect(instance.models.options.map((option) => option.id)).toEqual(CATALOG.map((row) => row.id));
      expect(instance.models.options.find((option) => option.id === PREFERRED)?.label).toBe("NVIDIA: Nemotron 3 Super (free)");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps the seeded default for a paid key while the catalog loads", async () => {
    const models = gate();
    const { calls } = stubOpenRouter({ freeTier: false, modelsReady: models.ready });
    const instance = await createOpenRouter(fixtureKey());
    try {
      await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith("/key"))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.models.default).toBe("meta-llama/llama-3.3-70b-instruct");
      models.release();
      await instance.startupModelRefresh;
      expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-1017");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps today's default when OpenRouter cannot say which tier the key is on", async () => {
    stubOpenRouter({ freeTier: "unknown" });
    const instance = await openRouterInstance(fixtureKey());
    try {
      expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-1017");
    } finally {
      await instance.dispose();
    }
  });

  it("never overrides a model chosen in the config or for the turn", async () => {
    const { bodies } = stubOpenRouter({ freeTier: true });
    const instance = await openRouterInstance(fixtureKey(), { model: "deepseek/deepseek-v4.1-flash-1017" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-1017");
      await instance.adapter.sendTurn({ threadId: "chosen-config", text: "hello" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "chosen-config");
      await instance.adapter.sendTurn({ threadId: "chosen-turn", text: "hello", model: "anthropic/claude-sonnet-5" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "chosen-turn");
      expect(bodies.map((body) => body.model)).toEqual(["deepseek/deepseek-v4.1-flash-1017", "anthropic/claude-sonnet-5"]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("uses the free fallback before the catalog arrives, and a first turn waits for the catalog", async () => {
    const models = gate();
    const { bodies } = stubOpenRouter({ freeTier: true, modelsReady: models.ready, rows: CATALOG.filter((row) => row.id !== PREFERRED) });
    const instance = await createOpenRouter(fixtureKey());
    const recorder = recordEvents(instance.adapter);
    try {
      await vi.waitFor(() => expect(instance.models.default).toBe(FREE_MODEL_PREFERENCE[0]));
      const turn = instance.adapter.sendTurn({ threadId: "first", text: "hello" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bodies).toEqual([]);
      models.release();
      await turn;
      await recorder.until((event) => event.type === "turn.completed");
      expect(bodies.map((body) => body.model)).toEqual(["google/gemma-4-31b-it:free"]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("asks /key once per key and never writes the key to logs, events or the catalog", async () => {
    const key = fixtureKey();
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const { calls } = stubOpenRouter({
      freeTier: true,
      chat: () => Response.json({ error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } }, { status: 402 }),
    });
    const first = await openRouterInstance(key);
    const second = await openRouterInstance(key);
    const recorder = recordEvents(second.adapter);
    try {
      await second.adapter.sendTurn({ threadId: "t", text: "hello", model: "deepseek/deepseek-v4.1-flash-1017" });
      await recorder.until((event) => event.type === "turn.completed");
      expect(calls.filter((call) => call.url.endsWith("/key"))).toHaveLength(1);
      const output = JSON.stringify([
        recorder.events, first.models, second.models, await second.snapshot(),
        logged.flatMap((spy) => spy.mock.calls),
      ]);
      expect(output).not.toContain(key);
      expect(output).not.toContain("0123456789abcdef");
    } finally {
      recorder.stop();
      await first.dispose();
      await second.dispose();
    }
  });
});

describe("OpenRouter failures in plain words", () => {
  const raw = (status: number, message: string) => `upstream HTTP ${status}: ${message}`;

  it.each([
    ["402", raw(402, "Insufficient credits. Add more using https://openrouter.ai/settings/credits"), "vendor/paid", OPENROUTER_FAILURES.credits],
    ["insufficient credits in the stream", "provider returned a streaming completion error: Insufficient credits", "vendor/paid", OPENROUTER_FAILURES.credits],
    ["requires more credits", raw(402, "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1200."), "vendor/paid", OPENROUTER_FAILURES.credits],
    ["data policy", raw(404, "No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy"), PREFERRED, OPENROUTER_FAILURES.privacy],
    ["tool use", raw(404, "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection"), "vendor/no-tools", OPENROUTER_FAILURES.tools],
    ["free daily limit", raw(429, "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"), PREFERRED, OPENROUTER_FAILURES.freeLimit],
    ["429 upstream on a free model", raw(429, "Provider returned error"), PREFERRED, OPENROUTER_FAILURES.freeLimit],
  ])("maps %s", (_name, text, model, message) => {
    expect(openRouterFailure(text, model)).toBe(message);
  });

  it("leaves other failures as they are", () => {
    expect(openRouterFailure(raw(429, "Provider returned error"), "vendor/paid")).toBeNull();
    expect(openRouterFailure(raw(404, "No endpoints found matching your data policy (Zero data retention)"), "vendor/paid")).toBeNull();
    expect(openRouterFailure(raw(500, "Internal Server Error"), PREFERRED)).toBeNull();
    expect(openRouterFailure(raw(401, "User not found."), PREFERRED)).toBeNull();
  });

  it("keeps each failure's class, so credits are never retried and the free limit stays a rate limit", () => {
    expect(classifyError({ text: OPENROUTER_FAILURES.credits })).toEqual({ transient: false, reason: "quota" });
    expect(engineFailureKind(OPENROUTER_FAILURES.credits)).toBe("credits");
    expect(classifyError({ text: OPENROUTER_FAILURES.privacy })).toEqual({ transient: false, reason: "not_found" });
    expect(classifyError({ text: OPENROUTER_FAILURES.tools })).toEqual({ transient: false, reason: "not_found" });
    expect(classifyError({ text: OPENROUTER_FAILURES.freeLimit })).toEqual({ transient: true, reason: "rate_limited" });
    expect(engineFailureKind(OPENROUTER_FAILURES.freeLimit)).toBe("rate_limit");
  });

  it("words an OpenRouter turn's refusal and sends a 402 only once", async () => {
    const { bodies } = stubOpenRouter({
      freeTier: false,
      chat: (body) => body.model.endsWith(":free")
        ? Response.json({ error: { message: "Rate limit exceeded: free-models-per-min.", code: 429 } }, { status: 429 })
        : Response.json({ error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } }, { status: 402 }),
    });
    const instance = await openRouterInstance(fixtureKey());
    const recorder = recordEvents(instance.adapter);
    const errorFor = (threadId: string) => recorder.events.find((event): event is Extract<RuntimeEvent, { type: "runtime.error" }> =>
      event.type === "runtime.error" && event.threadId === threadId)?.message;
    try {
      await instance.adapter.sendTurn({ threadId: "paid", text: "hello", model: "deepseek/deepseek-v4.1-flash-1017" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "paid");
      await instance.adapter.sendTurn({ threadId: "free", text: "hello", model: PREFERRED });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "free");
      expect(errorFor("paid")).toBe(OPENROUTER_FAILURES.credits);
      expect(errorFor("free")).toBe(OPENROUTER_FAILURES.freeLimit);
      expect(bodies.map((body) => body.model)).toEqual(["deepseek/deepseek-v4.1-flash-1017", PREFERRED]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("leaves another OpenAI-compatible host's errors and catalog alone", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/models")) return Response.json({ data: CATALOG });
      return Response.json({ error: { message: "Insufficient credits", code: 402 } }, { status: 402 });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "other", displayName: "Other", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://gateway.example.test/v1", apiKeyEnv: "OTHER_KEY" }),
      environment: { OTHER_KEY: fixtureKey() },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await vi.waitFor(() => expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-1017"));
      expect(instance.models.options.find((option) => option.id === "google/lyria-3-pro-preview")?.label).toBe("Google: Lyria 3 Pro Preview");
      await instance.adapter.sendTurn({ threadId: "t", text: "hello", model: "vendor/paid" });
      const failure = await recorder.until((event) => event.type === "runtime.error");
      expect((failure as { message: string }).message).toBe("upstream HTTP 402: Insufficient credits");
      expect(urls.some((url) => url.endsWith("/key"))).toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
