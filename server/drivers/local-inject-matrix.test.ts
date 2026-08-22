// Broad inject matrix — every local host × every agent writer, plus the
// model-id dialects those CLIs actually speak. Catches day-one failures
// like Hermes auto-routing to OpenRouter (HTTP 401 Missing Authentication
// header) before a user hits them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DroidAgentDriver, droidInjectId, ensureDroidInjectModel } from "./acp/droid.ts";
import { ensureGrokInjectSlug } from "./acp/grok.ts";
import { HermesAgentDriver, ensureHermesInjectProvider, hermesAcpModelId } from "./acp/hermes.ts";
import { ensureKimiInjectAlias, KimiAgentDriver } from "./acp/kimi.ts";
import { ensureOpenCodeInjectModel } from "./acp/opencode.ts";
import { ensureQwenInjectModel, QwenAgentDriver } from "./acp/qwen.ts";
import { recordEvents } from "../testing/events.ts";
import {
  applyClaudeInject,
  applyOpenAIInject,
  anthropicBaseUrl,
  codexLocalProviderArgs,
  decodeInjectId,
  encodeInjectId,
  hostApiKey,
  injectedApiModel,
  LOCAL_HOSTS,
  localHost,
  mergeLocalInject,
} from "./local-inject.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(home);
  return home;
}

const UNIQUE_HOSTS = LOCAL_HOSTS.filter((host, index, all) => all.findIndex((row) => row.baseUrl === host.baseUrl) === index);

/** Model ids we have actually seen on oMLX / Unsloth / Ollama / LM Studio. */
const LIVE_MODEL_IDS = [
  "gemma-4-31b-it-bf16",
  "gemma-4-26B-A4B-it-GGUF",
  "GLM-5.2-fp8",
  "GLM-5.2-mxfp4",
  "MiniMax-M3-4bit",
  "Qwen3.6-35B-A3B-bf16",
  "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
  "Qwen3.8-27B-Abliterated-MLX-BF16",
  "mlx-community/GLM-5.2-mxfp4",
  "unsloth/gemma-4-26B-A4B-it-GGUF",
  "llama3.1:70b",
  "qwen2.5-coder:32b",
  "qwen/qwen3-coder-next",
] as const;

const OFFICIAL_SLUGS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "grok-4.6",
  "grok-4.5",
  "kimi-code/k3",
  "kimi-code/kimi-for-coding",
  "gpt-5.6-sol",
  "opencode-go/minimax-m3",
  "gemini-3.1-pro-high",
  "auto",
] as const;

describe("inject id dialect", () => {
  it.each(UNIQUE_HOSTS)("encodes $id as a pickable Custom row", (host) => {
    const id = encodeInjectId(host.id, "gemma-4-31b-it-bf16");
    expect(id).toBe(`${host.id}::gemma-4-31b-it-bf16`);
    expect(decodeInjectId(id)).toEqual({ host: host.id, model: "gemma-4-31b-it-bf16" });
  });

  it.each([...LIVE_MODEL_IDS])("accepts live model id %s", (model) => {
    expect(decodeInjectId(encodeInjectId("omlx", model))).toEqual({ host: "omlx", model });
  });

  it.each([...OFFICIAL_SLUGS])("does not treat official slug %s as an inject", (slug) => {
    expect(decodeInjectId(slug)).toBeNull();
    expect(injectedApiModel(slug)).toBeNull();
    expect(hermesAcpModelId(slug)).toBeNull();
  });

  it("rejects empty, unknown-host, and junk ids", () => {
    expect(decodeInjectId("")).toBeNull();
    expect(decodeInjectId("::gemma-4")).toBeNull();
    expect(decodeInjectId("omlx::")).toBeNull();
    expect(decodeInjectId("notahost::gemma-4-31b-it-bf16")).toBeNull();
    expect(decodeInjectId("omlx::bad id")).toBeNull();
  });
});

