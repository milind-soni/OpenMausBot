// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./LendingActivity", () => ({ LendingActivityList: () => null }));
const { ComputerSharingSettings } = await import("./ComputerSharingSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const home = { id: "11111111-1111-4111-8111-111111111111", name: "me", path: "/home/me", write: false, home: true };
const plans = { id: "22222222-2222-4222-8222-222222222222", name: "Plans", path: "/home/me/Plans", write: true };

async function mount(folders: DesktopSharedFolder[]) {
  const state = { enabled: true, connected: true, paused: false, folders, terminal: false, computer: false };
  Object.assign(window, { ogb: { computerSharing: { state: vi.fn(async () => state), activity: vi.fn(async () => []), chooseFolder: vi.fn(), save: vi.fn(), revoke: vi.fn() } } });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ComputerSharingSettings, { workspace: { id: "vps", name: "vps-1", origin: "https://vps.example" }, own: true, onClose: () => {} })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const row = (path: string) => [...host.querySelectorAll("fieldset > div")].find(node => node.querySelector("p.break-all")?.textContent === path)!;
const editBox = (path: string) => row(path).querySelector<HTMLInputElement>("input[type=checkbox]")!;

beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

it("the whole home folder can't be set to allow edits, and its row says why and what to do instead", async () => {
  await mount([home, plans]);
  expect(row("/home/me").textContent).toContain("Your whole home folder is always shared read only here. To allow edits, choose a folder inside it.");
  expect(editBox("/home/me").disabled).toBe(true);
  expect(editBox("/home/me").checked).toBe(false);
  expect(row("/home/me/Plans").textContent).not.toContain("Your whole home folder");
  expect(editBox("/home/me/Plans").disabled).toBe(false);
  expect(editBox("/home/me/Plans").checked).toBe(true);
});
