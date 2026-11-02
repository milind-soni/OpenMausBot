import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { typedOpenCodeModel, typedOpenCodeModelId } from "../../../shared/opencode-model-id.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import {
  createOpenCodeDriver,
  discoverOpenCodeModels,
  openCodeSpawnFingerprint,
  resetOpenCodeModelCache,
  type OpenCodeCatalogLoader,
} from "./opencode-go.ts";
import { declareTypedOpenCodeModel } from "./opencode-typed-model.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const STALE = "opencode/big-pickle\nvenice/deepseek-v4-flash";
const FRESH = `${STALE}\nvenice/deepseek-v4-1-flash-uncensored`;

const scratches: string[] = [];
const live: Array<{ instance: ProviderInstance; recorder: EventRecorder }> = [];
afterEach(async () => {
  for (const entry of live.splice(0)) {
    entry.recorder.stop();
    await entry.instance.dispose();
  }
  for (const scratch of scratches.splice(0)) await removeTempDir(scratch);
  resetOpenCodeModelCache();
});

function home(cached: string, offered: string) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-refresh-"));
  scratches.push(scratch);
  const cache = join(scratch, "models-cache");
  const upstream = join(scratch, "models-upstream");
  writeFileSync(cache, cached);
  writeFileSync(upstream, offered);
  return {
    scratch, upstream,
    env: {
      ...process.env, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "fixture-key",
      FAKE_ACP_MODELS_FILE: cache, FAKE_ACP_MODELS_REFRESH_FROM: upstream,
    } as Record<string, string | undefined>,
  };
}

const ids = (catalog: ModelCatalog) => catalog.options.map((option) => option.id);

async function start(name: string, environment: Record<string, string | undefined>, loader: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  const instance = await createOpenCodeDriver(loader).create({
    instanceId: name, displayName: "OpenCode", enabled: true,
    config: { cli: FAKE_CLI, fullAuto: false, workspace: environment.HOME },
    environment: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const recorder = recordEvents(instance.adapter);
  live.push({ instance, recorder });
  await instance.startupModelRefresh;
  const run = async (threadId: string, model: string) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello", model });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 20_000);
    return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
  };
  return { instance, run };
}

describe("OpenCode Refresh", () => {
  it("re-reads the provider's models past OpenCode's own models cache", async () => {
    const { env } = home(STALE, FRESH);
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI))).not.toContain("venice/deepseek-v4-1-flash-uncensored");
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI, { refresh: true }))).toContain("venice/deepseek-v4-1-flash-uncensored");
  });

  it("is what the picker's refresh runs, and only it", async () => {
    const asked: Array<boolean | undefined> = [];
    const { env } = home(STALE, STALE);
    const { instance } = await start("opencode-refresh-asks", env, async (_environment, _cli, options) => {
      asked.push(options?.refresh);
      return { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Zen · Big Pickle" }] };
    });
    expect(asked.every((refresh) => refresh === false)).toBe(true);
    await instance.refreshModels?.();
    expect(asked.at(-1)).toBe(true);
  });

  it("starts a fresh OpenCode for the next turn only when the refresh changed the models", async () => {
    const { env, upstream } = home(STALE, STALE);
    await discoverOpenCodeModels(env, FAKE_CLI);
    const before = openCodeSpawnFingerprint(env, FAKE_CLI);
    await discoverOpenCodeModels(env, FAKE_CLI, { refresh: true });
    expect(openCodeSpawnFingerprint(env, FAKE_CLI)).toBe(before);
    writeFileSync(upstream, FRESH);
    await discoverOpenCodeModels(env, FAKE_CLI, { refresh: true });
    expect(openCodeSpawnFingerprint(env, FAKE_CLI)).not.toBe(before);
  });

  it("runs a newly offered model on the turn right after the refresh", async () => {
    const { env, upstream } = home(STALE, STALE);
    const { instance, run } = await start("opencode-refresh-turn", env);
    expect((await run("t-before", "opencode/big-pickle")).done).toMatchObject({ ok: true });
    writeFileSync(upstream, FRESH);
    await instance.refreshModels?.();
    expect(ids(instance.models)).toContain("venice/deepseek-v4-1-flash-uncensored");
    const after = await run("t-after", "venice/deepseek-v4-1-flash-uncensored");
    expect(after.done).toMatchObject({ ok: true });
    expect(after.events.find((event) => event.type === "session.started")).toMatchObject({ model: "venice/deepseek-v4-1-flash-uncensored" });
  });
});

describe("OpenCode model typed by hand", () => {
  const listed: ModelCatalog = { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Zen · Big Pickle" }] };
  const typed = "typed::venice/deepseek-v4-1-flash-uncensored";

  it("is saved apart from listed ids, and only as a provider/model id", () => {
    expect(typedOpenCodeModelId(" venice/deepseek-v4-1-flash-uncensored ")).toBe(typed);
    expect(typedOpenCodeModel(typed)).toBe("venice/deepseek-v4-1-flash-uncensored");
    expect(typedOpenCodeModelId("openrouter/meta-llama/llama-3.3-70b:free")).toBe("typed::openrouter/meta-llama/llama-3.3-70b:free");
    for (const bad of ["deepseek", "/model", "venice/", "venice/a b", "ven ice/model", "venice/x\u0000", `venice/${"x".repeat(201)}`, "typed::venice/x"]) {
      expect(typedOpenCodeModelId(bad)).toBeNull();
    }
    for (const other of ["venice/deepseek-v4-1-flash-uncensored", "omlx::qwen", "typed::venice/a b", undefined]) expect(typedOpenCodeModel(other)).toBeNull();
  });

  it("is declared to OpenCode beside the person's own config, and no other id is", () => {
    const env: Record<string, string | undefined> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark", provider: { venice: { options: { timeout: 1 }, models: { mine: { name: "Mine" } } } } }),
    };
    expect(declareTypedOpenCodeModel(env, typed)).toBe("venice/deepseek-v4-1-flash-uncensored");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      theme: "dark",
      provider: { venice: { options: { timeout: 1 }, models: { "deepseek-v4-1-flash-uncensored": {}, mine: { name: "Mine" } } } },
    });
    for (const model of ["venice/deepseek-v4-1-flash-uncensored", "opencode/big-pickle", "not a model"]) {
      const untouched: Record<string, string | undefined> = {};
      expect(declareTypedOpenCodeModel(untouched, model)).toBeUndefined();
      expect(untouched).toEqual({});
    }
  });

  it("runs on OpenCode instead of being swapped for the default", async () => {
    const { env } = home("opencode/big-pickle", "opencode/big-pickle");
    const { run } = await start("opencode-typed", env, async () => listed);
    const turn = await run("t-typed", typed);
    expect(turn.done).toMatchObject({ ok: true });
    expect(turn.events.find((event) => event.type === "session.started")).toMatchObject({ model: "venice/deepseek-v4-1-flash-uncensored" });
    expect(turn.events.some((event) => event.type === "runtime.notice")).toBe(false);
  });
});
