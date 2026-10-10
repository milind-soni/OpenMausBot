import { describe, expect, it } from "vitest";
import { containsBrace, hasBrace, packCatalog, trimModelsDevCatalog, unpackCatalog, type CatalogDrop } from "./trim.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  family: "demo",
  description: "A demo model.",
  attachment: false,
  reasoning: true,
  tool_call: true,
  temperature: true,
  release_date: "2026-05-01",
  last_updated: "2026-06-01",
  modalities: { input: ["text", "image"], output: ["text"] },
  open_weights: false,
  limit: { context: 200_000, output: 8_192 },
  cost: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 },
  ...extra,
});

const provider = (id: string, models: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Provider ${id}`,
  env: [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
  npm: "@ai-sdk/openai-compatible",
  api: `https://api.${id}.example/v1/`,
  doc: `https://docs.${id}.example/`,
  models,
  ...extra,
});

function trimWithDrops(raw: unknown) {
  const drops: CatalogDrop[] = [];
  const providers = trimModelsDevCatalog(raw, { onDrop: (drop) => drops.push(drop) });
  return { providers, drops };
}

describe("brace detection", () => {
  it("finds braces in strings, object keys and nested arrays", () => {
    expect(hasBrace("m-{env:OMB_MP_KEY_VICTIM}")).toBe(true);
    expect(hasBrace("closing } only")).toBe(true);
    expect(hasBrace("plain-model/v1")).toBe(false);
    expect(containsBrace({ a: [{ b: "ok" }, { c: ["x{file:~/secret.txt}"] }] })).toBe(true);
    expect(containsBrace({ "key{": "value" })).toBe(true);
    expect(containsBrace({ a: [1, true, null, { b: "ok" }] })).toBe(false);
  });

  it("treats data nested deeper than models.dev ever goes as unsafe", () => {
    let deep: unknown = "ok";
    for (let depth = 0; depth < 12; depth += 1) deep = { deep };
    expect(containsBrace(deep)).toBe(true);
  });
});

