// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavedKeysReset } from "./SavedKeysReset";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let answer: () => void;
const reset = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));

beforeEach(() => {
  reset.mockClear();
  (window as unknown as { ogb: unknown }).ogb = { credentialStore: { unreadable: async () => true, reset } };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
});

const show = async (notice?: boolean) => {
  await act(async () => { root.render(createElement(SavedKeysReset, notice ? { notice } : {})); });
  return host.querySelector("button") as HTMLButtonElement;
};

describe("Reset saved keys", () => {
  it("asks the desktop once, however often it is clicked while the question is open", async () => {
    const button = await show();
    await act(async () => { button.click(); button.click(); });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => { answer(); });
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("comes with its own warning line when there is no other notice to sit in", async () => {
    const button = await show(true);
    expect(button).not.toBeNull();
    expect(host.querySelector(".bg-warning\\/10")?.textContent).toContain("couldn't be read");
  });
});
