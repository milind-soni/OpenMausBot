// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as Partial<ConfigStatus> | null, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const { EveryBotRules } = await import("./EveryBotRules");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (_path: string, init: RequestInit) => ({ everyBotRules: JSON.parse(String(init.body)).everyBotRules }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows nothing to someone the server does not send the rules to", async () => {
  fixture.config = { profile: { name: "Ada", email: "" } };
  await act(async () => root.render(createElement(EveryBotRules)));
  expect(host.querySelector("textarea")).toBeNull();
});

it("saves the rules like About me, to the server's config", async () => {
  fixture.config = { profile: { name: "Ada", email: "" }, everyBotRules: "Be brief." };
  await act(async () => root.render(createElement(EveryBotRules)));
  const area = host.querySelector("textarea")!;
  expect(area.value).toBe("Be brief.");
  expect(host.querySelector("label")?.textContent).toBe("Rules for every bot");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Answer in British English.");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: JSON.stringify({ everyBotRules: "Answer in British English." }) }));
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { everyBotRules: "Answer in British English." } });
  expect(host.querySelector("[role=status]")?.textContent).toBe("Saved");
});
