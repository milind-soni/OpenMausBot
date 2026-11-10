// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ team: true, on: true, calls: [] as { path: string; init?: { method?: string; body?: string } }[] }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: fixture.team ? { team: { id: "t1", name: "Acme" } } : {} } }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, ...(init ? { init } : {}) });
    if (init?.method === "PUT") fixture.on = (JSON.parse(init.body!) as { on: boolean }).on;
    return { on: fixture.on };
  },
}));
const { AwayEmailsSetting } = await import("./AwayEmailsSetting");

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.team = true; fixture.on = true; fixture.calls = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows the person's own switch on a team, on by default, and turns it off with one click", async () => {
  await act(async () => { root.render(createElement(AwayEmailsSetting, { row: true })); });
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(container.textContent).toContain("Email me when I'm away");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => { toggle.click(); });
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/me/away-emails", init: expect.objectContaining({ method: "PUT", body: JSON.stringify({ on: false }) }) });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("shows nothing and asks nothing off a team", async () => {
  fixture.team = false;
  await act(async () => { root.render(createElement(AwayEmailsSetting, { row: true })); });
  expect(container.innerHTML).toBe("");
  expect(fixture.calls).toEqual([]);
});
