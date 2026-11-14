// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { WIDGET_SAMPLES } from "../../../shared/widget-samples";
import { dayList, parseWidgetInput, type WidgetNode, type WidgetRoot } from "../../../shared/widget";
import { WidgetMessage } from "./WidgetMessage";
import { widgetDayNames, widgetDaysCaption } from "./WidgetDayPicker";
import { widgetTime, widgetTimeLabel, widgetTimeSlots } from "./WidgetTimePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function parse(input: unknown): WidgetRoot {
  const parsed = parseWidgetInput(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const sample = (name: string) => parse(WIDGET_SAMPLES[name]);
const row = (root: WidgetRoot): Message => ({ id: "w1", role: "bot", kind: "widget", at: 1, text: "fallback", widget: { v: 1, root } });

const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const store = { state: {}, dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) } as unknown as ReturnType<typeof useStore>;

let host: HTMLDivElement;
let root: Root;
const mount = (root_: WidgetRoot) => act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(WidgetMessage, { botId: "scout", threadId: "t1", message: row(root_) }) })));
const find = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string) => Array.from(host.querySelectorAll<T>(selector));
const field = <T extends HTMLElement>(name: string) => find<T>(`[data-widget-field="${name}"]`)!;
const button = (label: string) => all<HTMLButtonElement>("button").find((element) => element.textContent?.trim() === label);
const key = (element: Element, name: string) => act(() => { element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
const sent = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).widgetAction.values;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
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

describe("a field's own label", () => {
  it("is drawn once above the field and tied to it, for every kind of field", () => {
    mount(sample("bookCall"));
    const labelFor = (text: string) => all<HTMLLabelElement>("label").find((label) => label.textContent === text)!;
    expect(labelFor("Date").htmlFor).toBe(field("date").id);
    expect(labelFor("Time").htmlFor).toBe(field("time").id);
    expect(labelFor("Note").htmlFor).toBe(field("note").id);
    const group = find('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Length");
    expect(all("label").some((label) => label.textContent === "Length")).toBe(false);
    for (const words of ["Date", "Time", "Length", "Note"]) expect(host.textContent!.split(words).length - 1).toBe(1);
  });

  it("gives way to a Label node that names the same field", () => {
    mount(parse({ type: "Card", children: [
      { type: "Label", value: "Due", fieldName: "due" },
      { type: "DatePicker", name: "due", label: "Due date" },
      { type: "Input", name: "email", label: "Email" },
      { type: "Checkbox", name: "remind", label: "Remind me" },
    ] }));
    expect(host.textContent).not.toContain("Due date");
    expect(all<HTMLLabelElement>("label").find((label) => label.textContent === "Due")!.htmlFor).toBe(field("due").id);
    expect(all<HTMLLabelElement>("label").find((label) => label.textContent === "Email")!.htmlFor).toBe(field("email").id);
    expect(host.textContent!.split("Remind me").length - 1).toBe(1);
    expect(field<HTMLInputElement>("remind").closest("label")!.textContent).toBe("Remind me");
  });

  it("gives each field in a row of fields an equal share of at least 160px", () => {
    mount(sample("bookCall"));
    const shares = ["date", "time"].map((name) => field(name).closest<HTMLElement>("[style]")!.style.flex);
    expect(shares).toEqual(["1 1 160px", "1 1 160px"]);
    expect(field("date").closest(".flex-wrap")).not.toBeNull();
  });
});

describe("TimePicker", () => {
  const picker = (props: Record<string, unknown> = {}) => parse({
    type: "Card",
    children: [{ type: "TimePicker", name: "at", label: "At", ...props }],
    confirm: { label: "Save", action: { type: "x.save" } },
  });
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  const active = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.dataset.value;

  it("offers a time every step from min to max, and the time it holds between two", () => {
    const node = (props: Record<string, unknown>) => ({ type: "TimePicker", id: "n1", name: "at", ...props }) as WidgetNode;
    expect(widgetTimeSlots(node({ min: "09:00", max: "10:00", step: 15 }))).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
    expect(widgetTimeSlots(node({ min: "09:00", max: "10:00", step: 30 }), "09:40")).toEqual(["09:00", "09:30", "09:40", "10:00"]);
    expect(widgetTimeSlots(node({}))).toHaveLength(96);
    expect(widgetTime("8:05")).toBe("08:05");
    expect(widgetTime("24:00")).toBe("");
    expect(widgetTimeLabel("13:30")).toMatch(/1:30|13:30/);
  });

  it("opens on the time it holds, walks the list from the keyboard, and sends HH:MM", async () => {
    mount(picker({ defaultValue: "9:30", min: "08:00", max: "12:00", step: 30 }));
    const trigger = field<HTMLButtonElement>("at");
    expect(trigger.value).toBe("09:30");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(options().map((option) => option.dataset.value)).toEqual(["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00"]);
    expect(active(trigger)).toBe("09:30");
    expect(options().find((option) => option.getAttribute("aria-selected") === "true")!.dataset.value).toBe("09:30");
    key(trigger, "ArrowDown");
    key(trigger, "ArrowDown");
    expect(active(trigger)).toBe("10:30");
    key(trigger, "End");
    expect(active(trigger)).toBe("12:00");
    key(trigger, "Home");
    expect(active(trigger)).toBe("08:00");
    key(trigger, "PageDown");
    expect(active(trigger)).toBe("09:00");
    key(trigger, "Enter");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.value).toBe("09:00");
    key(trigger, "1");
    key(trigger, "1");
    expect(active(trigger)).toBe("11:00");
    key(trigger, "Escape");
    expect(options()).toHaveLength(0);
    expect(trigger.value).toBe("09:00");
    await act(async () => { button("Save")!.click(); });
    expect(sent()).toEqual({ at: "09:00" });
  });

  it("takes a time by a click, closes on a click outside, and clears to nothing", async () => {
    mount(picker({ clearable: true, step: 60 }));
    const trigger = field<HTMLButtonElement>("at");
    expect(trigger.textContent).toContain(t("widget.time.choose"));
    act(() => trigger.click());
    act(() => options().find((option) => option.dataset.value === "14:00")!.click());
    expect(trigger.value).toBe("14:00");
    act(() => trigger.click());
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(options()).toHaveLength(0);
    act(() => find<HTMLButtonElement>(`button[aria-label="${t("widget.clear", { label: "At" })}"]`)!.click());
    expect(trigger.value).toBe("");
    await act(async () => { button("Save")!.click(); });
    expect(sent()).toEqual({ at: "" });
  });
});

describe("DayPicker", () => {
  const days = (props: Record<string, unknown> = {}) => parse({
    type: "Card",
    children: [{ type: "DayPicker", name: "days", label: "Repeat on", ...props }],
    confirm: { label: "Save", action: { type: "x.save" } },
  });
  const toggles = () => all<HTMLButtonElement>("[data-day]");
  const caption = () => find("[data-days-caption]")!.textContent;
  const group = () => find("[data-day]")!.closest<HTMLElement>('[role="group"]')!;

  it("draws seven toggles, Monday first, with the days' full names", () => {
    mount(days({ defaultValue: "mon,tue,wed,thu,fri" }));
    expect(toggles().map((day) => day.dataset.day)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(toggles().map((day) => day.getAttribute("aria-label"))).toEqual(widgetDayNames().long);
    expect(widgetDayNames().long[0]).toBe("Monday");
    expect(toggles().map((day) => day.getAttribute("aria-pressed"))).toEqual(["true", "true", "true", "true", "true", "false", "false"]);
    expect(caption()).toBe(t("widget.days.weekdays"));
    expect(document.getElementById(group().getAttribute("aria-labelledby")!)!.textContent).toBe("Repeat on");
  });

  it("says what is picked, and sends it in week order", async () => {
    mount(days({ defaultValue: "sat" }));
    const tap = (day: string) => act(() => find<HTMLButtonElement>(`[data-day="${day}"]`)!.click());
    tap("sun");
    expect(caption()).toBe(t("widget.days.weekends"));
    for (const day of ["mon", "tue", "wed", "thu", "fri"]) tap(day);
    expect(caption()).toBe(t("widget.days.everyDay"));
    for (const day of ["tue", "wed", "fri", "sat", "sun"]) tap(day);
    expect(caption()).toBe("Mon, Thu");
    expect(widgetDaysCaption("")).toBe(t("widget.days.none"));
    for (const value of ["mon,tue,wed,thu,fri,sat,sun", "mon,tue,wed,thu,fri", "sat,sun", "mon,thu", "tue,sun"]) expect(widgetDaysCaption(value)).toBe(dayList(value));
    await act(async () => { button("Save")!.click(); });
    expect(sent()).toEqual({ days: "mon,thu" });
  });

  it("is one stop for Tab, and the arrow keys move along the week", () => {
    mount(days());
    expect(toggles().map((day) => day.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    act(() => toggles()[0]!.focus());
    key(toggles()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(toggles()[1]);
    expect(toggles()[1]!.tabIndex).toBe(0);
    key(toggles()[1]!, "End");
    expect(document.activeElement).toBe(toggles()[6]);
    key(toggles()[6]!, "ArrowLeft");
    expect(document.activeElement).toBe(toggles()[5]);
  });

  it("needs at least one day before confirm sends, when it is required", async () => {
    mount(days({ required: true }));
    await act(async () => { button("Save")!.click(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.required", { label: "Repeat on" }));
    expect(group().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(toggles()[0]);
    act(() => toggles()[2]!.click());
    await act(async () => { button("Save")!.click(); });
    expect(sent()).toEqual({ days: "wed" });
  });
});

describe("a widget table", () => {
  it("is the app's own table: copy, CSV and expand, with the widget's columns and alignment", () => {
    mount(sample("spendTable"));
    const table = find(".rich-table")!;
    expect(table.querySelector(`input[aria-label="${t("table.search")}"]`)).toBeNull();
    for (const action of ["table.copy", "table.download", "table.expand"] as const) expect(table.querySelector(`button[aria-label="${t(action)}"]`)).not.toBeNull();
    expect(all("thead th").map((cell) => cell.textContent)).toEqual(["Bot", "Runs", "Cost"]);
    expect(all<HTMLElement>("thead th")[2]!.style.textAlign).toBe("end");
    expect(all<HTMLElement>("tbody td").filter((_, index) => index % 3 === 2).map((cell) => cell.style.textAlign)).toEqual(["end", "end", "end", "end"]);
    expect(all("tbody tr").map((line) => line.textContent)).toEqual(["Scout38$21.40", "Chief of Staff7$9.85", "Kiwi52$6.35", "Jev11$4.50"]);
    expect(find('[role="region"]')!.getAttribute("aria-label")).toBe("Spend by bot");
  });

  it("leaves out the heading row of a table with none, and spreads a cell over the columns it spans", () => {
    mount(parse({ type: "Card", children: [{ type: "Table", children: [
      { type: "Table.Row", children: [{ type: "Table.Cell", colSpan: 2, children: [{ type: "Text", value: "Wide" }] }, { type: "Table.Cell", children: [{ type: "Text", value: "C" }] }] },
      { type: "Table.Row", children: [{ type: "Table.Cell", vAlign: "end", children: [{ type: "Text", value: "A" }] }, { type: "Table.Cell", children: [{ type: "Badge", label: "B" }] }, { type: "Table.Cell", children: [] }] },
    ] }] }));
    expect(find("thead")!.hidden).toBe(true);
    expect(all("tbody tr")[0]!.querySelectorAll("td")).toHaveLength(3);
    expect(all("tbody tr").map((line) => line.textContent)).toEqual(["WideC", "AB"]);
    expect(all<HTMLElement>("tbody tr")[1]!.querySelector("td")!.style.verticalAlign).toBe("bottom");
  });
});

describe("a narrow card", () => {
  const sized = (width: number) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  );

  it("stacks a label over its field, which takes the whole width, and sits them side by side when there is room", () => {
    sized(340);
    mount(sample("routineForm"));
    expect(find("[data-widget]")!.hasAttribute("data-widget-compact")).toBe(true);
    const label = all<HTMLLabelElement>("label").find((each) => each.textContent === "Report to")!;
    expect(label.parentElement!.className).toContain("flex-col");
    expect(field("report").className).toContain("bg-inset");
    expect(field("report").className).toContain("w-full");
    expect(field("at").className).toContain("bg-inset");

    act(() => root.unmount());
    root = createRoot(host);
    sized(600);
    mount(sample("routineForm"));
    expect(find("[data-widget]")!.hasAttribute("data-widget-compact")).toBe(false);
    const wide = all<HTMLLabelElement>("label").find((each) => each.textContent === "Report to")!;
    expect(wide.parentElement!.className).toContain("flex-row");
    expect(field("report").className).not.toContain("bg-inset");
  });

  it("wraps a row of buttons rather than squeeze them past the card", () => {
    mount(sample("kitchenSink"));
    expect(button("Send feedback")!.parentElement!.className).toContain("flex-wrap");
  });
});

describe("a radio group or a dropdown the person may answer in their own words", () => {
  const form = (more: Record<string, unknown> = {}) => parse({ type: "Card", confirm: { label: "Save", action: { type: "save" } }, children: [
    { type: "RadioGroup", name: "size", label: "Size", options: ["S", "M"], ...more },
    { type: "Select", name: "length", label: "Length", options: ["15 min", "30 min"], ...more },
  ] });
  const other = (name: string) => find<HTMLInputElement>(`input[data-widget-other="${name}"]`);
  const typeInto = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const choose = (select: HTMLSelectElement, index: number) => act(() => {
    select.value = select.options[index]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const save = () => act(async () => { button("Save")!.click(); });
  const pressed = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).widgetAction;

  it("adds Other as the last radio, and opens a field for their words when it is chosen", async () => {
    mount(form());
    const radios = all<HTMLInputElement>('input[type="radio"]');
    expect(radios.map((radio) => radio.closest("label")!.textContent)).toEqual(["S", "M", t("question.other")]);
    expect(other("size")).toBeNull();
    act(() => radios[2]!.click());
    expect(radios[2]!.checked).toBe(true);
    expect(document.activeElement).toBe(other("size"));
    typeInto(other("size")!, "XL");
    await save();
    expect(pressed()).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: { size: "", length: "" }, other: { size: "XL" } });
  });

  it("adds Other as the last choice of a dropdown, and opens a field for their words when it is picked", async () => {
    mount(form());
    const select = field<HTMLSelectElement>("length");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([t("widget.choose"), "15 min", "30 min", t("question.other")]);
    choose(select, 3);
    expect(document.activeElement).toBe(other("length"));
    typeInto(other("length")!, "45 min");
    await save();
    expect(pressed().other).toEqual({ length: "45 min" });
    expect(pressed().values).toEqual({ size: "", length: "" });
  });

  it("drops their words when an option of the dropdown is picked after all", async () => {
    mount(form());
    choose(field<HTMLSelectElement>("length"), 3);
    typeInto(other("length")!, "45 min");
    choose(field<HTMLSelectElement>("length"), 2);
    expect(other("length")).toBeNull();
    await save();
    expect(pressed()).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: { size: "", length: "30 min" } });
  });

  it("offers no Other where the bot said allowOther: false", () => {
    mount(form({ allowOther: false }));
    expect(all('input[type="radio"]')).toHaveLength(2);
    expect(field<HTMLSelectElement>("length").options).toHaveLength(3);
    expect(host.textContent).not.toContain(t("question.other"));
  });
});
