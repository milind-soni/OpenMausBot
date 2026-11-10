// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  mode: "local" as string,
  available: true,
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: { features: { trainingData: fixture.mode } } }, dispatch: fixture.dispatch }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (path === "/api/config") return { features: { trainingData: "share" } };
    return { mode: fixture.mode, steps: 12, turns: 4, bytes: 3 * 1024 * 1024, available: fixture.available,
      upload: { shareSince: null, sentTurns: 0, refusedTurns: 0, lastSentAt: null, lastError: null } };
  },
}));
import { TrainingDataRow } from "./TrainingDataRow";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.calls = [];
  fixture.mode = "local";
  fixture.available = true;
  fixture.dispatch.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const click = async (selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).toBeTruthy();
  await act(async () => button!.click());
};

it("shows what is kept, and shares only after the person reads what goes and confirms", async () => {
  await act(async () => root.render(createElement(TrainingDataRow)));
  expect(container.querySelector("[data-training-summary]")!.textContent).toBe("4 turns (12 steps, 3.0 MB) kept on this computer.");
  expect(container.querySelector('[data-training-mode="local"]')!.getAttribute("aria-checked")).toBe("true");

  await click('[data-training-mode="share"]');
  expect(fixture.calls.filter((call) => call.path === "/api/config")).toEqual([]);
  expect(container.querySelector("[data-training-share-confirm]")!.textContent).toContain("Never sent");

  await click("[data-training-share-yes]");
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/config", method: "PATCH", body: { features: { trainingData: "share" } } });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { trainingData: "share" } } });
});

it("deletes everything only on the second press", async () => {
  await act(async () => root.render(createElement(TrainingDataRow)));
  await click("[data-training-delete]");
  expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
  await click("[data-training-delete-yes]");
  expect(fixture.calls.some((call) => call.path === "/api/training-data" && call.method === "DELETE")).toBe(true);
});

it("is not offered where nothing may be recorded", async () => {
  fixture.available = false;
  await act(async () => root.render(createElement(TrainingDataRow)));
  expect(container.querySelector("[data-training-data]")).toBeNull();
});
