// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { WIDGET_SAMPLES } from "../../../shared/widget-samples";
import { parseWidgetInput, widgetActions, type WidgetPayload, type WidgetRoot } from "../../../shared/widget";
import { WidgetMessage } from "./WidgetMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function parsed(input: unknown): WidgetRoot {
  const result = parseWidgetInput(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const dinner = () => parsed({ ...(WIDGET_SAMPLES.dinnerChoice as Record<string, unknown>), allowOther: false });
const openDinner = () => parsed(WIDGET_SAMPLES.dinnerChoice);
const row = (root: WidgetRoot, more: Partial<WidgetPayload> = {}): Message => ({ id: "w1", role: "bot", kind: "widget", at: 1, text: "fallback", widget: { v: 1, root, ...more } });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const store = { state: {}, dispatch: vi.fn(), flushBotPatches: async () => null } as unknown as ReturnType<typeof useStore>;

let host: HTMLDivElement;
let root: Root;

function mount(message: Message) {
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(WidgetMessage, { botId: "scout", threadId: "t1", message }) })));
}

const find = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const radios = () => Array.from(host.querySelectorAll<HTMLElement>('[role="radio"]'));
const checked = () => radios().map((radio) => radio.getAttribute("aria-checked"));
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label)!;
const press = (element: HTMLElement) => act(async () => { element.click(); });
const key = (element: HTMLElement, name: string) => act(() => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const sent = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)).widgetAction;
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a list the person picks one row from", () => {
  it("draws its rows as a radio group named by the title, with none chosen and one tab stop", () => {
    mount(row(dinner()));
    const group = find('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Dinner tonight");
    expect(group.getAttribute("aria-required")).toBe("true");
    expect(radios().map((radio) => radio.textContent)).toEqual([
      "Butter chicken with naanRich, creamy, classic comfort food45 min",
      "Grilled veggie bowl with quinoaLight, healthy, quick to prepare20 min",
      "Margherita pizzaEasy, crowd-pleasing, order-in friendlyOrder in",
    ]);
    expect(checked()).toEqual(["false", "false", "false"]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    for (const radio of radios()) expect(radio.firstElementChild!.className).toContain("shadow-[inset_0_0_0_1.5px_var(--color-ink-tertiary)]");
    expect(find('[role="listitem"]')).toBeNull();
    expect(host.querySelectorAll('[role="radiogroup"] button')).toHaveLength(0);
  });

  it("chooses the row that is clicked, marks it, and sends its value with confirm", async () => {
    mount(row(dinner()));
    await press(radios()[1]!.querySelector<HTMLElement>("div div")!);
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(radios()[1]!.className).toContain("bg-inset");
    expect(radios()[1]!.firstElementChild!.className).toContain("shadow-[inset_0_0_0_5.5px_var(--color-accent)]");
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    expect(fetchMock).not.toHaveBeenCalled();

    await press(button("Pick this"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: { dish: "veggie-bowl" } });
    act(() => button(t("question.details")).click());
    expect(checked()).toEqual(["false", "true", "false"]);
    await press(radios()[0]!);
    expect(checked()).toEqual(["false", "true", "false"]);
  });

  it("does not send a confirm with nothing chosen: it says so and puts the focus on the first row", async () => {
    mount(row(dinner()));
    await press(button("Pick this"));
    expect(fetchMock).not.toHaveBeenCalled();
    const alert = find('[role="alert"]')!;
    expect(alert.textContent).toBe(t("widget.required", { label: "Dinner tonight" }));
    const group = find('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(radios()[0]);
    await press(radios()[2]!);
    expect(find('[role="alert"]')).toBeNull();
    expect(group.getAttribute("aria-invalid")).toBeNull();
    await press(button("Pick this"));
    expect(sent().values).toEqual({ dish: "pizza" });
  });

  it("sends a cancel with nothing chosen, and no values", async () => {
    mount(row(dinner()));
    await press(button("None of these"));
    expect(sent()).toEqual({ messageId: "w1", ref: "cancel", rev: 0 });
  });

  it("moves the choice with the arrow keys, and chooses with Space or Enter", () => {
    mount(row(dinner()));
    act(() => radios()[0]!.focus());
    key(radios()[0]!, " ");
    expect(checked()).toEqual(["true", "false", "false"]);
    key(radios()[0]!, "ArrowDown");
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(radios()[1]);
    key(radios()[1]!, "ArrowRight");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(radios()[2]);
    key(radios()[2]!, "ArrowDown");
    expect(checked()).toEqual(["true", "false", "false"]);
    key(radios()[0]!, "ArrowUp");
    expect(checked()).toEqual(["false", "false", "true"]);
    key(radios()[2]!, "ArrowLeft");
    expect(checked()).toEqual(["false", "true", "false"]);
    key(radios()[1]!, "Home");
    expect(checked()).toEqual(["true", "false", "false"]);
    key(radios()[0]!, "End");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);
    key(radios()[1]!, "Enter");
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locks its rows while a press is on its way", async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    mount(row(dinner()));
    await press(radios()[0]!);
    await press(button("Pick this"));
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("sending");
    expect(radios().map((radio) => radio.getAttribute("aria-disabled"))).toEqual(["true", "true", "true"]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, -1, -1]);
    await press(radios()[2]!);
    key(radios()[0]!, "ArrowDown");
    expect(checked()).toEqual(["true", "false", "false"]);
  });

  it("shows the row that went with a settled press, chosen and not interactive", async () => {
    mount(row(dinner(), { settled: { ref: "confirm", label: "Pick this", tone: "confirm", at: 2, values: { dish: "pizza" } } }));
    expect(find('[role="radiogroup"]')).toBeNull();
    act(() => button(t("question.details")).click());
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(radios().map((radio) => radio.getAttribute("aria-disabled"))).toEqual(["true", "true", "true"]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, -1, -1]);
    expect(radios()[2]!.className).toContain("bg-inset");
    expect(radios()[0]!.className).not.toContain("cursor-pointer");
    await press(radios()[0]!);
    key(radios()[2]!, "ArrowUp");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts on its default, and opens whole when the chosen row is past the limit", async () => {
    const list = (more: Record<string, unknown>) => parsed({ ...(WIDGET_SAMPLES.dinnerChoice as Record<string, unknown>), allowOther: false, limit: 2, ...more });
    mount(row(list({})));
    expect(radios()).toHaveLength(2);
    act(() => button(t("widget.showAll", { count: 3 })).click());
    expect(radios()).toHaveLength(3);

    mount(row(list({ defaultValue: "veggie-bowl" }), { rev: 1 }));
    expect(checked()).toEqual(["false", "true"]);
    await press(button("Pick this"));
    expect(sent().values).toEqual({ dish: "veggie-bowl" });

    mount(row(list({ defaultValue: "pizza" }), { rev: 2 }));
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(host.textContent).not.toContain("Show all");
    mount(row(list({}), { rev: 3, settled: { ref: "confirm", label: "Pick this", tone: "confirm", at: 2, values: { dish: "pizza" } } }));
    act(() => button(t("question.details")).click());
    expect(checked()).toEqual(["false", "false", "true"]);
  });

  it("leaves a list with no name as it was: rows that are pressed, not chosen", async () => {
    const list = parsed(WIDGET_SAMPLES.pullRequests);
    mount(row(list));
    expect(find('[role="radiogroup"]')).toBeNull();
    expect(radios()).toHaveLength(0);
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="listitem"] > button'));
    expect(rows).toHaveLength(3);
    await press(rows[1]!);
    expect(sent()).toEqual({ messageId: "w1", ref: widgetActions(list)[1]!.ref, rev: 0, values: {} });
    expect(rows[1]!.getAttribute("aria-checked")).toBeNull();
  });
});

