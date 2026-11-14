import { describe, expect, it, vi } from "vitest";

import { OPENROUTER_DECIDER_MODELS, createOpenRouterModelCatalog, decisionsModels, mergeModels } from "./openrouter-models.ts";

const URL_OK = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name of ${id}`,
  supported_parameters: [],
  architecture: { output_modalities: ["decisions"] },
  ...extra,
});
const catalog = (...models: unknown[]) => new Response(JSON.stringify({ data: models }), { status: 200 });

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

  it("is all decisions models, led by the default", () => {
    expect(OPENROUTER_DECIDER_MODELS[0]!.id).toBe("typesafe/jev-1.13");
    expect(new Set(OPENROUTER_DECIDER_MODELS.map((m) => m.id)).size).toBe(OPENROUTER_DECIDER_MODELS.length);
  });
});

describe("the model catalog", () => {
  it("asks for decisions models only, loads once and caches for an hour; sends no key and refuses redirects", async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => catalog(model(OPENROUTER_DECIDER_MODELS[0]!.id), model("alpha/model")));
    const models = createOpenRouterModelCatalog({ fetch: fetchImpl, now: () => clock });
    const first = await models.load();
    expect(first).toMatchObject({ source: "openrouter" });
    expect(first.models.find((m) => m.id === "alpha/model")).toMatchObject({ group: "more", api: "decisions" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(URL_OK);
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(init?.redirect).toBe("error");
    clock += 59 * 60_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await models.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never fetches from an address a key could not be sent to", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const list = await createOpenRouterModelCatalog({ fetch: fetchImpl }).load("http://gateway.example.com");
    expect(list.source).toBe("builtin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
