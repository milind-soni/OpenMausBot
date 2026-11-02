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
vi.mock("@/lib/own-profile", () => ({ saveTeamProfile: (patch: unknown) => fixture.api("/api/me", { method: "PUT", body: JSON.stringify(patch) }) }));

const { AboutMeSettings } = await import("./AboutMeSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => path === "/api/profile/learned" ? { learned: [] } : { aboutMe: "Likes durian" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const type = async (text: string) => {
  const area = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
};

it("saves a Team Cloud person's About me to their own profile, also when Settings opened before the config arrived", async () => {
  fixture.config = null;
  await act(async () => root.render(createElement(AboutMeSettings)));
  fixture.config = { profile: { name: "Ada", email: "ada@acme.test", aboutMe: "" }, team: { id: "t1", name: "Acme" } };
  await act(async () => root.render(createElement(AboutMeSettings)));
  await type("Likes durian");
  const puts = fixture.api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT").map(([path]) => path);
  expect(puts).toEqual(["/api/me"]);
});

it("saves the server's one profile with /api/config off a team", async () => {
  fixture.config = { profile: { name: "Ada", email: "", aboutMe: "" } };
  fixture.api.mockImplementation(async (path: string) => path === "/api/profile/learned" ? { learned: [] } : { profile: { aboutMe: "Likes durian" } });
  await act(async () => root.render(createElement(AboutMeSettings)));
  await type("Likes durian");
  const puts = fixture.api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT").map(([path]) => path);
  expect(puts).toEqual(["/api/config"]);
});
