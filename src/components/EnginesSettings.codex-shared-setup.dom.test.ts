// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> } }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: () => {}, refreshInstances: async () => {}, refreshModels: async () => {} }),
  api: async () => ({}),
}));
import { EnginesSettings } from "./EnginesSettings";

function codex(): InstanceInfo {
  return {
    instanceId: "codex", driverKind: "codex", displayName: "Codex", cliDefault: "codex",
    snapshot: { state: "available", authenticated: true, chatgptPlan: true }, models: { default: "gpt", options: [] },
  } as InstanceInfo;
}
function claude(): InstanceInfo {
  return {
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", cliDefault: "claude",
    snapshot: { state: "available", authenticated: true }, models: { default: "claude", options: [] },
  } as InstanceInfo;
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = async (instances: InstanceInfo[]) => {
  fixture.state = { instances, bots: [], config: {} };
  await act(async () => { root.render(createElement(EnginesSettings)); });
};

describe("Settings → Codex accounts", () => {
  it("says bots follow the person's own Codex setup", async () => {
    await render([codex()]);
    const notes = container.querySelectorAll("[data-accounts='chatgpt'] ~ [data-codex-shared-setup]");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain("your own Codex setup");
    expect(notes[0]!.textContent).toContain("AGENTS.md");
  });

  it("keeps the note off other engines' account cards", async () => {
    await render([claude()]);
    expect(container.querySelector("[data-codex-shared-setup]")).toBeNull();
  });
});
