// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api };
});

import { ComputerNameRow } from "./ComputerNameRow";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ computerName: "Study PC" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function mount() {
  const onSaved = vi.fn();
  flushSync(() => root.render(createElement(ComputerNameRow, { saved: "Office Mac", onSaved })));
  const input = host.querySelector<HTMLInputElement>("#computer-name")!;
  flushSync(() => input.focus());
  return { input, onSaved };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLInputElement, init: KeyboardEventInit = {}) {
  const blur = vi.spyOn(input, "blur");
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })));
  return blur;
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("renaming this computer with an input method", () => {
  it.each(IME)("does not save on the Enter that belongs to the $name", async ({ init }) => {
    const { input, onSaved } = mount();
    type(input, "书房 diannao");
    const blur = press(input, init);
    await Promise.resolve();
    await Promise.resolve();
    expect(blur).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(input.value).toBe("书房 diannao");
  });

  it("still saves on a plain Enter", async () => {
    const { input, onSaved } = mount();
    type(input, "Study PC");
    const blur = press(input);
    expect(blur).toHaveBeenCalledOnce();
    // happy-dom does not deliver a React onBlur from the programmatic blur() the handler uses.
    flushSync(() => input.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledOnce());
    expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ computerName: "Study PC" }),
    }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith("Study PC"));
  });
});
