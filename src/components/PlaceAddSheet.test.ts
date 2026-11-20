// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { suggestedLocalName } from "@/lib/places";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: () => null }));
const { NewLocalFromMenu, RailSheet } = await import("./PlaceAddSheet");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null, ask: (() => void) | null = null;
const create = vi.fn(async (_name: string, _color: unknown) => ({ outcome: "made" as const, id: "work" }));
beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  Object.assign(window, { ogb: { workspaces: { places: vi.fn(async () => ({ places: [], add: { cloud: false, link: false, address: false } })), onChanged: () => () => {},
    local: { create, edit: vi.fn(), remove: vi.fn() }, onNewLocal: (callback: () => void) => { ask = callback; return () => { ask = null; }; } } } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

it("a new workspace's first names: Work, Personal, then Workspace 2, 3 and on, whichever no place has", () => {
  expect(suggestedLocalName([])).toBe("Work");
  expect(suggestedLocalName(["work"])).toBe("Personal");
  expect(suggestedLocalName(["Work", "Personal", "Workspace 2"])).toBe("Workspace 3");
});

it("the Server menu's New workspace on this computer opens the same step on this computer's own page, where no rail stands yet", async () => {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(NewLocalFromMenu)); });
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
  await act(async () => { ask!(); });
  const form = document.querySelector('[data-place-add="local"]')!;
  expect(form.querySelector<HTMLInputElement>("[data-local-name]")!.value).toBe("Work");
  await act(async () => { (form as HTMLFormElement).requestSubmit(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
  expect(create.mock.calls).toEqual([["Work", "blue"]]);
  expect(document.querySelector("[data-place-add-sheet]"), "made: main opens it, and the rail appears with two places").toBeNull();
  await act(async () => { ask!(); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector("[data-place-add-sheet]"), "Escape: no dead end").toBeNull();
});

it("a parent re-render with a new onClose keeps focus inside the sheet instead of handing it back to the opener", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const sheet = (onClose: () => void) => createElement(RailSheet, { focusKey: "server", onClose, children: [createElement("button", { key: "a" }, "A"), createElement("button", { key: "b", "data-second": "" }, "B")] });
  root = createRoot(host);
  await act(async () => { root!.render(sheet(() => {})); });
  const second = document.querySelector<HTMLButtonElement>("[data-second]")!;
  second.focus();
  await act(async () => { root!.render(sheet(() => {})); });
  expect(document.activeElement).toBe(second);
  await act(async () => { root!.render(createElement("div")); });
  expect(document.activeElement, "closing still returns focus to the opener").toBe(opener);
});
