// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Layer, useIsTopLayer } from "./Layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const tops = new Map<string, () => boolean>();
function Probe({ name }: { name: string }) {
  tops.set(name, useIsTopLayer());
  return createElement("p", { "data-probe": name });
}
const layer = (modal: boolean, name: string, ...inner: ReactNode[]) => createElement(Layer, { modal, key: name, children: [createElement(Probe, { name, key: "probe" }), ...inner] });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };

beforeEach(() => {
  tops.clear();
  host = document.createElement("div");
  host.style.transform = "translateX(0)";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("mounts its content on body, outside the transformed ancestor that would trap position: fixed", async () => {
  await render(layer(false, "menu"));
  const probe = document.querySelector('[data-probe="menu"]')!;
  expect(host.contains(probe)).toBe(false);
  expect(probe.parentElement).toBe(document.body);
});

it("only the newest open modal is on top; closing it hands the keyboard back", async () => {
  await render(createElement("div", null, layer(true, "settings", layer(true, "sheet", layer(false, "menu-in-sheet")))));
  expect([tops.get("settings")!(), tops.get("sheet")!(), tops.get("menu-in-sheet")!()]).toEqual([false, true, true]);
  await render(createElement("div", null, layer(true, "settings")));
  expect(tops.get("settings")!()).toBe(true);
});

it("a modal opened later from elsewhere in the tree is above one that stays open", async () => {
  await render(createElement("div", null, layer(true, "settings")));
  await render(createElement("div", null, layer(true, "settings"), layer(true, "confirm")));
  expect([tops.get("settings")!(), tops.get("confirm")!()]).toEqual([false, true]);
});

it("outside every modal a component is always on top", async () => {
  await render(createElement(Probe, { name: "page" }));
  expect(tops.get("page")!()).toBe(true);
});

it("renders in place on the server, where React cannot portal", () => {
  expect(renderToStaticMarkup(layer(true, "dialog"))).toBe('<p data-probe="dialog"></p>');
});
