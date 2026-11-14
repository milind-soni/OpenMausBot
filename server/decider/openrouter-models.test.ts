import { describe, expect, it, vi } from "vitest";

import { OPENROUTER_DECIDER_MODELS, createOpenRouterModelCatalog, decisionsModels, geminiChatModels, mergeModels } from "./openrouter-models.ts";

const URL_OK = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
const URL_TEXT = "https://openrouter.ai/api/v1/models?output_modalities=text";
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name of ${id}`,
  supported_parameters: [],
  architecture: { output_modalities: ["decisions"] },
  ...extra,
});
const catalog = (...models: unknown[]) => new Response(JSON.stringify({ data: models }), { status: 200 });
const chat = (id: string, extra: Record<string, unknown> = {}) =>
  model(id, { supported_parameters: ["max_tokens", "temperature", "response_format", "structured_outputs"], architecture: { output_modalities: ["text"] }, ...extra });

describe("which OpenRouter models the picker offers", () => {
  it("keeps decisions models, saveable ids only, and drops chat models and ~aliases", () => {
    const found = decisionsModels({
      data: [
        model("acme/plain"),
        model("acme/free:free"),
        model("~acme/latest"),
        model("acme/chatty", { architecture: { output_modalities: ["text"] } }),
        model("acme/no-arch", { architecture: undefined }),
        model("acme/too+odd"),
        { name: "no id" },
        "junk",
      ],
    });
    expect([...found!.keys()]).toEqual(["acme/plain", "acme/free:free"]);
  });

  it("is null for anything that is not a model list", () => {
    expect(decisionsModels({ error: "nope" })).toBeNull();
    expect(decisionsModels(null)).toBeNull();
  });

  it("lists curated models first, in curated order and under the catalog's name, drops vanished ones, then the rest by name", () => {
    const [first, second] = OPENROUTER_DECIDER_MODELS;
    const list = mergeModels(new Map([["zeta/model", "Zeta"], [second!.id, "Renamed second"], [first!.id, "Renamed first"], ["alpha/model", "Alpha"]]));
    expect(list.source).toBe("openrouter");
    expect(list.models).toEqual([
      { id: first!.id, name: "Renamed first", group: "recommended", api: "decisions" },
      { id: second!.id, name: "Renamed second", group: "recommended", api: "decisions" },
      { id: "alpha/model", name: "Alpha", group: "more", api: "decisions" },
      { id: "zeta/model", name: "Zeta", group: "more", api: "decisions" },
    ]);
  });

  it("falls back to the curated list when none of it is offered any more", () => {
    expect(mergeModels(new Map([["alpha/model", "Alpha"]])).source).toBe("builtin");
  });

  it("offers Gemini Flash chat models that take every chat parameter, as uncalibrated chat models sorted by name", () => {
    const found = geminiChatModels({
      data: [
        chat("google/gemini-3.5-flash", { name: "Google: Gemini 3.5 Flash" }),
        chat("google/gemini-2.5-flash", { name: "Google: Gemini 2.5 Flash" }),
        chat("google/gemini-3.5-flash:batch"),
        chat("google/gemini-3-pro-image", { architecture: { output_modalities: ["image", "text"] } }),
        chat("google/gemini-omni-1.2-flash", { architecture: { output_modalities: ["text", "video"] } }),
        chat("google/gemini-old-flash", { supported_parameters: ["max_tokens", "temperature", "response_format"] }),
        chat("google/gemini-2.5-pro"),
        chat("google/gemma-4"),
        chat("acme/gemini-clone"),
        chat("google/gemini-flash-no-arch", { architecture: undefined }),
        "junk",
      ],
    });
    expect(found).toEqual([
      { id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", group: "chat", api: "chat" },
      { id: "google/gemini-3.5-flash", name: "Google: Gemini 3.5 Flash", group: "chat", api: "chat" },
    ]);
    expect(geminiChatModels({ error: "nope" })).toBeNull();
  });

  it("is all decisions models, led by the default", () => {
    expect(OPENROUTER_DECIDER_MODELS[0]!.id).toBe("typesafe/jev-1.13");
    expect(new Set(OPENROUTER_DECIDER_MODELS.map((m) => m.id)).size).toBe(OPENROUTER_DECIDER_MODELS.length);
  });
});

describe("the model catalog", () => {
  it("asks for decisions models and the Gemini text list, loads each once and caches for an hour; sends no key and refuses redirects", async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url) === URL_TEXT ? catalog(chat("google/gemini-2.5-flash")) : catalog(model(OPENROUTER_DECIDER_MODELS[0]!.id), model("alpha/model")));
    const models = createOpenRouterModelCatalog({ fetch: fetchImpl, now: () => clock });
    const first = await models.load();
    expect(first).toMatchObject({ source: "openrouter" });
    expect(first.models.find((m) => m.id === "alpha/model")).toMatchObject({ group: "more", api: "decisions" });
    expect(first.models.at(-1)).toMatchObject({ id: "google/gemini-2.5-flash", group: "chat", api: "chat" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).sort()).toEqual([URL_OK, URL_TEXT]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).not.toHaveProperty("authorization");
      expect(init?.redirect).toBe("error");
    }
    clock += 59 * 60_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += 2 * 60_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
    ["an HTTP error", async () => new Response("no", { status: 500 })],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
    ["a body that is not a model list", async () => new Response("{}", { status: 200 })],
  ])("%s → the built-in list, retried after a minute", async (_name, answer) => {
    let clock = 0;
    const fetchImpl = vi.fn<typeof fetch>(answer as typeof fetch);
    const models = createOpenRouterModelCatalog({ fetch: fetchImpl, now: () => clock });
    const list = await models.load();
    expect(list.source).toBe("builtin");
    expect(list.models.map((m) => m.id)).toEqual(OPENROUTER_DECIDER_MODELS.map((m) => m.id));
    expect(list.models.every((m) => m.group === "recommended" && m.api === "decisions")).toBe(true);
    clock += 30_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += 31_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("still lists the decisions models when only the Gemini catalog fails, and image catalogs never ask for it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url) === URL_TEXT ? new Response("no", { status: 500 }) : catalog(model(OPENROUTER_DECIDER_MODELS[0]!.id)));
    const list = await createOpenRouterModelCatalog({ fetch: fetchImpl }).load();
    expect(list.source).toBe("openrouter");
    expect(list.models.some((m) => m.group === "chat")).toBe(false);
    // Nor beside the built-in list, whose note says the catalog could not be loaded; and never an id twice.
    const decisionsDown = vi.fn<typeof fetch>(async (url) => String(url) === URL_TEXT ? catalog(chat("google/gemini-2.5-flash")) : new Response("no", { status: 500 }));
    expect((await createOpenRouterModelCatalog({ fetch: decisionsDown }).load()).models.some((m) => m.group === "chat")).toBe(false);
    const both = vi.fn<typeof fetch>(async (url) =>
      String(url) === URL_TEXT ? catalog(chat("google/gemini-x-flash")) : catalog(model(OPENROUTER_DECIDER_MODELS[0]!.id), model("google/gemini-x-flash")));
    const ids = (await createOpenRouterModelCatalog({ fetch: both }).load()).models.filter((m) => m.id === "google/gemini-x-flash");
    expect(ids).toEqual([expect.objectContaining({ api: "decisions" })]);
    const imageFetch = vi.fn<typeof fetch>(async () => catalog(model("acme/painter", { architecture: { output_modalities: ["image"] } })));
    await createOpenRouterModelCatalog({ fetch: imageFetch, output: "image", curated: [{ id: "acme/painter", name: "Painter" }] }).load();
    expect(imageFetch).toHaveBeenCalledTimes(1);
  });

  it("never fetches from an address a key could not be sent to", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const list = await createOpenRouterModelCatalog({ fetch: fetchImpl }).load("http://gateway.example.com");
    expect(list.source).toBe("builtin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
