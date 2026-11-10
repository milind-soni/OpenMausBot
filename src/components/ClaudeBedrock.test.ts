import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as store from "@/state/store";
import { ClaudeBedrockEndpoints } from "./ClaudeBedrock";

const bedrock = (extra: Record<string, unknown> = {}) => ({
  instanceId: "claude-bedrock-fixture",
  driverKind: "claudeAgent",
  displayName: "Claude on Bedrock",
  access: "custom",
  snapshot: { state: "available" },
  models: { default: "", options: [] },
  claudeBedrock: {
    awsProfile: "theiconic-claude-primary",
    awsRegion: "us-east-1",
    model: "global.anthropic.claude-sonnet-5-5", models: ["global.anthropic.claude-sonnet-5-5"],
    opusModel: "au.anthropic.claude-opus-5-5", sonnetModel: "", haikuModel: "", smallFastModel: "",
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
  return renderToStaticMarkup(createElement(ClaudeBedrockEndpoints));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Claude on Amazon Bedrock settings", () => {
  it("offers the section with nothing configured yet", () => {
    const html = render([]);
    expect(html).toContain("Amazon Bedrock");
    expect(html).toContain("No Amazon Bedrock engines yet.");
    expect(html).toContain("Add Amazon Bedrock");
  });

  it("lists each engine's profile and region, and never a model id outside the form", () => {
    const html = render([bedrock()]);
    expect(html).toContain("Claude on Bedrock");
    expect(html).toContain("Bedrock");
    expect(html).toContain("theiconic-claude-primary");
    expect(html).toContain("us-east-1");
    expect(html).toContain("Edit");
    expect(html).toContain("Remove Claude on Bedrock");
    expect(html).not.toContain("au.anthropic.claude-opus-5-5");
  });

  it("counts a bot that keeps the engine as a fallback", () => {
    const bot = { id: "bot-2", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      fallback: [{ instanceId: "claude-bedrock-fixture", model: "global.anthropic.claude-sonnet-5-5" }] };
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [bedrock()], bots: [bot] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    } as unknown as ReturnType<typeof store.useStore>);
    const html = renderToStaticMarkup(createElement(ClaudeBedrockEndpoints));
    expect(html).toContain("1 bot(s) use this account");
  });

  it("waits for bots to move off the engine before offering its removal", () => {
    const bot = { id: "bot-1", modelSelection: { instanceId: "claude-bedrock-fixture", model: "global.anthropic.claude-sonnet-5-5" } };
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [bedrock()], bots: [bot] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    } as unknown as ReturnType<typeof store.useStore>);
    const html = renderToStaticMarkup(createElement(ClaudeBedrockEndpoints));
    expect(html).toContain("1 bot(s) use this account");
    expect(html).toContain("disabled");
  });
});
