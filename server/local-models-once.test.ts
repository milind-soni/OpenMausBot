import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { ModelSelection } from "../shared/wire.ts";
import { DATA_DIR, instanceConfigs, type AppConfig } from "./config.ts";
import { createOwnThreads } from "./host/own-threads.ts";
import { directLocalModels, localModelsOnce, localServer, type DirectLocalEngine } from "./local-models-once.ts";
import type { MenuEngine } from "./routes/internal-models.ts";
import { Store } from "./store.ts";

const engine = (instanceId: string, driverKind: string, displayName: string, ids: string[]) => ({
  instanceId, driverKind, displayName, models: { default: ids[0] ?? "", options: ids.map((id) => ({ id, label: id })) }, adapter: { capabilities: {} },
});
const claude = engine("claude", "claudeAgent", "Claude", ["claude-sonnet-5", "ollama::gemma4:26b", "ollama::qwen3:8b", "lmstudio::gemma4:26b"]);
const codex = engine("codex", "codex", "Codex", ["gpt-5.5", "ollama::gemma4:26b"]);
const pi = engine("pi", "piAgent", "pi", ["ollama::gemma4:26b"]);
const ids = (engines: ReadonlyArray<ReturnType<typeof engine>>) => Object.fromEntries(engines.map((one) => [one.instanceId, one.models.options.map((option) => option.id)]));
const other = (config: Record<string, unknown>, extra: Partial<DirectLocalEngine> = {}): Record<string, DirectLocalEngine> =>
  ({ openaiCompat: { driver: "openai-compat", config, ...extra } });
/** `offered`: what the Other engine offers a bot now (ready, allowed); null when it is blocked or unavailable. */
const direct = (configs: Record<string, DirectLocalEngine>, offered: string[] | null = []) =>
  directLocalModels(configs, (_id, saved) => offered ? { name: "Other (OpenAI-compatible)", models: [...saved, ...offered] } : null);
const once = (configs: Record<string, DirectLocalEngine>, offered: string[] | null = []) => ids(localModelsOnce([claude, codex, pi], direct(configs, offered)).engines);
const ollama = { url: "http://127.0.0.1:11434/v1", model: "gemma4:26b" };

