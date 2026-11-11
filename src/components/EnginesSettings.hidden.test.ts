// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ hidden: [] as Array<{ instanceId: string; displayName: string }>, calls: [] as Array<{ path: string; body?: unknown }>, refresh: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/instances/hidden") return { instances: fixture.hidden };
    fixture.hidden = [];
    return { instances: [] };
  },
}));

const { EnginesSettings, HiddenEngines } = await import("./EnginesSettings");

let root: Root;
let host: HTMLElement;
const settle = () => new Promise((done) => setTimeout(done, 0));
beforeEach(() => {
  fixture.calls = [];
  fixture.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("hidden providers in Settings", () => {
  it("shows nothing while no provider is hidden", async () => {
    fixture.hidden = [];
    flushSync(() => root.render(createElement(HiddenEngines)));
    await settle();
    expect(host.querySelector("[data-hidden-engines]")).toBeNull();
  });

  it.each([false, true])("lists hidden providers, folded, and unhides one with a click (simple: %s)", async (simple) => {
    fixture.hidden = [{ instanceId: "hermes", displayName: "Hermes" }, { instanceId: "pi", displayName: "pi" }];
    flushSync(() => root.render(createElement(EnginesSettings, { simple, more: { id: "ai-more", open: false, onToggle: () => {} } })));
    await settle();
    const list = host.querySelector<HTMLDetailsElement>("[data-hidden-engines]")!;
    expect(list).not.toBeNull();
    expect(list.open).toBe(false);
    expect(list.querySelector("summary")!.textContent).toBe("Hidden (2)");
    expect(list.textContent).toContain("Hermes");
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-unhide-engine="hermes"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/hermes", body: { hidden: false } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});
