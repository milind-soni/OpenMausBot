import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ENDPOINTS, fetchSetupModels, normalizeApiUrl, verifySetupCompletion } from "./cli-api-setup.ts";

const key = "sk-setup-fixture-secret";
const base = "https://provider.example/v1";
const reply = { choices: [{ message: { role: "assistant", content: "OK" } }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mockFetch = (response: Response) => {
  const fn = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("API setup endpoint validation", () => {
  it("offers provider API URLs and key pages, not a stale model catalog", () => {
    expect(API_ENDPOINTS.map(({ id, url }) => [id, url])).toEqual([
      ["openai", "https://api.openai.com/v1"],
      ["openrouter", "https://openrouter.ai/api/v1"],
      ["groq", "https://api.groq.com/openai/v1"],
    ]);
    for (const endpoint of API_ENDPOINTS) expect(endpoint.keyUrl).toMatch(/^https:\/\//u);
  });

  it("normalizes HTTPS prefixes and permits only loopback HTTP", () => {
    expect(normalizeApiUrl("  https://PROVIDER.example:443/v1///  ")).toBe(base);
    expect(normalizeApiUrl("https://provider.example")).toBe("https://provider.example");
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(normalizeApiUrl(`http://${host}:1234/v1/`)).toBe(`http://${host}:1234/v1`);
  });

  it.each([
    "not a URL", "file:///tmp/provider", "ftp://provider.example/v1", "http://provider.example/v1",
    "http://localhost.example/v1", "http://192.168.1.1/v1", "http://0.0.0.0/v1",
    `https://user:${key}@provider.example/v1`, "https://@provider.example/v1",
    `https://provider.example/v1?key=${key}`, "https://provider.example/v1?", "https://provider.example/v1#",
    "https://provider.example/v1#fragment", "https://provider.example\\v1", "https://provi\nder.example/v1",
  ])("rejects an unsafe URL without echoing it: case %#", (url) => {
    expect(() => normalizeApiUrl(url)).toThrow(/HTTPS API base URL/u);
    try { normalizeApiUrl(url); } catch (error) { expect(String(error)).not.toContain(key); }
  });
});

describe("API setup models", () => {
  it("authenticates only the direct /models GET and parses a live catalog", async () => {
    const fetch = mockFetch(json({ data: [
      { id: "provider/model-b", name: "Model B" },
      { id: "provider/model-a" }, { id: "provider/model-b", name: "Duplicate" },
      null, { id: 5 }, { id: "  " }, { id: "bad\u001bmodel" },
    ] }));
    await expect(fetchSetupModels(`${base}/`, key)).resolves.toEqual([
      { id: "provider/model-b", label: "Model B" }, { id: "provider/model-a", label: "provider/model-a" },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${base}/models`, {
      method: "GET", headers: { authorization: `Bearer ${key}` }, signal: expect.any(AbortSignal), redirect: "error",
    });
  });

  it.each([{}, null, [], { models: ["wrong contract"] }, { data: [] }, { data: [{ id: "" }] }])("rejects unusable catalogs without persisting a fallback: case %#", async (body) => {
    mockFetch(json(body));
    await expect(fetchSetupModels(base, key)).rejects.toThrow(/no usable models.*manually/u);
  });

  it("does not expose malformed JSON or credentials", async () => {
    mockFetch(new Response(`provider echoed ${key}`));
    const failure = await fetchSetupModels(base, key).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("invalid JSON");
    expect(String(failure)).not.toContain(key);
  });

  it("stops after eight seconds and aborts the request, even if fetch never settles", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const failure = expect(fetchSetupModels(base, key)).rejects.toThrow(/timed out after 8 seconds/u);
    await vi.advanceTimersByTimeAsync(8_000);
    await failure;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes reading the model-list body in the timeout", async () => {
    vi.useFakeTimers();
    const response = json({});
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    mockFetch(response);
    const failure = expect(fetchSetupModels(base, key)).rejects.toThrow(/timed out after 8 seconds/u);
    await vi.advanceTimersByTimeAsync(8_000);
    await failure;
  });
});

describe("consented API setup completion", () => {
  it("sends one tiny non-streaming message without model-specific tuning flags", async () => {
    const fetch = mockFetch(json(reply));
    await expect(verifySetupCompletion(base, key, "chosen/model")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${base}/chat/completions`);
    expect(init).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "chosen/model", messages: [{ role: "user", content: "Reply with exactly OK." }], stream: false });
    expect(init?.signal?.aborted).toBe(false);
  });

  it.each(["https://openrouter.ai/api/v1", "https://API.openrouter.ai/v1"])("mirrors the selected OpenRouter upstream without allowing fallback: %s", async (url) => {
    const fetch = mockFetch(json(reply));
    await verifySetupCompletion(url, key, "chosen/model", "Selected upstream");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      model: "chosen/model", provider: { order: ["Selected upstream"], allow_fallbacks: false },
    });
  });

  it.each([base, "https://api.groq.com/openai/v1", "https://openrouter.ai.other.example/api/v1", "http://localhost:1234/v1"])("does not send OpenRouter routing to other endpoints: %s", async (url) => {
    const fetch = mockFetch(json(reply));
    await verifySetupCompletion(url, key, "chosen/model", "Selected upstream");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty("provider");
  });

  it.each([undefined, ""])("does not inherit environment routing when the effective instance has none: case %#", async (provider) => {
    vi.stubEnv("OPENAI_COMPAT_PROVIDER", "Unrelated environment upstream");
    const fetch = mockFetch(json(reply));
    await verifySetupCompletion("https://openrouter.ai/api/v1", key, "chosen/model", provider);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty("provider");
  });

  it.each([
    {}, { choices: [] }, { choices: [{ message: { role: "assistant", content: " " } }] },
    { choices: [{ message: { role: "user", content: "OK" } }] },
    { choices: [{ message: { role: "assistant", reasoning_content: "thinking" } }] },
    { choices: [{ message: { role: "assistant", content: [{ text: "wrong contract" }] } }] },
  ])("requires an actual nonempty assistant reply: case %#", async (body) => {
    mockFetch(json(body));
    await expect(verifySetupCompletion(base, key, "model")).rejects.toThrow(/did not return an assistant text reply/u);
  });

  it("aborts after thirty seconds without claiming the billable test succeeded", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const failure = expect(verifySetupCompletion(base, key, "model")).rejects.toThrow(/timed out after 30 seconds/u);
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("safe API setup failures", () => {
  it.each([
    [401, /key.*permissions/u], [403, /key.*permissions/u], [402, /credits.*billing/u],
    [429, /rate or quota limit/u], [400, /model ID.*Chat Completions/u],
    [404, /model ID.*Chat Completions/u], [422, /model ID.*Chat Completions/u],
    [503, /provider is unavailable/u], [302, /Redirects are not followed/u],
  ])("distinguishes HTTP %i without reading the provider's error body", async (status, expected) => {
    const response = json({ error: { message: `raw-secret ${key}` } }, status);
    const text = vi.spyOn(response, "text");
    const parse = vi.spyOn(response, "json");
    mockFetch(response);
    const failure = await verifySetupCompletion(base, key, "model").catch((error: Error) => error);
    expect(String(failure)).toContain(`HTTP ${status}`);
    expect(String(failure)).toMatch(expected);
    expect(String(failure)).not.toContain(key);
    expect(text).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("explains a missing models route instead of suggesting a model change", async () => {
    mockFetch(json({ error: key }, 404));
    await expect(fetchSetupModels(base, key)).rejects.toThrow(/HTTP 404.*\/models endpoint/u);
  });

  it.each(["network", "redirect"]) ("redacts raw %s fetch errors and their causes", async (kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError(`${kind}: ${key}`, { cause: new Error(`https://${key}@provider.example`) }));
    vi.stubGlobal("fetch", fetch);
    const failure = await fetchSetupModels(base, key).catch((error: Error) => error);
    expect(String(failure)).toMatch(/network.*direct API URL.*redirects are not followed/u);
    expect(String(failure)).not.toContain(key);
    expect((failure as Error).cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects missing or newline-containing inputs before any request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchSetupModels(base, " ")).rejects.toThrow(/API key/u);
    await expect(fetchSetupModels(base, `${key}\nInjected: value`)).rejects.toThrow(/API key/u);
    await expect(verifySetupCompletion(base, key, " ")).rejects.toThrow(/model ID/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not validate a trimmed replacement for an existing runtime credential", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchSetupModels(base, ` ${key} `)).rejects.toThrow(/API key/u);
    await expect(verifySetupCompletion(base, `${key}\n`, "model")).rejects.toThrow(/API key/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});