describe("localModelsOnce", () => {
  it("lists a model the Other engine offers on the same local server only there, and says once where else it runs", () => {
    const result = localModelsOnce([claude, codex, pi], direct(other(ollama)));
    expect(ids(result.engines)).toEqual({
      claude: ["claude-sonnet-5", "ollama::qwen3:8b", "lmstudio::gemma4:26b"],
      codex: ["gpt-5.5"],
      // An engine whose local models are its whole list keeps them.
      pi: ["ollama::gemma4:26b"],
    });
    expect(result.also).toBe("Other (OpenAI-compatible)'s local models also run on Claude, Codex with their own tools: model \"ollama::<model>\"");
  });

  it("counts every model the Other engine offers from that server, however the address and the name are spelled", () => {
    // Ollama's own list, read by the Other engine: every model in it is reached there.
    expect(once(other({ url: "http://localhost:11434" }), ["gemma4:26b", "qwen3:8b"]).claude).toEqual(["claude-sonnet-5", "lmstudio::gemma4:26b"]);
    expect(once(other({ url: "http://[::1]:11434/v1/", model: "gemma4:26b" })).codex).toEqual(["gpt-5.5"]);
    const latest = engine("claude", "claudeAgent", "Claude", ["ollama::llama3"]);
    expect(ids(localModelsOnce([latest], direct(other({ url: "http://127.0.0.1:11434/v1", model: "llama3:latest" }))).engines)).toEqual({ claude: [] });
  });

  it("keeps the copies under Claude and Codex when the Other engine has another model, another server, or is off, hidden or unreadable", () => {
    const all = ids([claude, codex, pi]);
    expect(once(other({ ...ollama, model: "llama3:8b" }))).toEqual(all);
    expect(once(other({ ...ollama, url: "http://127.0.0.1:8080/v1" }))).toEqual(all);
    expect(once(other({ ...ollama, url: "http://192.168.1.20:11434/v1" }))).toEqual(all);
    expect(once(other({ ...ollama, url: "https://openrouter.ai/api/v1" }))).toEqual(all);
    expect(once(other(ollama, { enabled: false }))).toEqual(all);
    expect(once(other(ollama, { hidden: true }))).toEqual(all);
    expect(once(other({ ...ollama, url: 42 }))).toEqual(all);
    expect(once({})).toEqual(all);
    expect(localModelsOnce([claude], direct({})).also).toBeUndefined();
  });

  it("never lets a blocked or unavailable Other engine take a model away", () => {
    const all = ids([claude, codex, pi]);
    // Not ready, refused by the organization, or not offered by this server: the host says it offers nothing.
    expect(once(other(ollama), null)).toEqual(all);
    // Offered, but only another model there (this server allows that one only): the saved model is not hidden.
    const onlyQwen = directLocalModels(other(ollama), () => ({ name: "Other", models: ["qwen3:8b"] }));
    expect(ids(localModelsOnce([codex], onlyQwen).engines)).toEqual({ codex: ["gpt-5.5", "ollama::gemma4:26b"] });
  });

  it("treats LM Studio's own port as its own server", () => {
    expect(once(other({ ...ollama, url: "http://127.0.0.1:1234/v1" })).claude).toEqual(["claude-sonnet-5", "ollama::gemma4:26b", "ollama::qwen3:8b"]);
  });

  it("reads the Other engine's address where Settings saves it, on the engine or as the shared one", () => {
    const shared = instanceConfigs({ openaiCompat: { url: "http://127.0.0.1:11434/v1", model: "gemma4:26b" } } as AppConfig);
    expect(shared.openaiCompat?.driver).toBe("openai-compat");
    expect(ids(localModelsOnce([codex], directLocalModels(shared, (id, saved) => id === "openaiCompat" ? { name: "Other", models: saved } : null)).engines)).toEqual({ codex: ["gpt-5.5"] });
    const own = instanceConfigs({ instances: { openaiCompat: { driver: "openai-compat", config: { url: "http://localhost:11434/v1", model: "gemma4:26b" } } } } as AppConfig);
    expect(ids(localModelsOnce([codex], directLocalModels(own, (_id, saved) => ({ name: "Other", models: saved }))).engines)).toEqual({ codex: ["gpt-5.5"] });
  });
});

describe("list_models with the Other engine on Ollama", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("changes only the bot's list, and still lists the bot's own model and the current one", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot();
    const mine: ModelSelection = { instanceId: "codex", model: "ollama::gemma4:26b" };
    store.patchBot(bot.id, { modelSelection: mine });
    const engines = [claude, codex] as unknown as MenuEngine[];
    const own = createOwnThreads({ store, registry: { instances: () => engines, cliTarget: () => null }, node: () => undefined,
      current: () => undefined, proposalRefusal: () => null, givesWay: () => null, modelName: (one) => one.model, hint: () => ({ why: "", connect: "" }),
      sourceLevel: () => "ask", mayRaise: () => true, localOnce: (listed) => localModelsOnce(listed, direct(other(ollama))) });
    const menu = own.menu(bot.id, bot.threadId, undefined)!;
    expect(menu.engines.find((row) => row.instanceId === "claude")?.models).toEqual(["claude-sonnet-5", "ollama::qwen3:8b", "lmstudio::gemma4:26b"]);
    // The bot's own model leads its engine's list whatever the rule leaves out.
    expect(menu.engines.find((row) => row.instanceId === "codex")?.models).toEqual(["ollama::gemma4:26b", "gpt-5.5"]);
    expect(menu.localAlso).toMatch(/also run on Claude, Codex with their own tools/u);
    // What the picker reads is the registry's own list, untouched.
    expect(engines[0]!.models.options.map((option) => option.id)).toContain("ollama::gemma4:26b");
  });
});

describe("localServer", () => {
  it("is one place for 127.0.0.1, localhost and ::1 on a port, and nothing for another computer", () => {
    expect(localServer("http://127.0.0.1:11434/v1")).toBe(localServer("http://LOCALHOST:11434"));
    expect(localServer("http://[::1]:11434")).toBe(localServer("http://localhost:11434/"));
    expect(localServer("http://127.0.0.1:1234/v1")).not.toBe(localServer("http://127.0.0.1:11434/v1"));
    expect(localServer("http://10.0.0.5:11434/v1")).toBeNull();
    expect(localServer("not a url")).toBeNull();
  });
});
