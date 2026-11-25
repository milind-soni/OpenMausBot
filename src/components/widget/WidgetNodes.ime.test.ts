// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import { parseWidgetInput, type WidgetPayload, type WidgetRoot } from "../../../shared/widget";
import { WidgetMessage } from "./WidgetMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const formRoot = (): WidgetRoot => {
  const parsed = parseWidgetInput({
    type: "Card",
    children: [{
      type: "Form",
      onSubmitAction: { type: "name.set" },
      children: [
        { type: "Input", name: "name", defaultValue: "ni hao" },
        { type: "Button", label: "Save", submit: true },
      ],
    }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const row = (root: WidgetRoot, more: Partial<WidgetPayload> = {}): Message => ({
  id: "w1", role: "bot", kind: "widget", at: 1, text: "fallback", widget: { v: 1, root, ...more },
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const openExternal = vi.fn(async (_url: string) => {});
const flushBotPatches = vi.fn<(botId: string) => Promise<null>>();
const store = { state: {}, dispatch: vi.fn(), flushBotPatches } as unknown as ReturnType<typeof useStore>;
const inStore = (message: Message) => createElement(BotEditorStore, { value: store, children: createElement(WidgetMessage, { botId: "scout", threadId: "t1", message }) });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, { ok: true }));
  flushBotPatches.mockReset();
  flushBotPatches.mockImplementation(async () => null);
  openExternal.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ogb", { openExternal });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function press(field: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  act(() => { field.dispatchEvent(event); });
  return event;
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("submitting a bot widget form with an input method", () => {
  function mountForm() {
    act(() => root.render(inStore(row(formRoot()))));
    return host.querySelector<HTMLInputElement>('[data-widget-field="name"]')!;
  }

  it.each(IME)("leaves the Enter that belongs to the $name to the input method", async ({ init }) => {
    const field = mountForm();
    const event = press(field, init);
    expect(event.defaultPrevented).toBe(false);
    // Let any accidental press settle before asserting.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still submits on a plain Enter", async () => {
    const field = mountForm();
    press(field);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.widgetAction.values).toEqual({ name: "ni hao" });
  });
});
