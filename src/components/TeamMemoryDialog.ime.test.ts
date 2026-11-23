// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
import { TeamMemoryDialog } from "./TeamMemoryDialog";

let root: Root;
let host: HTMLDivElement;
const entry = {
  id: "note",
  kind: "decision",
  name: "Colour",
  detail: "Green",
  aliases: [],
  status: "accepted",
  revision: "revision-one",
  source: { botId: "b", botName: "Editor", threadId: "t", at: 1 },
  updatedAt: 1,
};

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ entries: [entry], loadedIds: [entry.id] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function mount() {
  const onClose = vi.fn();
  flushSync(() => root.render(createElement(TeamMemoryDialog, { section: "Editing", label: "Editing", onClose })));
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Colour detail"]')).not.toBeNull());
  return { onClose };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("editing an entry's detail with an input method", () => {
  it.each(IME)("does not save on the Enter that belongs to the $name", async ({ init }) => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Colour detail"]')!;
    type(input, "lvse fang'an");
    const blur = vi.spyOn(input, "blur");
    press(input, { key: "Enter", ...init });
    await Promise.resolve();
    await Promise.resolve();
    expect(blur).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(input.value).toBe("lvse fang'an");
  });

  it("still saves on a plain Enter", async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Colour detail"]')!;
    type(input, "Amber");
    const blur = vi.spyOn(input, "blur");
    press(input, { key: "Enter" });
    expect(blur).toHaveBeenCalledOnce();
    // happy-dom does not deliver a React onBlur from the programmatic blur() the handler uses.
    flushSync(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await vi.waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const sent = request.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(sent[1].body)).toEqual({ detail: "Amber", expectedRevision: "revision-one" });
  });
});

describe("adding an entry with an input method", () => {
  async function openAddForm() {
    await mount();
    const addEntry = [...document.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("Add an entry"));
    expect(addEntry).toBeTruthy();
    flushSync(() => addEntry!.click());
    const name = document.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    const detail = document.querySelector<HTMLInputElement>('[aria-label="Detail"]')!;
    type(name, "Palette");
    type(detail, "lvse fang'an");
    return { name, detail };
  }

  it.each(IME)("does not create the entry on the Enter that belongs to the $name", async ({ init }) => {
    const { detail } = await openAddForm();
    press(detail, { key: "Enter", ...init });
    await Promise.resolve();
    await Promise.resolve();
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(detail.value).toBe("lvse fang'an");
  });

  it("still creates the entry on a plain Enter", async () => {
    const { detail } = await openAddForm();
    press(detail, { key: "Enter" });
    await vi.waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const sent = request.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(sent[0]).toBe("/api/team-memory?section=Editing");
    expect(JSON.parse(sent[1].body)).toEqual({ kind: "term", name: "Palette", detail: "lvse fang'an" });
  });
});

describe("closing the dialog with an input method", () => {
  it.each(IME)("does not close on the Escape that belongs to the $name", async ({ init }) => {
    const { onClose } = await mount();
    const event = press(window, { key: "Escape", ...init });
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on a plain Escape", async () => {
    const { onClose } = await mount();
    const event = press(window, { key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