describe("host credentials", () => {
  it.each(UNIQUE_HOSTS)("$label has a stable OpenAI-compatible /v1 base", (host) => {
    expect(host.baseUrl.endsWith("/v1")).toBe(true);
    expect(anthropicBaseUrl(host)).toBe(host.baseUrl.replace(/\/v1$/, ""));
  });

  it("uses the declared placeholder key for oMLX / Ollama / EXO / LM Studio", () => {
    expect(hostApiKey(localHost("omlx")!, {})).toBe("omlx");
    expect(hostApiKey(localHost("ollama")!, {})).toBe("ollama");
    expect(hostApiKey(localHost("exo")!, {})).toBe("exo");
    expect(hostApiKey(localHost("lmstudio")!, {})).toBe("lm-studio");
  });

  it("never sends the Unsloth placeholder when a studio token is present", () => {
    const host = localHost("unsloth")!;
    expect(hostApiKey(host, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" })).toBe("unsloth-secret");
    expect(hostApiKey(host, {})).not.toBe("unsloth-secret");
  });

  it("reads the Unsloth studio key file from HOME", () => {
    const home = scratchHome("omb-unsloth-key-");
    mkdirSync(join(home, ".unsloth", "studio", "auth"), { recursive: true });
    writeFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), JSON.stringify({ api_key: "from-file" }));
    expect(hostApiKey(localHost("unsloth")!, { HOME: home })).toBe("from-file");
  });

  it("reads a minted Unsloth Studio token from the servers map", () => {
    const home = scratchHome("omb-unsloth-minted-");
    mkdirSync(join(home, ".unsloth", "studio", "auth"), { recursive: true });
    writeFileSync(
      join(home, ".unsloth", "studio", "auth", "agent_api_key.json"),
      JSON.stringify({
        servers: {
          "http://127.0.0.1:8888": { saved: [], minted: ["sk-unsloth-minted"] },
        },
      }),
    );
    expect(hostApiKey(localHost("unsloth")!, { HOME: home })).toBe("sk-unsloth-minted");
    expect(hostApiKey(localHost("unsloth_api")!, { HOME: home })).toBe("sk-unsloth-minted");
  });

  it("prefers a localhost minted token over a stale top-level api_key", () => {
    const home = scratchHome("omb-unsloth-mixed-");
    mkdirSync(join(home, ".unsloth", "studio", "auth"), { recursive: true });
    writeFileSync(
      join(home, ".unsloth", "studio", "auth", "agent_api_key.json"),
      JSON.stringify({
        api_key: "stale-legacy",
        servers: {
          "http://127.0.0.1:8888": { saved: [], minted: ["sk-unsloth-fresh"] },
        },
      }),
    );
    expect(hostApiKey(localHost("unsloth")!, { HOME: home })).toBe("sk-unsloth-fresh");
  });
});

