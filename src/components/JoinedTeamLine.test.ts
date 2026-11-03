// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(async () => ({ config: true })), config: {} as Record<string, unknown>, brand: "default" }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: f.config, instances: [] }, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/lib/brand", async (original) => ({ ...await original<typeof import("@/lib/brand")>(), brandStatus: () => ({ source: f.brand }) }));
vi.mock("@/lib/notify", () => ({ setNotificationPlace: () => {} }));
vi.mock("@/components/onboarding/ConnectAi", () => ({ ConnectAiDialog: () => null }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => false }));
const { HomeLine } = await import("./HomeLine");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let account: CloudAccountState, changed: ((state: CloudAccountState) => void) | null;
const signedOut: CloudAccountState = { status: "signed-out" };
const joined = () => host.querySelector<HTMLElement>("[data-home-line='joined-team']");
const signIn = () => host.querySelector<HTMLButtonElement>("[data-joined-team-sign-in]");
const flush = async () => { for (let round = 0; round < 3; round++) await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
async function mount(line: unknown = null, cloudAccount: unknown = { state: async () => account, onState: (callback: typeof changed) => { changed = callback; return () => {}; } }, answers = true) {
  Object.assign(window, { ogb: { workspaces: { state: async () => ({ local: true, name: "This computer" }), line: answers ? async () => line : () => new Promise(() => {}), menu: async () => {} }, ...(cloudAccount ? { cloudAccount } : {}) } });
  root = createRoot(host);
  await act(async () => root!.render(createElement(HomeLine)));
  await flush();
}
beforeEach(() => {
  setLocale("en"); f.dispatch.mockClear(); f.api.mockClear(); f.config = {}; f.brand = "default"; account = signedOut; changed = null;
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

it("signed out, with no other line: says what someone who joined a team needs, and Sign in opens the sign-in itself", async () => {
  await mount();
  expect(joined()!.textContent).toContain("Joined a team? Sign in with the address you were invited with.");
  await act(async () => signIn()!.click());
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "openCloudAdd", source: "app_menu", signIn: true });
});

it("a saved sign-in that was removed is signed out too", async () => {
  account = { status: "signed-out", message: "restore-removed" };
  await mount();
  expect(joined()).toBeTruthy();
});

it("signing in takes it away", async () => {
  await mount();
  expect(joined()).toBeTruthy();
  await act(async () => changed!({ status: "connected", account: { id: "a", email: "p@example.test" } } as CloudAccountState));
  expect(joined()).toBeNull();
});

it.each([
  ["signed in", { status: "connected", account: { id: "a", email: "p@example.test" } }],
  ["a sign-in still being read", { status: "signed-out", message: "restoring" }],
  ["a sign-in that ended, which has its own Sign in again", { status: "reauth-required" }],
])("says nothing for %s", async (_name, state) => {
  account = state as CloudAccountState;
  await mount();
  expect(joined()).toBeNull();
});

it("main's own line comes first, and nothing shows until main has answered", async () => {
  await mount({ kind: "clean" });
  expect(host.querySelector("[data-home-line='clean']")).toBeTruthy();
  expect(joined()).toBeNull();
  await act(async () => root!.unmount()); root = null;
  await mount(null, undefined, false);
  expect(joined()).toBeNull();
});

it("not on a Cloud's or a server's page, which have no sign-in bridge, nor on a branded build", async () => {
  await mount(null, null);
  expect(joined()).toBeNull();
  await act(async () => root!.unmount()); root = null;
  f.brand = "file";
  await mount();
  expect(joined()).toBeNull();
});

it("closed, it stays closed: on this page and in the config every page of this desktop reads", async () => {
  await mount();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-joined-team-close]")!.click());
  expect(joined()).toBeNull();
  expect(f.api).toHaveBeenCalledExactlyOnceWith("/api/config", expect.objectContaining({ method: "PUT" }));
  expect(JSON.parse((f.api.mock.calls as unknown as [[string, { body: string }]])[0][1].body).onboarding.hintsSeen).toContain("joined-team-line");
  await act(async () => root!.unmount()); root = null;
  await mount();
  expect(joined(), "this browser remembers").toBeNull();
  await act(async () => root!.unmount()); root = null;
  localStorage.clear();
  f.config = { onboarding: { hintsSeen: ["joined-team-line"] } };
  await mount();
  expect(joined(), "so does the config").toBeNull();
});
