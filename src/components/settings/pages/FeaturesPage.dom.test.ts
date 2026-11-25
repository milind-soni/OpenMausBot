// @vitest-environment happy-dom
// Settings → Features, which Simple mode lists: the switch for every bot's automatic memory saves to the place's config.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as Partial<ConfigStatus> | null, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: fixture.dispatch }),
  };
});

const { FeaturesPage } = await import("./FeaturesPage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => root.render(createElement(FeaturesPage))); };
const memorySwitch = () => host.querySelector<HTMLButtonElement>("[data-feature-switch=memoryUpkeep]");

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("turns automatic memory off for all bots and keeps the config the server sends back", async () => {
  fixture.config = { features: { skillAuthoring: true, memoryUpkeep: true } };
  const saved = { features: { skillAuthoring: true, memoryUpkeep: false } };
  fixture.api.mockResolvedValue(saved);
  await render();
  expect(host.textContent).toContain("Automatic memory");
  expect(memorySwitch()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => { memorySwitch()!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { memoryUpkeep: false } }) });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
});

it("turns it back on", async () => {
  fixture.config = { features: { skillAuthoring: true, memoryUpkeep: false } };
  fixture.api.mockResolvedValue({ features: { skillAuthoring: true, memoryUpkeep: true } });
  await render();
  expect(memorySwitch()?.getAttribute("aria-checked")).toBe("false");
  await act(async () => { memorySwitch()!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { memoryUpkeep: true } }) });
});

it("leaves the switch out when the server does not know the setting", async () => {
  fixture.config = { features: { skillAuthoring: true } };
  await render();
  expect(memorySwitch()).toBeNull();
});
