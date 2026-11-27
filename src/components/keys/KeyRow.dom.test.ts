// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const fx = vi.hoisted(() => ({ refreshInstances: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const instances = [{ instanceId: "deepseek", driverKind: "deepseekAgent", displayName: "DeepSeek Harness", snapshot: { state: "unavailable" },
    install: { platform: "linux", command: { linux: "npm install -g @deepseek-ai/dsh" } }, models: { default: "m", options: [] } }] as unknown as InstanceInfo[];
  return {
    ...actual,
    useStore: () => ({ state: { ...actual.initialState, config: { deepseek: { configured: true, last4: "9z9z" } }, instances }, dispatch: vi.fn(), refreshInstances: fx.refreshInstances }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { KeyRow } = await import("./KeyRow");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  fx.refreshInstances.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(KeyRow, { id: "deepseek" })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const checkAgain = () => host.querySelector<HTMLButtonElement>("[data-key-engine-check]")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("says when Check again could not reach the server, and clears that on the next try", async () => {
  fx.refreshInstances.mockRejectedValueOnce(new Error("fixture offline"));
  flushSync(() => checkAgain().click());
  expect(fx.refreshInstances).toHaveBeenCalledWith({ reportErrors: true });
  await settle();
  expect(host.querySelector("[data-key-engine-missing] [role=alert]")?.textContent).toContain("fixture offline");
  expect(checkAgain().disabled).toBe(false);

  fx.refreshInstances.mockResolvedValueOnce(undefined);
  flushSync(() => checkAgain().click());
  await settle();
  expect(host.querySelector("[data-key-engine-missing] [role=alert]")).toBeNull();
});
