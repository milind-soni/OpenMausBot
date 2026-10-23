import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { modelArrangement } from "./model-arrangement";

const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: "sample", driverKind: "openai-compat", displayName: "Lab endpoint", access: "api",
  snapshot: { state: "available" }, models: { default: "qwen", options: [{ id: "qwen", label: "Qwen" }] },
  ...overrides,
});

describe("model arrangement", () => {
  it("keeps the agent separate from the model and endpoint for a direct local server", () => {
    const arrangement = modelArrangement(instance({ url: "http://127.0.0.1:8118/v1" }), { instanceId: "sample", model: "qwen" });
    expect(arrangement).toMatchObject({ agent: "OpenMausBot", model: "Qwen", route: "http://127.0.0.1:8118/v1", location: "local", direct: true });
  });

  it("identifies a direct model reached through a verified official hosted API", () => {
    expect(modelArrangement(instance({ url: "https://api.openai.com/v1" }), { instanceId: "sample", model: "qwen" }))
      .toMatchObject({ agent: "OpenMausBot", route: "https://api.openai.com/v1", location: "hosted" });
  });

  it("does not treat a connected runtime's local model as a direct connection", () => {
    const arrangement = modelArrangement(instance({ driverKind: "opencodeGo", displayName: "OpenCode", access: "custom",
      models: { default: "splash/qwen", options: [{ id: "splash/qwen", label: "Qwen", provider: "Splash", loaded: true }] } }),
    { instanceId: "sample", model: "splash/qwen" });
    expect(arrangement).toMatchObject({ agent: "OpenCode", model: "Qwen", route: "Splash", location: "local", direct: false });
  });

  it("does not misclassify Claude Code with an API key as a direct API agent", () => {
    expect(modelArrangement(instance({ driverKind: "claudeAgent", displayName: "Claude (API key)" }),
      { instanceId: "sample", model: "qwen" })).toMatchObject({ agent: "Claude Code", direct: false });
  });

  it("does not pass off an agent default as a discovered model", () => {
    const arrangement = modelArrangement(instance({ driverKind: "customAcp", models: { default: "agent-default", options: [{ id: "agent-default", label: "Agent default" }] } }),
      { instanceId: "sample", model: "agent-default" });
    expect(arrangement.model).toBeNull();
    expect(arrangement.modelControlledBy).toContain("agent");
    expect(arrangement.route).toBeNull();
  });

  it("does not infer local inference from a custom model or a remote endpoint URL", () => {
    const custom = instance({ models: { default: "qwen", options: [{ id: "qwen", label: "Qwen", custom: true }] } });
    expect(modelArrangement(custom, { instanceId: "sample", model: "qwen" }).location).toBe("unknown");
    expect(modelArrangement({ ...custom, url: "https://example.com/v1" }, { instanceId: "sample", model: "qwen" }).location).toBe("unknown");
    expect(modelArrangement(instance({ driverKind: "groq", access: "api" }), { instanceId: "sample", model: "qwen" }).location).toBe("unknown");
  });
});
