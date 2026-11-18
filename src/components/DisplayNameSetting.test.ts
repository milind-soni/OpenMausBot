// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ team: false, signedIn: true, name: "", calls: [] as { path: string; init?: { method?: string; body?: string } }[] }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: fixture.team ? { team: { id: "t1", name: "Acme" } } : {} } }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, ...(init ? { init } : {}) });
    if (!fixture.signedIn) throw new Error("404 not found");
    if (init?.method === "PUT") fixture.name = (JSON.parse(init.body!) as { displayName: string }).displayName.trim();
    return { displayName: fixture.name, shownAs: fixture.name || "Chrome on Mac" };
  },
}));
const { DisplayNameSetting } = await import("./DisplayNameSetting");

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(fixture, { team: false, signedIn: true, name: "", calls: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

it("lets a signed-in person on a self-hosted server choose their name, saved when they leave the field", async () => {
  await act(async () => { root.render(createElement(DisplayNameSetting)); });
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(container.textContent).toContain("Your name on this server");
  expect(input.placeholder).toBe("Chrome on Mac");
  await act(async () => { type(input, "Grace Hopper"); });
  await act(async () => { input.focus(); input.blur(); });
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/me", init: expect.objectContaining({ method: "PUT", body: JSON.stringify({ displayName: "Grace Hopper" }) }) });
  expect(input.value).toBe("Grace Hopper");
});

it("shows nothing on the owner's own computer, and asks nothing on a team", async () => {
  fixture.signedIn = false;
  await act(async () => { root.render(createElement(DisplayNameSetting)); });
  expect(container.innerHTML).toBe("");
  fixture.team = true; fixture.calls = [];
  await act(async () => { root.render(createElement(DisplayNameSetting)); });
  expect(container.innerHTML).toBe("");
  expect(fixture.calls).toEqual([]);
});
