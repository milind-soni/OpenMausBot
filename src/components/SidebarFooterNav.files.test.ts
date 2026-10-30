// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudFilesState } from "../../electron/cloud-sync.mjs";
import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BotEditorStore, initialState, type AppState, type useStore } from "@/state/store";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced, setAdvancedMode: () => {} }));
import { SidebarFooterNav } from "./SidebarFooterNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const files = (phase: CloudFilesState["phase"]): CloudFilesState =>
  ({ phase, lastSyncedAt: null, disk: null, shared: [], outputs: { enabled: false, dir: "", folders: 0, problem: null } });
let host: HTMLDivElement, root: Root, emit: (state: CloudFilesState) => void;
const dispatch = vi.fn(), off = vi.fn();
function bridge(phase: CloudFilesState["phase"]) {
  window.ogb = { cloudAccount: { files: { state: vi.fn().mockResolvedValue(files(phase)), onState: (callback: typeof emit) => { emit = callback; return off; } } } } as unknown as typeof window.ogb;
}
async function render(density: SidebarDensity = "comfortable", state: Partial<AppState> = {}, rail = false) {
  const store = { state: { ...initialState, ...state }, dispatch } as unknown as ReturnType<typeof useStore>;
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(BotEditorStore, { value: store, children: createElement(SidebarFooterNav, { density, rail }) })));
}
const row = () => host.querySelector<HTMLButtonElement>('[data-sidebar-nav="files"]');

beforeEach(() => {
  setLocale("en");
  mode.advanced = false; dispatch.mockReset(); off.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.ogb; });

it.each(["comfortable", "compact"] as const)("leaves Files out of Simple mode's footer and rail, since the account menu holds it (%s)", async (density) => {
  bridge("idle");
  await render(density);
  expect(row()).toBeNull();
  await render("icons", {}, true);
  expect(row()).toBeNull();
});

it("shows Files in Simple mode's icon column once My Cloud is Ready, and opens it", async () => {
  bridge("idle");
  await render("icons");
  expect(row()!.getAttribute("aria-label")).toBe("Files");
  await act(async () => row()!.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "showFiles" });
});

it("hides Files without a Ready My Cloud, and shows it when main says My Cloud is Ready", async () => {
  mode.advanced = true;
  bridge("unavailable");
  await render();
  expect(row()).toBeNull();
  await act(async () => emit(files("syncing")));
  expect(row()).toBeTruthy();
  await act(async () => emit(files("unavailable")));
  expect(row()).toBeNull();
  delete window.ogb;
  await render();
  expect(row()).toBeNull();
});

it("keeps Files while signed out or offline, so the page can say what to do", async () => {
  mode.advanced = true;
  bridge("signed-out");
  await render();
  expect(row()).toBeTruthy();
  await act(async () => emit(files("offline")));
  expect(row()).toBeTruthy();
});

it("in Advanced mode, Files is a row under Tools after Team map, highlighted while open", async () => {
  mode.advanced = true;
  bridge("idle");
  await render("comfortable", { activeView: "files" });
  const html = host.innerHTML;
  expect(html.indexOf('data-sidebar-nav="team-map"')).toBeLessThan(html.indexOf('data-sidebar-nav="files"'));
  expect(row()!.getAttribute("aria-current")).toBe("page");
  act(() => root.unmount());
  expect(off).toHaveBeenCalledOnce();
});
