import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  type OpenCodeRefreshSchedule,
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

async function start(
  name: string,
  environment: Record<string, string | undefined>,
  loader: OpenCodeCatalogLoader = discoverOpenCodeModels,
  schedule: OpenCodeRefreshSchedule = {},
) {
  const instance = await createOpenCodeDriver(loader, schedule).create({
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

  it("is what the picker's refresh runs; a start within hours of the last one reads OpenCode's cache", async () => {
    const asked: Array<boolean | undefined> = [];
    const { env } = home(STALE, STALE);
    const { instance } = await start("opencode-refresh-asks", env, async (_environment, _cli, options) => {
      asked.push(options?.refresh);
      return { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Zen · Big Pickle" }] };
    }, { now: () => 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked.every((refresh) => refresh === false)).toBe(true);
    await instance.refreshModels?.();
    expect(asked.at(-1)).toBe(true);
  });

  it("reads the models past every cache on its own at start and once they are hours old", async () => {
    let clock = 10_000;
    const asked: Array<boolean | undefined> = [];
    const { env } = home(STALE, STALE);
    await start("opencode-refresh-schedule", env, async (_environment, _cli, options) => {
      asked.push(options?.refresh);
      return { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Zen · Big Pickle" }] };
    }, { now: () => clock, everyMs: 1_000, checkMs: 20 });
    const refreshes = () => asked.filter(Boolean).length;
    await expect.poll(refreshes).toBe(1);
    clock += 500;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshes()).toBe(1);
    clock += 1_000;
    await expect.poll(refreshes).toBe(2);
  });

  it("leaves OpenCode 1's catalog lock free, so a refresh right after a read gets past it", async () => {
    const { env, scratch } = home(STALE, FRESH);
    env.FAKE_ACP_MODELS_LOCK = join(scratch, "models.lock");
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI))).not.toContain("venice/deepseek-v4-1-flash-uncensored");
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI, { refresh: true, settleMs: 0 }))).toContain("venice/deepseek-v4-1-flash-uncensored");
  });

  it("picks up the catalog OpenCode 2 refreshes itself, as it has no `models --refresh`", async () => {
    const { env } = home(STALE, FRESH);
    env.FAKE_ACP_MODELS_LIST = "v2";
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI))).not.toContain("venice/deepseek-v4-1-flash-uncensored");
    const rpc = join(env.HOME!, "rpc.jsonl");
    env.FAKE_ACP_RPC_APPEND_FILE = rpc;
    env.FAKE_ACP_SESSION_DELETE = "1";
    expect(ids(await discoverOpenCodeModels(env, FAKE_CLI, { refresh: true, settleMs: 1_500 }))).toContain("venice/deepseek-v4-1-flash-uncensored");
    const calls = readFileSync(rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; sessionId?: string });
    expect(calls.filter((call) => call.method === "session/delete").map((call) => call.sessionId).sort())
      .toEqual(["fake-acp-session", "fake-acp-session-2"]);
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
    const { instance, run } = await start("opencode-refresh-turn", env, discoverOpenCodeModels, { now: () => 0 });
    expect((await run("t-before", "opencode/big-pickle")).done).toMatchObject({ ok: true });
    writeFileSync(upstream, FRESH);
    await instance.refreshModels?.();
    expect(ids(instance.models)).toContain("venice/deepseek-v4-1-flash-uncensored");
    const after = await run("t-after", "venice/deepseek-v4-1-flash-uncensored");
    expect(after.done).toMatchObject({ ok: true });
    expect(after.events.find((event) => event.type === "session.started")).toMatchObject({ model: "venice/deepseek-v4-1-flash-uncensored" });
  });
});

describe("OpenCode provider's own model list", () => {
  const listing = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const venice = {
    data: [
      { id: "deepseek-v9-flash", model_spec: { capabilities: { supportsE2EE: false } } },
      { id: "e2ee-deepseek-v9-flash", model_spec: { capabilities: { supportsE2EE: true } } },
      { id: "bad id" },
    ],
  };

  it("offers a model the provider lists before OpenCode's catalog has it, runs it, and keeps it when the list fails", async () => {
    const { env } = home(STALE, STALE);
    env.VENICE_API_KEY = "venice-fixture-key";
    const asked: Array<{ url: string; authorization: string | null }> = [];
    let answer = listing(venice);
    const { instance, run } = await start("opencode-live", env, discoverOpenCodeModels, {
      now: () => 0,
      fetch: (async (url: string, init?: RequestInit) => {
        asked.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return answer();
      }) as typeof fetch,
    });
    expect(asked[0]).toEqual({ url: "https://api.venice.ai/api/v1/models?type=text", authorization: "Bearer venice-fixture-key" });
    expect(ids(instance.models)).toContain("venice/deepseek-v9-flash");
    expect(ids(instance.models)).not.toContain("venice/e2ee-deepseek-v9-flash");
    const turn = await run("t-live", "venice/deepseek-v9-flash");
    expect(turn.done).toMatchObject({ ok: true });
    expect(turn.events.find((event) => event.type === "session.started")).toMatchObject({ model: "venice/deepseek-v9-flash" });
    answer = listing({ error: "down" }, 503);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await instance.refreshModels?.();
      expect(ids(instance.models)).toContain("venice/deepseek-v9-flash");
    }
  });

  it("asks no provider whose key OpenCode was not given", async () => {
    const { env } = home(STALE, STALE);
    delete env.VENICE_API_KEY;
    let asked = 0;
    const { instance } = await start("opencode-live-none", env, discoverOpenCodeModels, {
      fetch: (async () => { asked += 1; return new Response("{}"); }) as typeof fetch,
    });
    expect(asked).toBe(0);
    expect(ids(instance.models)).toEqual(["opencode/big-pickle", "venice/deepseek-v4-flash"]);
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
