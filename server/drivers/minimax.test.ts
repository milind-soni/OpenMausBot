import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { decodeMinimaxConfig, loadLocalMiniMaxConfig, MinimaxDriver } from "./minimax.ts";

describe("MinimaxDriver", () => {
  const saved = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    key: process.env.MINIMAX_API_KEY,
    url: process.env.MINIMAX_BASE_URL,
  };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openmausbot-minimax-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
  });

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userProfile;
    if (saved.key === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = saved.url;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers only current official text models", () => {
    expect(MinimaxDriver.models).toEqual({
      default: "MiniMax-M3",
      options: [
        { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
        { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800 },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
      ],
    });
  });

  it("normalizes custom API roots", () => {
    expect(decodeMinimaxConfig({ url: "https://example.test/", apiKeyEnv: "CUSTOM_KEY" }))
      .toEqual({ url: "https://example.test/v1" });
  });

  it("reads the official mmx-cli config and honors its region and model", () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      api_key: " local-key ",
      region: "cn",
      default_text_model: "MiniMax-M2.7-highspeed",
    }));

    expect(loadLocalMiniMaxConfig(home)).toEqual({
      apiKey: "local-key",
      url: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M2.7-highspeed",
    });
  });

  it("skips blank environment credentials and does not probe on snapshot", async () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ api_key: "local-key" }));
    process.env.MINIMAX_API_KEY = "   ";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const instance = await MinimaxDriver.create({
      instanceId: "minimax-test",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "" },
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("streams content and usage with the MiniMax OpenAI contract", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
          "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-turn",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "private prompt" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    const body = JSON.parse(String(request?.body));

    expect(body).toMatchObject({
      model: "MiniMax-M3",
      stream: true,
      reasoning_split: true,
      stream_options: { include_usage: true },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await instance.dispose();
  });

  it("reports a bodyless stream clearly and releases the turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-empty",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ message: "MiniMax returned no response body" });
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });
});