describe("OpenAI / Anthropic env dialects", () => {
  it.each(UNIQUE_HOSTS)("applyOpenAIInject routes $id without touching official slugs", (host) => {
    const env: Record<string, string | undefined> = { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" };
    const applied = applyOpenAIInject(env, encodeInjectId(host.id, "gemma-4-31b-it-bf16"));
    expect(applied).toEqual({ model: "gemma-4-31b-it-bf16", injected: true });
    expect(env.OPENAI_BASE_URL).toBe(host.baseUrl);
    expect(env.OPENAI_API_KEY).toBe(hostApiKey(host, env));
  });

  it("applyOpenAIInject leaves cloud slugs alone so Hermes cannot auto-openrouter from a leftover key", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-or-user" };
    expect(applyOpenAIInject(env, "claude-sonnet-5")).toEqual({ model: "claude-sonnet-5", injected: false });
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("sk-or-user");
  });

  it.each(UNIQUE_HOSTS)("applyClaudeInject strips /v1 for $id (Anthropic-compatible)", (host) => {
    const env: Record<string, string | undefined> = { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" };
    const applied = applyClaudeInject(env, encodeInjectId(host.id, "MiniMax-M3-4bit"));
    expect(applied.injected).toBe(true);
    expect(env.ANTHROPIC_BASE_URL).toBe(anthropicBaseUrl(host));
    expect(env.ANTHROPIC_BASE_URL?.endsWith("/v1")).toBe(false);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(hostApiKey(host, env));
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3-4bit");
  });
});

describe("Codex provider dialect", () => {
  it("does not emit argv for reserved ollama / lmstudio providers", () => {
    expect(codexLocalProviderArgs({}, "ollama::llama3.1:70b")).toEqual([]);
    expect(codexLocalProviderArgs({}, "lmstudio::qwen2.5-coder:32b")).toEqual([]);
  });

  it.each(["omlx", "exo", "unsloth"] as const)("emits a -c provider for %s without putting the secret on argv", (hostId) => {
    const env: Record<string, string | undefined> = { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" };
    const args = codexLocalProviderArgs(env, encodeInjectId(hostId, "gemma-4-31b-it-bf16"));
    const rendered = JSON.stringify(args);
    expect(rendered).toContain(`model_providers.${hostId}.base_url`);
    expect(rendered).not.toContain("unsloth-secret");
  });
});

describe("Grok / Kimi / Droid / OpenCode writers × live ids", () => {
  it.each(["gemma-4-31b-it-bf16", "mlx-community/GLM-5.2-mxfp4", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"] as const)(
    "Grok writes a reusable slug for %s",
    (model) => {
      const home = scratchHome("omb-grok-mx-");
      mkdirSync(join(home, ".grok"), { recursive: true });
      const slug = ensureGrokInjectSlug(encodeInjectId("omlx", model), { HOME: home });
      expect(slug).not.toContain("::");
      const text = readFileSync(join(home, ".grok", "config.toml"), "utf8");
      expect(text).toContain(`model = "${model}"`);
      expect(text).toContain(`base_url = "http://127.0.0.1:8080/v1"`);
    },
  );

  it("Kimi keeps the API id in model= and sanitizes slashes only in the alias", () => {
    const home = scratchHome("omb-kimi-mx-");
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    const alias = ensureKimiInjectAlias("omlx::qwen/qwen3-coder-next", { HOME: home });
    expect(alias).toBe("omlx/qwen-qwen3-coder-next");
    const text = readFileSync(join(home, ".kimi-code", "config.toml"), "utf8");
    expect(text).toContain(`model = "qwen/qwen3-coder-next"`);
    expect(text).toContain(`type = "openai_legacy"`);
  });

  it.each(UNIQUE_HOSTS)("Droid BYOK row for $id uses generic-chat-completion-api", (host) => {
    const home = scratchHome("omb-droid-mx-");
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(join(home, ".factory", "settings.json"), "{}");
    const id = ensureDroidInjectModel(encodeInjectId(host.id, "gemma-4-31b-it-bf16"), {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(id).toBe(droidInjectId(host.id, "gemma-4-31b-it-bf16"));
    expect(id.startsWith("custom:openmausbot-")).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".factory", "settings.json"), "utf8")) as {
      customModels: Array<{ provider: string; baseUrl: string; apiKey: string; model: string }>;
    };
    expect(settings.customModels[0]).toMatchObject({
      provider: "generic-chat-completion-api",
      baseUrl: host.baseUrl,
      model: "gemma-4-31b-it-bf16",
      apiKey: hostApiKey(host, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" }),
    });
  });

  it.each(["omlx", "ollama", "lmstudio"] as const)("OpenCode provider/%s model key keeps slashes", (hostId) => {
    const home = scratchHome("omb-oc-mx-");
    const native = ensureOpenCodeInjectModel(encodeInjectId(hostId, "qwen/qwen3-coder-next"), { HOME: home });
    expect(native).toBe(`${hostId}/qwen/qwen3-coder-next`);
    const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")) as {
      provider: Record<string, { options: { baseURL: string }; models: Record<string, unknown> }>;
    };
    expect(config.provider[hostId].options.baseURL).toBe(localHost(hostId)!.baseUrl);
    expect(config.provider[hostId].models["qwen/qwen3-coder-next"]).toBeTruthy();
  });
});

describe("Qwen writer × hosts", () => {
  it.each(UNIQUE_HOSTS)("stores $id credentials in settings.env, not in the model row", (host) => {
    const home = scratchHome("omb-qwen-mx-");
    mkdirSync(join(home, ".qwen"), { recursive: true });
    const native = ensureQwenInjectModel(encodeInjectId(host.id, "gemma-4-31b-it-bf16"), {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(native).toBe("gemma-4-31b-it-bf16");
    const settings = JSON.parse(readFileSync(join(home, ".qwen", "settings.json"), "utf8")) as {
      env: Record<string, string>;
      modelProviders: { openai: Array<{ id: string; baseUrl: string; envKey: string; apiKey?: string }> };
    };
    const row = settings.modelProviders.openai[0];
    expect(row.id).toBe("gemma-4-31b-it-bf16");
    expect(row.baseUrl).toBe(host.baseUrl);
    expect(row.apiKey).toBeUndefined();
    expect(settings.env[row.envKey]).toBe(hostApiKey(host, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" }));
  });

  it("leaves official Qwen slugs untouched", () => {
    expect(ensureQwenInjectModel("qwen3-coder-plus", { HOME: scratchHome("omb-qwen-cloud-") })).toBe("qwen3-coder-plus");
  });
});

describe("Hermes writer — OpenRouter 401 class", () => {
  it.each([...LIVE_MODEL_IDS])("ACP model id for %s is custom:host:model, not a bare slug", (model) => {
    expect(hermesAcpModelId(encodeInjectId("omlx", model))).toBe(`custom:omlx:${model}`);
  });

  it.each(UNIQUE_HOSTS)("writes providers.$id without flipping model.provider away from auto", (host) => {
    const home = scratchHome("omb-hermes-mx-");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "config.yaml"),
      "model:\n  default: anthropic/claude-opus-4.6\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n",
    );
    const native = ensureHermesInjectProvider(encodeInjectId(host.id, "gemma-4-31b-it-bf16"), {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(native).toBe(`custom:${host.id}:gemma-4-31b-it-bf16`);
    const text = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
    expect(text).toContain("provider: auto");
    expect(text).toContain("https://openrouter.ai/api/v1");
    expect(text).toContain("anthropic/claude-opus-4.6");
    expect(text).toContain(`  ${host.id}:`);
    expect(text).toContain(`base_url: ${host.baseUrl}`);
    expect(text).toContain(`api_key: ${hostApiKey(host, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" })}`);
  });

  it("does not rewrite the user's OpenRouter default when the pick is a cloud slug", () => {
    const home = scratchHome("omb-hermes-cloud-");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const original = "model:\n  provider: auto\n";
    writeFileSync(join(home, ".hermes", "config.yaml"), original);
    expect(ensureHermesInjectProvider("anthropic/claude-opus-4.6", { HOME: home })).toBe("anthropic/claude-opus-4.6");
    expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).toBe(original);
  });

  it("upserts the same host once when two models share oMLX", () => {
    const home = scratchHome("omb-hermes-two-");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    ensureHermesInjectProvider("omlx::gemma-4-31b-it-bf16", { HOME: home });
    ensureHermesInjectProvider("omlx::GLM-5.2-fp8", { HOME: home });
    const text = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
    expect(text.match(/^  omlx:$/gm)?.length).toBe(1);
  });
});

describe("probe payload dialects", () => {
  const probe = (payload: unknown) =>
    mergeLocalInject(
      { default: "keep", options: [{ id: "keep", label: "Keep" }] },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        if (String(url).includes(":8080")) return new Response(JSON.stringify(payload), { status: 200 });
        return new Response("nope", { status: 500 });
      },
    );

  it("reads OpenAI { data: [{ id }] }", async () => {
    const catalog = await probe({ data: [{ id: "gemma-4-31b-it-bf16" }] });
    expect(catalog.options.some((o) => o.id === "omlx::gemma-4-31b-it-bf16")).toBe(true);
  });

  it("reads { models: [\"id\"] } and { models: [{ name }] }", async () => {
    const asStrings = await probe({ models: ["MiniMax-M3-4bit"] });
    expect(asStrings.options.some((o) => o.id === "omlx::MiniMax-M3-4bit")).toBe(true);
    const asNames = await probe({ models: [{ name: "GLM-5.2-fp8" }] });
    expect(asNames.options.some((o) => o.id === "omlx::GLM-5.2-fp8")).toBe(true);
  });

  it("drops embedding models so they never land in Custom", async () => {
    const catalog = await probe({ data: [{ id: "nomic-embed-text" }, { id: "bge-large" }, { id: "ok-chat" }] });
    expect(catalog.options.some((o) => o.id.includes("embed") || o.id.includes("bge-"))).toBe(false);
    expect(catalog.options.some((o) => o.id === "omlx::ok-chat")).toBe(true);
  });

  it("keeps official rows first", async () => {
    const catalog = await probe({ data: [{ id: "gemma-4-31b-it-bf16" }] });
    expect(catalog.options[0]).toEqual({ id: "keep", label: "Keep" });
  });
});

describe("loaded host probes", () => {
  it("pins every host's actually-loaded models in one Custom list", async () => {
    const catalog = await mergeLocalInject(
      { default: "keep", options: [{ id: "keep", label: "Keep" }] },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        const href = String(url);
        if (href.includes("/v1/models/status")) {
          return new Response(
            JSON.stringify({
              default_model: "Qwen3.8-27B-Abliterated-MLX-BF16",
              models: [
                { id: "Qwen3.8-27B-Abliterated-MLX-BF16", loaded: false },
                { id: "gemma-4-31b-it-bf16", loaded: true },
                { id: "GLM-5.2-fp8", loaded: true },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes(":8080/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "Qwen3.8-27B-Abliterated-MLX-BF16" },
                { id: "gemma-4-31b-it-bf16" },
                { id: "GLM-5.2-fp8" },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes(":11434/v1/models")) {
          return new Response(JSON.stringify({ data: [{ id: "llama3.2:latest" }, { id: "mistral:latest" }] }), {
            status: 200,
          });
        }
        if (href.includes(":11434/api/ps")) {
          return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 });
        }
        if (href.includes(":1234/v1/models")) {
          return new Response(JSON.stringify({ data: [{ id: "qwen" }, { id: "other" }] }), { status: 200 });
        }
        if (href.includes(":1234/api/v0/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "qwen", state: "loaded" }, { id: "other", state: "not-loaded" }] }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options.find((o) => o.id === "omlx::gemma-4-31b-it-bf16")?.loaded).toBe(true);
    expect(catalog.options.find((o) => o.id === "omlx::GLM-5.2-fp8")?.loaded).toBe(true);
    expect(catalog.options.find((o) => o.id === "omlx::Qwen3.8-27B-Abliterated-MLX-BF16")?.loaded).toBeUndefined();
    expect(catalog.options.find((o) => o.id === "ollama::llama3.2:latest")?.loaded).toBe(true);
    expect(catalog.options.find((o) => o.id === "ollama::mistral:latest")?.loaded).toBeUndefined();
    expect(catalog.options.find((o) => o.id === "lmstudio::qwen")?.loaded).toBe(true);
    expect(catalog.options.find((o) => o.id === "lmstudio::other")?.loaded).toBeUndefined();
  });
});

describe("Qwen / Hermes ACP turns", () => {
  it("Qwen argv is --acp -m <api-id>, never the encoded picker id", async () => {
    const home = scratchHome("omb-qwen-turn-");
    const dump = join(home, "env.json");
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen",
      displayName: "Qwen",
      environment: { HOME: home, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-qwen", text: "hi", model: "omlx::gemma-4-31b-it-bf16" });
      await recorder.until((e) => e.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
      expect(seen.argv).toEqual(["--acp", "-m", "gemma-4-31b-it-bf16"]);
    } finally {
      await instance.dispose();
    }
  });

  it("Hermes ACP does not inherit OPENAI_API_KEY and set_model uses custom:omlx:…", async () => {
    const home = scratchHome("omb-hermes-turn-");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "config.yaml"),
      "model:\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n",
    );
    const dump = join(home, "env.json");
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes",
      displayName: "Hermes",
      environment: {
        HOME: home,
        FAKE_ACP_DUMP: dump,
        OPENAI_API_KEY: "8989",
        OPENROUTER_API_KEY: "sk-or-should-not-leak",
      },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-hermes", text: "hi", model: "omlx::gemma-4-31b-it-bf16" });
      await recorder.until((e) => e.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(["acp"]);
      expect(seen.env.OPENAI_API_KEY).toBeUndefined();
      expect(seen.env.OPENROUTER_API_KEY).toBeUndefined();
      const configCalls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{
        method: string;
        params: { modelId?: string };
      }>;
      expect(configCalls).toContainEqual({
        method: "session/set_model",
        params: { sessionId: "fake-acp-session", modelId: "custom:omlx:gemma-4-31b-it-bf16" },
      });
      const yaml = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
      expect(yaml).toContain("provider: auto");
      expect(yaml).toContain("  omlx:");
    } finally {
      await instance.dispose();
    }
  });
});

describe("room turns must pass the picker model", () => {
  it("Qwen without a model never injects — the room used to do this", async () => {
    const home = scratchHome("omb-qwen-noroom-");
    const dump = join(home, "env.json");
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen",
      displayName: "Qwen",
      environment: { HOME: home, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-qwen-bare", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
      expect(seen.argv).toEqual(["--acp"]);
    } finally {
      await instance.dispose();
    }
  });

  it("Hermes without a model never session/set_model — that is the OpenRouter 401", async () => {
    const home = scratchHome("omb-hermes-noroom-");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const dump = join(home, "env.json");
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes",
      displayName: "Hermes",
      environment: { HOME: home, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-hermes-bare", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      let configCalls: Array<{ method: string }> = [];
      try {
        configCalls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string }>;
      } catch {
        // no session/set_model → the dump file is never written
      }
      expect(configCalls.some((call) => call.method === "session/set_model")).toBe(false);
    } finally {
      await instance.dispose();
    }
  });
});

describe("Cloud vs Local catalog access", () => {
  it("Qwen and Hermes advertise access=custom", () => {
    expect(QwenAgentDriver.metadata.access).toBe("custom");
    expect(HermesAgentDriver.metadata.access).toBe("custom");
  });

  it("Kimi and Droid stay Cloud (subscription catalog + Custom)", () => {
    expect(KimiAgentDriver.metadata.access ?? "subscription").toBe("subscription");
    expect(DroidAgentDriver.metadata.access ?? "subscription").toBe("subscription");
  });
});
