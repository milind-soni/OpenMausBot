import { describe, expect, it, vi } from "vitest";
import { SessionModelControls } from "./session-model-controls.ts";

const thought = (value = "low") => ({ id: "thought_level", type: "select", category: "thought_level", currentValue: value,
  options: [{ value: "low", name: "Low" }, { value: "max", name: "Max" }] });
const modern = (model: string) => ({ configOptions: [
  { id: "model", type: "select", currentValue: model, options: [{ value: "one", name: "One" }, { value: "two", name: "Two" }] }, thought(),
] });
const legacy = (model: string) => ({ models: { currentModelId: model, availableModels: [{ modelId: "one", name: "One" }, { modelId: "two", name: "Two" }] }, configOptions: [thought()] });

function fixture(model = "two") {
  let state: any;
  const report = vi.fn();
  const controls = new SessionModelControls({
    selection: { configId: "model", agentDefault: "agent-default", allowLegacy: true }, variants: true,
    displayName: "Custom ACP", model: () => model, reportedModel: () => model,
    state: () => state, store: (value) => { state = value; }, report,
  });
  return { controls, report, state: () => state };
}

describe("ACP session model controls", () => {
  it("keeps a confirmed notification when the modern setter replies with an empty acknowledgement", async () => {
    const { controls } = fixture();
    controls.receive(modern("one"), true);
    const request = vi.fn(async (_method, _params, _timeout, receive) => { controls.receive(modern("two")); receive({}); return {}; });
    await expect(controls.select(request, "s", 100)).resolves.toBe("two");
    expect(request).toHaveBeenCalledWith("session/set_config_option", { sessionId: "s", configId: "model", value: "two" }, 100, expect.any(Function));
    expect(controls.variant("max").options).toHaveLength(2);
  });

  it("rejects a modern acknowledgement that never confirms the requested model", async () => {
    const { controls } = fixture();
    controls.receive(modern("one"), true);
    await expect(controls.select(async () => ({}), "s", 100)).rejects.toThrow("did not switch to two");
  });

  it("accepts a legacy model response with model-specific thought options and preserves the model on thought updates", async () => {
    const { controls, state } = fixture();
    controls.receive(legacy("one"), true);
    await expect(controls.select(async (_method, _params, _timeout, receive) => { const result = legacy("two"); receive?.(result); return result; }, "s", 100)).resolves.toBe("two");
    controls.receive({ configOptions: [thought("max")] });
    expect(controls.modelOf(state())).toBe("two");
    expect(controls.variant("max").currentValue).toBe("max");
  });

  it("accepts a legacy fresh notification followed by an empty acknowledgement", async () => {
    const { controls } = fixture();
    controls.receive(legacy("one"), true);
    const request = vi.fn(async (_method, _params, _timeout, receive) => { controls.receive(legacy("two")); receive({}); return {}; });
    await expect(controls.select(request, "s", 100)).resolves.toBe("two");
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "s", modelId: "two" }, 100, expect.any(Function));
    expect(controls.variant("max").options).toHaveLength(2);
  });

  it("does not carry the previous model's thoughts across an empty legacy setter acknowledgement", async () => {
    const { controls } = fixture();
    controls.receive(legacy("one"), true);
    await expect(controls.select(async (_method, _params, _timeout, receive) => { receive?.({}); return {}; }, "s", 100)).resolves.toBe("two");
    expect(() => controls.variant("max")).toThrow("does not advertise variant");
  });

  it("preserves agent-default without issuing a model setter, including agents with no catalog", async () => {
    const { controls } = fixture("agent-default");
    controls.receive({}, true);
    const request = vi.fn();
    await expect(controls.select(request, "s", 100)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(controls.usesAgentDefault()).toBe(true);
  });

  it.each([modern, legacy])("does not overwrite a newer notification with an earlier model-set response", async (stateFor) => {
    const { controls } = fixture();
    controls.receive(stateFor("one"), true);
    const request = async (_method: string, _params: unknown, _timeout: number, receive?: (result: unknown) => void) => {
      const response = stateFor("two");
      receive?.(response);
      controls.receive(stateFor("one"));
      return response;
    };
    await expect(controls.select(request, "s", 100)).rejects.toThrow("did not switch to two");
  });

  it("clears the previous native session's settings when a new session has none", () => {
    const { controls, state } = fixture();
    controls.receive(modern("two"), true);
    controls.receive({}, true);
    expect(controls.modelOf(state())).toBeNull();
    expect(() => controls.variant("low")).toThrow("does not advertise variant");
  });
});
