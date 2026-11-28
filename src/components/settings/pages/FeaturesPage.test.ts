// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: {
    config: { features: {}, threadTitles: { model: null as { instanceId: string; model: string } | null, followUp: false, instances: ["claude"] } },
    instances: [{ instanceId: "claude", displayName: "Claude", snapshot: { state: "available", authenticated: true },
      models: { options: [{ id: "sonnet", label: "Sonnet" }] } }],
  },
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: fixture.api }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => fixture.dispatch, useStoreSelector: (select: (state: typeof fixture.state) => unknown) => select(fixture.state) }));
const { FeaturesPage } = await import("./FeaturesPage");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.api.mockReset(); fixture.dispatch.mockReset();
  fixture.state.config.threadTitles = { model: null, followUp: false, instances: ["claude"] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("saves the chosen title model and the follow-up switch independently", async () => {
  fixture.api.mockResolvedValue(fixture.state.config);
  await act(async () => root.render(createElement(FeaturesPage)));
  const select = host.querySelector("select")!;
  expect([...select.options].map((option) => option.textContent)).toEqual(expect.arrayContaining(["Automatic", "Claude · Sonnet"]));
  await act(async () => { select.value = JSON.stringify(["claude", "sonnet"]); select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(fixture.api).toHaveBeenLastCalledWith("/api/config", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ threadTitles: { model: { instanceId: "claude", model: "sonnet" } } }) }));
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  expect(fixture.api).toHaveBeenLastCalledWith("/api/config", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ threadTitles: { followUp: true } }) }));
});

it("reports a failed setting change", async () => {
  fixture.api.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(createElement(FeaturesPage)));
  await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
});
