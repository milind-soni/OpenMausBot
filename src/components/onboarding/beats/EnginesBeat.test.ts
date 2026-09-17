import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", { ogb: { platform: "darwin" } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  return { instances: [] as InstanceInfo[] };
});
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: fixture.instances }, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() }),
}));
const { EnginesBeat } = await import("./EnginesBeat");
afterAll(() => vi.unstubAllGlobals());

function engine(id: string): InstanceInfo {
  return {
    instanceId: id, driverKind: id, displayName: id === "codex" ? "Codex" : "Qwen",
    snapshot: { state: "unavailable" }, cliDefault: id, cliCandidates: [],
    models: { default: "", options: [] },
    install: { server: { package: `fixture-${id}` }, needsNode: true },
  };
}
const render = () => renderToStaticMarkup(createElement(EnginesBeat, { onNext() {}, onSkip() {}, setMascot() {}, bump() {} }));

describe("empty-machine onboarding", () => {
  it("exposes Install Codex immediately without expanding a row", () => {
    fixture.instances = [engine("qwen"), engine("codex")];
    const markup = render();
    expect(markup).toContain("Install Codex on this server");
    expect(markup).not.toContain("Install Qwen on this server");
    expect(markup).toContain("No Node.js, npm, terminal, or administrator access needed");
    expect(markup).toContain("Not installed");
  });
  it("does not push an installation when an engine is already ready", () => {
    fixture.instances = [engine("codex"), { ...engine("qwen"), snapshot: { state: "available", authenticated: true } }];
    expect(render()).not.toContain("Install Codex on this server");
  });
});