describe("a list the person may answer in their own words", () => {
  const other = () => find<HTMLInputElement>('input[data-widget-other="dish"]');

  it("offers Other after the rows as one more choice, with no field until it is chosen", () => {
    mount(row(openDinner()));
    expect(radios()).toHaveLength(4);
    expect(radios()[3]!.textContent).toBe(t("question.other"));
    expect(checked()).toEqual(["false", "false", "false", "false"]);
    expect(other()).toBeNull();
  });

  it("opens a field for their words when Other is clicked, and sends the words apart from the options", async () => {
    mount(row(openDinner()));
    await press(radios()[3]!);
    expect(checked()).toEqual(["false", "false", "false", "true"]);
    expect(document.activeElement).toBe(other());
    expect(other()!.placeholder).toBe(t("question.otherPlaceholder"));
    type(other()!, "Leftover dal");
    await press(button("Pick this"));
    expect(sent()).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: { dish: "" }, other: { dish: "Leftover dal" } });
  });

  it("drops their words when a row is chosen after all", async () => {
    mount(row(openDinner()));
    await press(radios()[3]!);
    type(other()!, "Leftover dal");
    await press(radios()[0]!);
    expect(other()).toBeNull();
    await press(button("Pick this"));
    expect(sent()).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: { dish: "butter-chicken" } });
  });

  it("will not send Other with nothing typed when the list is required, and puts the focus in the field", async () => {
    mount(row(openDinner()));
    await press(radios()[3]!);
    type(other()!, "   ");
    act(() => other()!.blur());
    await press(button("Pick this"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.required", { label: "Dinner tonight" }));
    expect(document.activeElement).toBe(other());
  });

  it("reaches Other with the arrow keys and keeps the focus on the choices", () => {
    mount(row(openDinner()));
    act(() => radios()[2]!.focus());
    key(radios()[2]!, "ArrowDown");
    expect(checked()).toEqual(["false", "false", "false", "true"]);
    expect(document.activeElement).toBe(radios()[3]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, -1, -1, 0]);
    key(radios()[3]!, "ArrowDown");
    expect(checked()).toEqual(["true", "false", "false", "false"]);
    key(radios()[0]!, "End");
    expect(checked()).toEqual(["false", "false", "false", "true"]);
  });

  it("shows their words, chosen and read-only, when a settled press is opened", () => {
    mount(row(openDinner(), { settled: { ref: "confirm", label: "Pick this", tone: "confirm", at: 2, values: { dish: "" }, other: { dish: "Leftover dal" } } }));
    act(() => button(t("question.details")).click());
    expect(checked()).toEqual(["false", "false", "false", "true"]);
    expect(other()!.value).toBe("Leftover dal");
    expect(other()!.disabled).toBe(true);
  });

  it("offers no Other when the bot said allowOther: false", () => {
    mount(row(dinner()));
    expect(radios()).toHaveLength(3);
    expect(host.textContent).not.toContain(t("question.other"));
  });
});
