// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { RenameTitle } from "./RenameTitle";

it("starts editing when a new edit request arrives, never for the one it mounted with, and carries the tooltip it is given", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onEditingChange = vi.fn();
  const draw = (editRequest: number) => act(async () => {
    root.render(createElement(RenameTitle, { value: "Scout", onCommit: vi.fn(), onEditingChange, editRequest, title: "Scout · Researcher" }));
  });
  await draw(3);
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector('[role="button"]')?.getAttribute("title")).toBe("Scout · Researcher");
  await draw(4);
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Scout");
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => root.unmount());
  host.remove();
});

it("stays put when the rename request moves on to another bot, and only the bot asked for opens", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const request = (botId: string, ask: { botId: string; nonce: number } | null) => (ask?.botId === botId ? ask.nonce : 0);
  const draw = (ask: { botId: string; nonce: number } | null) => act(async () => {
    root.render(createElement("div", null,
      createElement(RenameTitle, { key: "a", value: "Atlas", onCommit: vi.fn(), editRequest: request("a", ask) }),
      createElement(RenameTitle, { key: "b", value: "Birch", onCommit: vi.fn(), editRequest: request("b", ask) }),
    ));
  });
  const open = () => [...host.querySelectorAll("input")].map((input) => input.value);
  await draw(null);
  await draw({ botId: "a", nonce: 1 });
  expect(open()).toEqual(["Atlas"]);
  await act(async () => { host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(open()).toEqual([]);
  await draw({ botId: "b", nonce: 2 });
  expect(open()).toEqual(["Birch"]);
  await act(async () => { host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await draw({ botId: "a", nonce: 3 });
  expect(open()).toEqual(["Atlas"]);
  await act(async () => root.unmount());
  host.remove();
});
