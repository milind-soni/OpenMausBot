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
