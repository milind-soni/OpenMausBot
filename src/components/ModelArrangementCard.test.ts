import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { ModelArrangementCard } from "./ModelArrangementCard";

const connection: InstanceInfo = {
  instanceId: "lab", driverKind: "openai-compat", displayName: "Lab",
  snapshot: { state: "available" }, models: { default: "qwen", options: [{ id: "qwen", label: "Qwen" }] },
};

describe("model arrangement card", () => {
  it("shows the direct agent, selected model, and known local endpoint separately", () => {
    const html = renderToStaticMarkup(createElement(ModelArrangementCard, {
      instance: connection, selection: { instanceId: "lab", model: "qwen" }, endpointUrl: "http://localhost:8118/v1",
    }));
    expect(html).toContain('data-agent-kind="openmausbot"');
    expect(html).toContain('data-inference-location="local"');
    expect(html).toContain('data-model-known="true"');
    expect(html).toContain("Qwen");
    expect(html).toContain("http://localhost:8118/v1");
  });

  it("labels an official API route as hosted without inferring that from its model name", () => {
    const html = renderToStaticMarkup(createElement(ModelArrangementCard, {
      instance: { ...connection, url: "https://api.openai.com/v1" }, selection: { instanceId: "lab", model: "qwen" },
    }));
    expect(html).toContain('data-inference-location="hosted"');
    expect(html).toContain("https://api.openai.com/v1");
  });

  it("shows an unknown model as controlled by the external agent and explains switching", () => {
    const html = renderToStaticMarkup(createElement(ModelArrangementCard, {
      instance: { ...connection, driverKind: "customAcp", models: { default: "agent-default", options: [{ id: "agent-default", label: "Agent default" }] } },
      selection: { instanceId: "lab", model: "agent-default" }, changing: true,
    }));
    expect(html).toContain('data-agent-kind="connected"');
    expect(html).toContain('data-model-known="false"');
    expect(html).not.toContain("Agent default");
    expect(html).toContain('data-model-switch-note="true"');
  });
});