describe("trimModelsDevCatalog brace filter", () => {
  it("drops a provider whose api, name, env, npm or doc holds a brace, and keeps the rest", () => {
    const { providers, drops } = trimWithDrops({
      good: provider("good", { m1: model("m1") }),
      "tmpl-api": provider("tmpl-api", { m1: model("m1") }, { api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1" }),
      "tmpl-name": provider("tmpl-name", { m1: model("m1") }, { name: "Evil {env:OMB_MP_KEY_OTHER}" }),
      "tmpl-env": provider("tmpl-env", { m1: model("m1") }, { env: ["{file:~/.ssh/id_rsa}"] }),
      "tmpl-npm": provider("tmpl-npm", { m1: model("m1") }, { npm: "@evil/{env:HOME}" }),
      "tmpl-doc": provider("tmpl-doc", { m1: model("m1") }, { doc: "https://docs.example/{file:x}" }),
      "tmpl-extra": provider("tmpl-extra", { m1: model("m1") }, { note: "anything {" }),
    });
    expect(Object.keys(providers)).toEqual(["good"]);
    expect(drops.filter((drop) => drop.reason === "brace").map((drop) => drop.provider).sort())
      .toEqual(["tmpl-api", "tmpl-doc", "tmpl-env", "tmpl-extra", "tmpl-name", "tmpl-npm"]);
  });

  it("drops only the models carrying a brace, wherever in the model it sits", () => {
    const { providers, drops } = trimWithDrops({
      router: provider("router", {
        safe: model("safe"),
        "x{env:OMB_MP_KEY_OTHER}": model("x{env:OMB_MP_KEY_OTHER}"),
        "y-file": model("y-file", { name: "y{file:~/.ssh/id_rsa}" }),
        "z-override": model("z-override", { provider: { api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1" } }),
        "w-description": model("w-description", { description: "uses {json} mode" }),
      }),
    });
    expect(Object.keys(providers.router!.models)).toEqual(["safe"]);
    expect(drops).toEqual(expect.arrayContaining([
      { provider: "router", model: "x{env:OMB_MP_KEY_OTHER}", reason: "brace" },
      { provider: "router", model: "y-file", reason: "brace" },
      { provider: "router", model: "z-override", reason: "brace" },
      { provider: "router", model: "w-description", reason: "brace" },
    ]));
    expect(containsBrace(providers)).toBe(false);
  });

  it("catches a brace written as a JSON \\u007b escape", () => {
    const text = '{"p":{"id":"p","name":"P","env":[],"models":{"m":{"id":"m","name":"m-\\u007benv:OMB_MP_KEY_VICTIM\\u007d","tool_call":true,"modalities":{"input":["text"]}}}}}';
    const { providers, drops } = trimWithDrops(JSON.parse(text));
    expect(providers.p!.models).toEqual({});
    expect(drops).toEqual([{ provider: "p", model: "m", reason: "brace" }]);
  });

  it("drops a model whose key alone holds a brace", () => {
    // No `id` and a clean name: only the key carries the substitution.
    const text = '{"p":{"id":"p","name":"P","env":[],"models":{' +
      '"x{env:OMB_MP_KEY_OTHER}":{"name":"clean","tool_call":true,"modalities":{"input":["text"]}},' +
      '"ok":{"name":"ok","tool_call":true,"modalities":{"input":["text"]}}}}}';
    const { providers, drops } = trimWithDrops(JSON.parse(text));
    expect(Object.keys(providers.p!.models)).toEqual(["ok"]);
    expect(drops).toEqual([{ provider: "p", model: "x{env:OMB_MP_KEY_OTHER}", reason: "brace" }]);
  });

  it("never lets a brace through, whatever the input", () => {
    const hostile = {
      a: provider("a", { "{": model("{"), "}": model("}"), ok: model("ok", { modalities: { input: ["text", "{x}"] } }) }),
      "b{": provider("b{", {}),
    };
    expect(containsBrace(trimModelsDevCatalog(hostile))).toBe(false);
  });
});

describe("trimModelsDevCatalog shape", () => {
  it("keeps only current, tool-calling, text-input models, silently", () => {
    const { providers, drops } = trimWithDrops({
      p: provider("p", {
        keep: model("keep"),
        beta: model("beta", { status: "beta" }),
        old: model("old", { status: "deprecated" }),
        notools: model("notools", { tool_call: false }),
        imageonly: model("imageonly", { modalities: { input: ["image"], output: ["image"] } }),
      }),
    });
    expect(Object.keys(providers.p!.models)).toEqual(["beta", "keep"]);
    expect(providers.p!.models.beta!.status).toBe("beta");
    expect(drops).toEqual([]);
  });

  it("keeps exactly the listed fields", () => {
    const { providers } = trimWithDrops({ p: provider("p", { m: model("m", { status: "alpha" }) }) });
    expect(providers.p).toEqual({
      id: "p",
      name: "Provider p",
      env: ["P_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.p.example/v1",
      doc: "https://docs.p.example/",
      models: {
        m: {
          id: "m",
          name: "M",
          tool_call: true,
          reasoning: true,
          attachment: false,
          modalities: { input: ["text", "image"] },
          release_date: "2026-05-01",
          limit: { context: 200_000 },
          cost: { input: 1, output: 4 },
          status: "alpha",
        },
      },
    });
  });

  it("keeps https and loopback base URLs, drops others, and keeps https doc links only", () => {
    const { providers } = trimWithDrops({
      local: provider("local", {}, { api: "http://127.0.0.1:1234/v1", doc: "http://docs.example" }),
      plain: provider("plain", {}, { api: "http://api.example/v1" }),
      creds: provider("creds", {}, { api: "https://user:pass@api.example/v1" }),
    });
    expect(providers.local!.api).toBe("http://127.0.0.1:1234/v1");
    expect(providers.local!.doc).toBeUndefined();
    expect(providers.plain!.api).toBeUndefined();
    expect(providers.creds!.api).toBeUndefined();
  });

  it("rejects malformed entries and cleans display names", () => {
    const { providers, drops } = trimWithDrops({
      "Bad ID": provider("Bad ID", {}),
      mismatch: provider("other", {}),
      envs: provider("envs", {}, { env: ["OK_KEY", "NOT OK"] }),
      p: provider("p", {
        "has space": model("has space"),
        wrongid: model("different"),
        tabbed: model("tabbed", { name: "Turbo\t" }),
      }),
      notobject: "nope",
    });
    expect(Object.keys(providers)).toEqual(["p"]);
    expect(Object.keys(providers.p!.models)).toEqual(["tabbed"]);
    expect(providers.p!.models.tabbed!.name).toBe("Turbo");
    expect(drops.map((drop) => `${drop.provider}/${drop.model ?? ""}:${drop.reason}`).sort()).toEqual([
      "Bad ID/:invalid", "envs/:invalid", "mismatch/:invalid", "notobject/:invalid", "p/has space:invalid", "p/wrongid:invalid",
    ]);
  });

  it("gives ids like __proto__ and constructor no special meaning", () => {
    const text = '{"p":{"id":"p","name":"P","env":[],"models":{' +
      '"__proto__":{"name":"proto","tool_call":true,"reasoning":false,"modalities":{"input":["text"]}},' +
      '"ok":{"name":"ok","tool_call":true,"modalities":{"input":["text"]}}}}}';
    const { providers, drops } = trimWithDrops(JSON.parse(text));
    const models = providers.p!.models;
    expect(Object.keys(models)).toEqual(["ok"]);
    expect(drops).toEqual([{ provider: "p", model: "__proto__", reason: "invalid" }]);
    // The `__proto__` entry did not become the map's prototype, and names
    // inherited from Object.prototype are not catalog hits either.
    for (const id of ["name", "reasoning", "constructor", "toString", "hasOwnProperty"]) {
      expect(models[id], id).toBeUndefined();
      expect(providers[id], id).toBeUndefined();
    }
    expect(trimModelsDevCatalog(null)["constructor"]).toBeUndefined();
  });

  it("returns an empty catalog for non-object input", () => {
    expect(trimModelsDevCatalog(null)).toEqual({});
    expect(trimModelsDevCatalog([provider("a", {})])).toEqual({});
    expect(trimModelsDevCatalog("{}")).toEqual({});
  });

  it("is idempotent through the on-disk form", () => {
    const once = trimModelsDevCatalog({
      b: provider("b", { z: model("z"), a: model("a", { status: "beta" }) }),
      a: provider("a", { m: model("m") }),
    });
    const packed = packCatalog(once);
    expect(Object.keys(once)).toEqual(["a", "b"]);
    expect(Object.keys(once.b!.models)).toEqual(["a", "z"]);
    expect(packed.b!.models.a).not.toHaveProperty("id");
    expect(packed.b!.models.a).not.toHaveProperty("tool_call");
    expect(trimModelsDevCatalog(unpackCatalog(JSON.parse(JSON.stringify(packed))))).toEqual(once);
  });
});
