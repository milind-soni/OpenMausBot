import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as store from "@/state/store";
import { ClaudeEndpoints } from "./ClaudeEndpoints";

const endpoint = (extra: Record<string, unknown> = {}) => ({
  instanceId: "claude-endpoint-fixture",
  driverKind: "claudeAgent",
  displayName: "DeepSeek",
  access: "custom",
  snapshot: { state: "available" },
  models: { default: "deepseek-chat", options: [] },
  claudeEndpoint: {
    baseUrl: "https://api.deepseek.test/anthropic",
    models: ["deepseek-chat", "deepseek-reasoner"],
    tokenSaved: true, opusModel: "deepseek-reasoner", sonnetModel: "", haikuModel: "", smallFastModel: "",
  },
  ...extra,
}) as unknown as store.InstanceInfo;

function render(instances: store.InstanceInfo[]) {
  vi.stubGlobal("window", {});
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances, bots: [] },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  } as unknown as ReturnType<typeof store.useStore>);
  return renderToStaticMarkup(createElement(ClaudeEndpoints));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Claude custom endpoints settings", () => {
  it("offers the section with nothing configured yet", () => {
    const html = render([]);
    expect(html).toContain("Custom endpoint");
    expect(html).toContain("Run this account&#x27;s bots on DeepSeek, GLM or another host");
    expect(html).toContain("No custom endpoints yet.");
    expect(html).toContain("Add endpoint");
  });

  it("lists each endpoint's address, and never its token", () => {
    const html = render([endpoint()]);
    expect(html).toContain("DeepSeek");
    expect(html).toContain("https://api.deepseek.test/anthropic");
    expect(html).not.toContain("deepseek-chat");
    expect(html).not.toContain("deepseek-reasoner");
    expect(html).toContain("Edit");
    expect(html).toContain("Remove DeepSeek");
    // The API answer carries only whether a token is saved, so no field holds one.
    expect(html).not.toMatch(/tokenSaved|sk-/u);
  });

  it("counts a bot that keeps the endpoint as a fallback", () => {
    const bot = { id: "bot-2", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      fallback: [{ instanceId: "claude-endpoint-fixture", model: "deepseek-chat" }] };
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [endpoint()], bots: [bot] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    } as unknown as ReturnType<typeof store.useStore>);
    const html = renderToStaticMarkup(createElement(ClaudeEndpoints));
    expect(html).toContain("1 bot(s) use this account");
  });

  it("counts a task that still points at the endpoint", () => {
    const bot = { id: "bot-3", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      tasks: [{ modelSelection: { instanceId: "claude-endpoint-fixture", model: "deepseek-chat" } }] };
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [endpoint()], bots: [bot] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    } as unknown as ReturnType<typeof store.useStore>);
    const html = renderToStaticMarkup(createElement(ClaudeEndpoints));
    expect(html).toContain("1 bot(s) use this account");
  });

  it("waits for bots to move off an endpoint before offering its removal", () => {
    const bot = { id: "bot-1", modelSelection: { instanceId: "claude-endpoint-fixture", model: "deepseek-chat" } };
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [endpoint()], bots: [bot] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    } as unknown as ReturnType<typeof store.useStore>);
    const html = renderToStaticMarkup(createElement(ClaudeEndpoints));
    expect(html).toContain("1 bot(s) use this account");
    expect(html).toContain("disabled");
  });
});