// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { WIDGET_SAMPLES } from "../../../shared/widget-samples";
import { parseWidgetInput, widgetActions, type WidgetPayload, type WidgetRoot } from "../../../shared/widget";
import { WidgetMessage } from "./WidgetMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sample(name: string): WidgetRoot {
  const parsed = parseWidgetInput(WIDGET_SAMPLES[name]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const row = (root: WidgetRoot, more: Partial<WidgetPayload> = {}): Message => ({
  id: "w1", role: "bot", kind: "widget", at: 1, text: "the readable fallback", widget: { v: 1, root, ...more },
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const openExternal = vi.fn(async (_url: string) => {});
const flushBotPatches = vi.fn<(botId: string) => Promise<null>>();
const store = { state: {}, dispatch: vi.fn(), flushBotPatches } as unknown as ReturnType<typeof useStore>;
const inStore = (message: Message) => createElement(BotEditorStore, { value: store, children: createElement(WidgetMessage, { botId: "scout", threadId: "t1", message }) });

let host: HTMLDivElement;
let root: Root;

function mount(message: Message) {
  act(() => root.render(inStore(message)));
}

const find = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string) => Array.from(host.querySelectorAll<T>(selector));
const button = (label: string) => all<HTMLButtonElement>("button").find((element) => element.textContent?.trim() === label);
const field = <T extends HTMLElement>(name: string) => find<T>(`[data-widget-field="${name}"]`)!;
const press = (element: HTMLElement) => act(async () => { element.click(); });

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pickTime(name: string, time: string) {
  act(() => field<HTMLButtonElement>(name).click());
  const option = document.querySelector<HTMLElement>(`[role="option"][data-value="${time}"]`);
  if (!option) throw new Error(`no ${time} in the list of ${name}`);
  act(() => option.click());
}

const daysOn = () => all<HTMLButtonElement>('[data-day][aria-pressed="true"]').map((day) => day.dataset.day);

function emptyTimeForm(): WidgetRoot {
  const parsed = parseWidgetInput({
    type: "Card", title: "When",
    children: [{ type: "Row", children: [{ type: "Label", value: "At", fieldName: "at" }, { type: "Spacer" }, { type: "TimePicker", name: "at", step: 30, required: true, clearable: true }] }],
    confirm: { label: "Save time", action: { type: "time.save" } }, cancel: { label: "Never mind", action: { type: "time.cancel" } },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function posted(call = 0): { path: string; method?: string; body: Record<string, any> } {
  const [path, init] = fetchMock.mock.calls[call]!;
  return { path, method: init?.method, body: JSON.parse(String(init?.body)) };
}

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

describe("drawing a widget", () => {
  it.each(Object.keys(WIDGET_SAMPLES))("draws the %s sample, to markup and into the page, without a React warning", (name) => {
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = row(sample(name));
    const markup = renderToStaticMarkup(inStore(message));
    expect(markup).toContain('data-widget="w1"');
    mount(message);
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    for (const entry of widgetActions(message.widget!.root)) expect(find(`[data-widget-ref="${entry.ref}"]`), entry.label).not.toBeNull();
    expect(warned).not.toHaveBeenCalled();
  });

  it("draws the header, the rows and the actions of the list sample", () => {
    mount(row(sample("pullRequests")));
    const card = find('[data-widget="w1"]')!;
    expect(card.getAttribute("aria-label")).toBe("Pull requests");
    expect(card.textContent).toContain("mausbot-mobile");
    expect(card.textContent).toContain("3 open");
    const rows = all('[role="listitem"] > button');
    expect(rows.map((item) => item.textContent)).toEqual([
      "iOS: mid-turn steer#750 · 4 files · passed 2h agoReady",
      "Android: thread pin parity#739 · 2 files · passed 5h agoReady",
      "iOS: file links, send, attach#719 · 9 files · 1 test failingFailing",
    ]);
    expect(rows[0]!.querySelector(".size-\\[7px\\].bg-success")).not.toBeNull();
    expect(rows[2]!.querySelector(".size-\\[7px\\].bg-danger")).not.toBeNull();
    expect(rows[0]!.firstElementChild!.className).toContain("size-10");
    expect(button("Merge the two ready")!.className).toContain("bg-accent");
    expect(button("Fix #719 first")!.className).toContain("ring-composer-ring");
  });

  it("sizes the card by its root: sm 360, md 440, otherwise 600", () => {
    const sized = (size?: string) => {
      mount(row({ type: "Card", id: "n1", ...(size ? { size } : {}), children: [] }));
      return find('[data-widget="w1"]')!.className;
    };
    expect(sized("sm")).toContain("max-w-[360px]");
    expect(sized("md")).toContain("max-w-[440px]");
    expect(sized("lg")).toContain("max-w-[600px]");
    expect(sized("full")).toContain("max-w-[600px]");
    expect(sized()).toContain("max-w-[600px]");
  });

  it("draws the children of a type it does not know, and nothing for one with none, and never throws", () => {
    const odd = {
      type: "Card", id: "n1", title: "Odd one",
      children: [
        { type: "Carousel", id: "n2", children: [{ type: "Text", id: "n3", value: "Inside the unknown" }] },
        { type: "Hologram", id: "n4" },
        { type: "Row", id: "n5" },
        { type: "Table", id: "n6" },
        { type: "Col", id: "n7", children: null },
        { type: "Table", id: "n8", children: [{ type: "Table.Row", id: "n9" }] },
        { type: "Form", id: "n10" },
        { type: "Transition", id: "n11" },
        { type: "Chart", id: "n12" },
        { type: "Select", id: "n13", name: "pick" },
        { type: "RadioGroup", id: "n14", name: "radio" },
        { type: "Button", id: "n15", label: "Goes nowhere" },
      ],
    } as unknown as WidgetRoot;
    mount(row(odd));
    expect(host.textContent).toContain("Inside the unknown");
    expect(button("Goes nowhere")!.disabled).toBe(true);
    for (const bare of [{ type: "Card", id: "n1" }, { type: "ListView", id: "n1" }, { type: "ListView", id: "n1", children: [{ type: "ListViewItem", id: "n2" }] }, { type: "Mystery", id: "n1" }]) {
      mount(row(bare as unknown as WidgetRoot));
      expect(find('[data-widget="w1"]')).not.toBeNull();
    }
  });

  it("falls back to the row's text when there is no tree to draw", () => {
    mount({ id: "w1", role: "bot", kind: "widget", at: 1, text: "the readable fallback" });
    expect(host.textContent).toBe("the readable fallback");
    expect(host.querySelector(".chat-text")?.className).toContain("max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))]");
    expect(find("[data-widget]")).toBeNull();
  });

  it("folds a list past its limit behind Show all, and unfolds it in place", () => {
    mount(row(sample("sources")));
    expect(all('[role="listitem"]')).toHaveLength(2);
    const more = button(t("widget.showAll", { count: 3 }))!;
    expect(more.textContent).toBe("Show all (3)");
    act(() => more.click());
    expect(all('[role="listitem"]')).toHaveLength(3);
    expect(button("Show all (3)")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a remote image behind a click, as a bot's Markdown does, then draws it lazily with no referrer", () => {
    mount(row(sample("kitchenSink")));
    expect(find("img")).toBeNull();
    act(() => find<HTMLButtonElement>(`button[title="${t("attach.externalHidden")}"]`)!.click());
    const image = find<HTMLImageElement>("img")!;
    expect(image.getAttribute("src")).toBe("https://mausbot.com/og.png");
    expect(image.getAttribute("alt")).toBe("MausBot");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(Number.parseFloat(image.style.aspectRatio)).toBeCloseTo(16 / 9);
    expect(image.style.borderRadius).toBe("12px");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a Caption, a Title and a Label the width they ask for, so the draft's TO and SUBJECT column lines up", () => {
    mount(row(sample("emailDraft")));
    const captions = all<HTMLDivElement>("div").filter((element) => element.textContent === "TO" || element.textContent === "SUBJECT");
    expect(captions.map((caption) => caption.textContent)).toEqual(["TO", "SUBJECT"]);
    for (const caption of captions) {
      expect(caption.style.width).toBe("64px");
      expect(caption.style.flexShrink).toBe("0");
    }

    const parsed = parseWidgetInput({ type: "Card", children: [
      { type: "Title", value: "Wide title", width: 120 },
      { type: "Text", value: "Whole row", width: "100%" },
      { type: "Row", children: [{ type: "Label", value: "Name", fieldName: "name", width: 96 }, { type: "Input", name: "name" }] },
      { type: "Caption", value: "No width" },
    ] });
    if (!parsed.ok) throw new Error(parsed.error);
    mount(row(parsed.value));
    const text = (value: string) => all<HTMLElement>("div, label").find((element) => element.textContent === value && !element.children.length)!;
    expect(text("Wide title").style.width).toBe("120px");
    expect(text("Whole row").style.width).toBe("100%");
    expect(text("Name").style.width).toBe("96px");
    expect(text("No width").style.width).toBe("");
  });

  it("lets a clipped button label be read in full, with a link's address under it", () => {
    mount(row(sample("kitchenSink")));
    expect(button("Send feedback")!.title).toBe("Send feedback");
    expect(button("Open the docs")!.title).toBe("Open the docs\nhttps://mausbot.com/docs");
    mount(row(sample("pullRequests")));
    expect(button("Merge the two ready")!.title).toBe("Merge the two ready");
    expect(button("Fix #719 first")!.title).toBe("Fix #719 first");
  });

  it("speaks a field with no label by its placeholder, and records it by its name", async () => {
    const parsed = parseWidgetInput({ type: "Card", children: [{ type: "Input", name: "email", placeholder: "you@example.com", required: true }, { type: "RadioGroup", name: "plan", ariaLabel: "Plan", options: ["Free", "Pro"] }], confirm: { label: "Save", action: { type: "x.save" } } });
    if (!parsed.ok) throw new Error(parsed.error);
    mount(row(parsed.value));
    expect(field("email").getAttribute("aria-label")).toBe("you@example.com");
    expect(find('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Plan");
    await press(button("Save")!);
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.required", { label: "email" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ties a label to its field, and names a field that has none", () => {
    mount(row(sample("routineForm")));
    const report = field<HTMLSelectElement>("report");
    expect(all<HTMLLabelElement>("label").find((label) => label.textContent === "Report to")!.htmlFor).toBe(report.id);
    expect(report.getAttribute("aria-label")).toBe("Report to");
    expect(find('[role="group"][aria-label="Runs on"]')).not.toBeNull();
    expect(all<HTMLLabelElement>("label").find((label) => label.textContent === "Runs on")!.htmlFor).toBe("");
    const at = field<HTMLButtonElement>("at");
    expect(at.getAttribute("role")).toBe("combobox");
    expect(at.value).toBe("09:00");
    expect(all<HTMLLabelElement>("label").find((label) => label.textContent === "At")!.htmlFor).toBe(at.id);
    expect(field<HTMLInputElement>("starts").type).toBe("date");
    expect(field<HTMLInputElement>("starts").min).toBe("2026-10-13");
    expect(field<HTMLInputElement>("stopOnRed").checked).toBe(true);
    expect(Array.from(report.options).map((option) => option.value).slice(0, 3)).toEqual(["", "discord:releases", "chat"]);
    expect(Array.from(report.options).map((option) => option.textContent).slice(3)).toEqual([t("question.other")]);
    expect(report.options[0]!.disabled).toBe(true);
    expect(report.value).toBe("");
  });
});

describe("a settled widget", () => {
  const settled = (tone: "confirm" | "cancel", label: string) => row(sample("routineForm"), { settled: { ref: tone, label, tone, at: 2 } });

  it("folds to one tick line with no actions, and Details shows the card read-only", () => {
    mount(settled("confirm", "Create routine"));
    const line = find('[data-ask-card="settled"]')!;
    expect(line.textContent).toBe(`Create routine${t("question.details")}`);
    expect(line.querySelector("svg.lucide-check")).not.toBeNull();
    expect(find("[data-widget]")).toBeNull();
    expect(find("[data-widget-ref]")).toBeNull();
    const details = button(t("question.details"))!;
    expect(details.getAttribute("aria-expanded")).toBe("false");

    act(() => details.click());
    expect(details.getAttribute("aria-expanded")).toBe("true");
    const card = find('[data-widget="w1"]')!;
    expect(card.parentElement!.id).toBe(details.getAttribute("aria-controls"));
    expect(card.getAttribute("data-widget-state")).toBe("settled");
    expect(card.textContent).toContain("New routine: release check");
    const controls = all<HTMLInputElement | HTMLSelectElement>("[data-widget-field]");
    expect(controls.length).toBe(5);
    expect(controls.every((control) => control.disabled)).toBe(true);
    expect(find('[data-widget-ref="confirm"]')).toBeNull();
    expect(find('[data-widget-ref="cancel"]')).toBeNull();

    act(() => details.click());
    expect(find("[data-widget]")).toBeNull();
  });

  it("fills the read-only card from the values that went with the press, not from the defaults", () => {
    const sent = { days: "mon,thu", starts: "2026-11-02", at: "07:15", report: "chat", stopOnRed: false };
    mount(row(sample("routineForm"), { settled: { ref: "confirm", label: "Create routine", tone: "confirm", at: 2, values: sent } }));
    act(() => button(t("question.details"))!.click());
    expect(daysOn()).toEqual(["mon", "thu"]);
    expect(field<HTMLInputElement>("starts").value).toBe("2026-11-02");
    expect(field<HTMLButtonElement>("at").value).toBe("07:15");
    expect(field<HTMLSelectElement>("report").value).toBe("chat");
    expect(field<HTMLInputElement>("stopOnRed").checked).toBe(false);
    expect(all<HTMLInputElement>("[data-widget-field]").every((control) => control.disabled)).toBe(true);

    mount(row(sample("routineForm"), { settled: { ref: "confirm", label: "Create routine", tone: "confirm", at: 2 } }));
    expect(daysOn()).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(field<HTMLInputElement>("stopOnRed").checked).toBe(true);
  });

  it("draws a cross, not a tick, for a cancel", () => {
    mount(settled("cancel", "Discard"));
    const line = find('[data-ask-card="settled"]')!;
    expect(line.textContent).toContain("Discard");
    expect(line.querySelector("svg.lucide-x")).not.toBeNull();
    expect(line.querySelector("svg.lucide-check")).toBeNull();
  });
});

describe("pressing", () => {
  it("posts confirm with the edited values on the send route, with no text, locks while it is sent, and folds on the server's answer", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    mount(row(sample("routineForm")));
    act(() => find<HTMLButtonElement>('[data-day="sat"]')!.click());
    pickTime("at", "08:30");
    act(() => field<HTMLInputElement>("stopOnRed").click());
    await press(button("Create routine")!);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { path, method, body } = posted();
    expect(path).toBe("/api/bots/scout/messages");
    expect(method).toBe("POST");
    expect(body).toEqual({
      threadId: "t1",
      sendId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      widgetAction: { messageId: "w1", ref: "confirm", rev: 0, values: { days: "mon,tue,wed,thu,fri,sat", starts: "2026-10-14", at: "08:30", report: "", stopOnRed: false } },
    });
    expect("text" in body).toBe(false);

    const card = find('[data-widget="w1"]')!;
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(card.getAttribute("data-widget-state")).toBe("sending");
    expect(button("Create routine")!.getAttribute("aria-busy")).toBe("true");
    expect(button("Create routine")!.querySelector(".animate-spin")).not.toBeNull();
    expect(button("Discard")!.disabled).toBe(true);
    expect(all<HTMLInputElement>("[data-widget-field]").every((control) => control.disabled)).toBe(true);
    await press(button("Discard")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(find('[data-ask-card="settled"]')).toBeNull();

    await act(async () => { answer(reply(200, { ok: true })); });
    const line = find('[data-ask-card="settled"]')!;
    expect(line.textContent).toBe(`Create routine${t("question.details")}`);
    expect(line.querySelector("svg.lucide-check")).not.toBeNull();
    expect(find("[data-widget]")).toBeNull();
    act(() => button(t("question.details"))!.click());
    expect(daysOn()).toEqual(["mon", "tue", "wed", "thu", "fri", "sat"]);
    expect(field<HTMLButtonElement>("at").value).toBe("08:30");
    expect(field<HTMLInputElement>("stopOnRed").checked).toBe(false);
    expect(all<HTMLInputElement>("[data-widget-field]").every((control) => control.disabled)).toBe(true);
    expect(find('[data-widget-ref="confirm"]')).toBeNull();

    mount(row(sample("routineForm"), { settled: { ref: "confirm", label: "Create routine", tone: "confirm", at: 2, values: { days: "mon,tue,wed,thu,fri,sat", starts: "2026-10-14", at: "8:30", report: "", stopOnRed: false } } }));
    expect(find('[data-ask-card="settled"]')!.textContent).toContain("Create routine");
    expect(field<HTMLButtonElement>("at").value).toBe("08:30");
  });

  it("comes back to life when the server reopens a press that was cancelled in the queue", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, queued: true, queueId: "q1" }));
    mount(row(sample("pullRequests")));
    await press(button("Merge the two ready")!);
    expect(find('[data-ask-card="settled"]')).not.toBeNull();
    mount(row(sample("pullRequests"), { settled: { ref: "confirm", label: "Merge the two ready", tone: "confirm", at: 2, queueId: "q1" } }));
    expect(find('[data-ask-card="settled"]')).not.toBeNull();
    mount(row(sample("pullRequests")));
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(button("Merge the two ready")!.disabled).toBe(false);
  });

  it("comes back to life after a cancelled queued press when the patch frame beat the POST's answer", async () => {
    const queued = { settled: { ref: "confirm", label: "Merge the two ready", tone: "confirm" as const, at: 2, queueId: "q1" } };
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    mount(row(sample("pullRequests")));
    await press(button("Merge the two ready")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mount(row(sample("pullRequests"), queued));
    expect(find('[data-ask-card="settled"]')).not.toBeNull();
    await act(async () => { answer(reply(200, { ok: true, queued: true, queueId: "q1" })); });
    expect(find('[data-ask-card="settled"]')).not.toBeNull();
    mount(row(sample("pullRequests")));
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(button("Merge the two ready")!.disabled).toBe(false);
    expect(button("Fix #719 first")!.disabled).toBe(false);

    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    await press(button("Merge the two ready")!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    mount(row(sample("pullRequests"), queued));
    mount(row(sample("pullRequests")));
    await act(async () => { answer(reply(200, { ok: true, queued: true, queueId: "q1" })); });
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(button("Merge the two ready")!.disabled).toBe(false);

    await press(button("Fix #719 first")!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(find('[data-ask-card="settled"]')!.textContent).toContain("Fix #719 first");
  });

  it("sends once when a button is pressed twice in one tick", async () => {
    mount(row(sample("pullRequests")));
    await act(async () => {
      const merge = button("Merge the two ready")!;
      merge.click();
      merge.click();
      button("Fix #719 first")!.click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted().body.widgetAction.ref).toBe("confirm");
  });

  it("leaves a click on a row inside a row, or on a link in its Markdown, to that control", async () => {
    const parsed = parseWidgetInput({ type: "ListView", children: [{
      type: "ListViewItem", onClickAction: { type: "outer.open" }, children: [
        { type: "Text", value: "Outer row" },
        { type: "Markdown", value: "See [the docs](https://example.com/docs)." },
        { type: "ListViewItem", onClickAction: { type: "inner.open" }, children: [{ type: "Text", value: "Inner row" }] },
      ],
    }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const [outer, inner] = widgetActions(parsed.value);
    mount(row(parsed.value));
    const outerRow = find(`[data-widget-ref="${outer!.ref}"]`)!;
    expect(outerRow.tagName).toBe("DIV");
    expect(outerRow.getAttribute("role")).toBe("button");
    const innerRow = find<HTMLButtonElement>(`[data-widget-ref="${inner!.ref}"]`)!;
    expect(innerRow.tagName).toBe("BUTTON");

    await press(innerRow);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted().body.widgetAction.ref).toBe(inner!.ref);

    // Stopped here so the test opens nothing; following the link is the browser's job.
    host.addEventListener("click", (event) => { if ((event.target as Element).closest("a")) event.preventDefault(); });
    await press(outerRow.querySelector<HTMLAnchorElement>("a")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { outerRow.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted(1).body.widgetAction.ref).toBe(outer!.ref);
  });

  it("does not open a link when Enter is pressed in a form whose submit button is one", async () => {
    const enter = () => act(async () => {
      field("q").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const link = { type: "Button", label: "Search the web", submit: true, onClickAction: { type: "open_url", payload: { url: "https://example.com/search" } } };
    const only = parseWidgetInput({ type: "Card", children: [{ type: "Form", onSubmitAction: { type: "q.ask" }, children: [{ type: "Input", name: "q", defaultValue: "widgets" }, link] }] });
    if (!only.ok) throw new Error(only.error);
    mount(row(only.value));
    await enter();
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await press(button("Search the web")!);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/search");

    openExternal.mockClear();
    const both = parseWidgetInput({ type: "Card", children: [{ type: "Form", onSubmitAction: { type: "q.ask" }, children: [{ type: "Input", name: "q", defaultValue: "widgets" }, link, { type: "Button", label: "Ask", submit: true }] }] });
    if (!both.ok) throw new Error(both.error);
    mount(row(both.value));
    await enter();
    expect(openExternal).not.toHaveBeenCalled();
    expect(posted().body.widgetAction.ref).toBe(widgetActions(both.value).find((entry) => entry.label === "Ask")!.ref);
  });

  it("stays live when a settling press is refused, and folds nothing", async () => {
    fetchMock.mockImplementation(async () => reply(400, { error: "At is required." }));
    mount(row(sample("routineForm")));
    await press(button("Create routine")!);
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(find('[role="alert"]')!.textContent).toBe("At is required.");
  });

  it("stops on the first empty required field, marks it, and posts nothing", async () => {
    mount(row(emptyTimeForm()));
    const at = field<HTMLButtonElement>("at");
    await press(button("Save time")!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(at.getAttribute("aria-invalid")).toBe("true");
    const alert = find('[role="alert"]')!;
    expect(alert.textContent).toBe(t("widget.required", { label: "At" }));
    expect(at.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(at);
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");

    pickTime("at", "09:00");
    expect(at.getAttribute("aria-invalid")).toBeNull();
    expect(find('[role="alert"]')).toBeNull();
    await press(button("Save time")!);
    expect(posted().body.widgetAction.values.at).toBe("09:00");
  });

  it("sends a cancel with no values, past an empty required field", async () => {
    mount(row(emptyTimeForm()));
    await press(button("Never mind")!);
    expect(posted().body).toEqual({ threadId: "t1", sendId: expect.any(String), widgetAction: { messageId: "w1", ref: "cancel", rev: 0 } });
    const line = find('[data-ask-card="settled"]')!;
    expect(line.textContent).toContain("Never mind");
    expect(line.querySelector("svg.lucide-x")).not.toBeNull();
  });

  it("opens an open_url link on this device and posts nothing", async () => {
    mount(row(sample("sources")));
    const link = find<HTMLButtonElement>('[role="listitem"] > button')!;
    expect(link.title).toBe("https://developers.openai.com/api/docs/guides/chatkit-widgets");
    await press(link);
    expect(openExternal).toHaveBeenCalledWith("https://developers.openai.com/api/docs/guides/chatkit-widgets");
    expect(all('[role="listitem"]')[1]!.querySelector("button")).not.toBeNull();
    act(() => button("Show all (3)")!.click());
    expect(all('[role="listitem"]')[2]!.querySelector("button, [role=button]")).toBeNull();

    mount(row(sample("kitchenSink")));
    await press(button("Open the docs")!);
    expect(openExternal).toHaveBeenLastCalledWith("https://mausbot.com/docs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a published page's open_url in the bot's browser panel in the desktop app, and posts nothing", async () => {
    const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
    const dispatch = vi.fn();
    const withBrowser = { ...store, dispatch, state: { selectedId: "scout", bots: [{ id: "scout" }], groups: [], config: { features: { browser: true }, browserEngine: { kind: "engine" } } } } as unknown as ReturnType<typeof useStore>;
    const parsed = parseWidgetInput({ type: "Card", children: [{ type: "Button", label: "Open page", onClickAction: { type: "open_url", payload: { url: PAGE } } }] });
    if (!parsed.ok) throw new Error(parsed.error);
    act(() => root.render(createElement(BotEditorStore, { value: withBrowser, children: createElement(WidgetMessage, { botId: "scout", threadId: "t1", message: row(parsed.value) }) })));
    await press(button("Open page")!);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleComputer", open: true }]]);
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's sentence in the card when a press is refused, and stays live", async () => {
    fetchMock.mockImplementation(async () => reply(409, { error: "This was already answered." }));
    mount(row(sample("routineForm")));
    await press(button("Create routine")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const alert = find('[data-widget="w1"] [role="alert"]')!;
    expect(alert.textContent).toBe("This was already answered.");
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(button("Create routine")!.disabled).toBe(false);
    expect(field<HTMLInputElement>("at").disabled).toBe(false);
  });

  it("sends a submit with its own form's fields only, after the form's required check", async () => {
    mount(row(sample("kitchenSink")));
    await press(button("Send feedback")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find('[role="radiogroup"]')!.getAttribute("aria-invalid")).toBe("true");
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.required", { label: "How did the run go?" }));

    act(() => all<HTMLInputElement>('input[type="radio"]').find((radio) => radio.value === "mixed")!.click());
    type(find<HTMLTextAreaElement>("textarea")!, "Slow on the second step");
    await press(button("Send feedback")!);
    const submit = widgetActions(sample("kitchenSink")).find((entry) => entry.tone === "submit")!;
    expect(posted().body.widgetAction).toEqual({ messageId: "w1", ref: submit.ref, rev: 0, values: { rating: "mixed", email: "", note: "Slow on the second step" } });
  });

  it("submits a form when Enter is pressed in one of its fields", async () => {
    const form = { type: "Card", children: [{ type: "Form", onSubmitAction: { type: "name.set" }, children: [{ type: "Input", name: "name", defaultValue: "Scout" }, { type: "Button", label: "Save", submit: true }] }] };
    const parsed = parseWidgetInput(form);
    if (!parsed.ok) throw new Error(parsed.error);
    mount(row(parsed.value));
    await act(async () => {
      field("name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(posted().body.widgetAction.values).toEqual({ name: "Scout" });
  });

  it("ticks a button whose press leaves the widget live, and unlocks", async () => {
    mount(row(sample("kitchenSink")));
    await press(button("Ask me later")!);
    const later = widgetActions(sample("kitchenSink")).find((entry) => entry.label === "Ask me later")!;
    expect(posted().body.widgetAction).toEqual({ messageId: "w1", ref: later.ref, rev: 0, values: { rating: "", email: "", note: "" } });
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(button("Ask me later")!.querySelector("svg.lucide-check")).not.toBeNull();
    expect(find('[role="status"]')!.textContent).toBe(t("widget.sent"));
    expect(button("Send feedback")!.disabled).toBe(false);
  });

  it("says a press did not send when it got no answer, and sends it again under the same sendId", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });
    mount(row(sample("pullRequests")));
    await press(button("Merge the two ready")!);
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.sendFailed"));
    expect(button("Merge the two ready")!.disabled).toBe(false);

    await press(button("Merge the two ready")!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted(1).body.sendId).toBe(posted(0).body.sendId);
    expect(posted(1).body.widgetAction).toEqual({ messageId: "w1", ref: "confirm", rev: 0, values: {} });
    expect(find('[role="alert"]')).toBeNull();
  });

  it("names the revision a press was made on, and starts the card again when the tree is replaced", async () => {
    mount(row(sample("kitchenSink"), { rev: 3 }));
    type(find<HTMLTextAreaElement>("textarea")!, "Typed on revision 3");
    await press(button("Ask me later")!);
    expect(posted().body.widgetAction.rev).toBe(3);
    expect(button("Ask me later")!.querySelector("svg.lucide-check")).not.toBeNull();
    mount(row(sample("kitchenSink"), { rev: 4 }));
    expect(find<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(button("Ask me later")!.querySelector("svg.lucide-check")).toBeNull();
    expect(find('[role="status"]')!.textContent).toBe("");

    mount(row(sample("routineForm")));
    pickTime("at", "06:00");
    await press(button("Create routine")!);
    expect(find('[data-ask-card="settled"]')!.textContent).toContain("Create routine");
    mount(row(sample("routineForm"), { rev: 1 }));
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(field<HTMLButtonElement>("at").value).toBe("09:00");
    expect(button("Create routine")!.disabled).toBe(false);
    pickTime("at", "07:00");
    mount(row(sample("routineForm"), { rev: 1 }));
    expect(field<HTMLButtonElement>("at").value).toBe("07:00");
  });

  it("shows the server's refusal of a press on a stale revision, and stays live", async () => {
    fetchMock.mockImplementation(async () => reply(409, { error: "This widget changed. Check it and press again." }));
    mount(row(sample("routineForm"), { rev: 2 }));
    await press(button("Create routine")!);
    expect(posted().body.widgetAction.rev).toBe(2);
    expect(find('[role="alert"]')!.textContent).toBe("This widget changed. Check it and press again.");
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(button("Create routine")!.disabled).toBe(false);
  });

  it("saves the bot's pending settings before it posts a press, and posts nothing when that save fails", async () => {
    let saved!: () => void;
    flushBotPatches.mockImplementationOnce(() => new Promise((resolve) => { saved = () => resolve(null); }));
    mount(row(sample("pullRequests")));
    await press(find<HTMLButtonElement>('[role="listitem"] > button')!);
    expect(flushBotPatches).toHaveBeenCalledWith("scout");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("sending");
    await act(async () => { saved(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(flushBotPatches.mock.invocationCallOrder[0]!).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");

    fetchMock.mockClear();
    flushBotPatches.mockImplementationOnce(async () => { throw new Error("The model could not be saved"); });
    await press(button("Merge the two ready")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find('[role="alert"]')!.textContent).toBe(t("widget.sendFailed"));
    expect(find('[data-ask-card="settled"]')).toBeNull();
    expect(find('[data-widget="w1"]')!.getAttribute("data-widget-state")).toBe("live");
    expect(button("Merge the two ready")!.disabled).toBe(false);
  });

  it("presses a list row by its node id, and from the keyboard when the row holds a control", async () => {
    mount(row(sample("pullRequests")));
    const first = widgetActions(sample("pullRequests"))[0]!;
    await press(find<HTMLButtonElement>(`[data-widget-ref="${first.ref}"]`)!);
    expect(posted().body.widgetAction).toEqual({ messageId: "w1", ref: first.ref, rev: 0, values: {} });

    const parsed = parseWidgetInput({ type: "ListView", children: [{ type: "ListViewItem", onClickAction: { type: "row.open" }, children: [{ type: "Text", value: "A row" }, { type: "Button", label: "More", onClickAction: { type: "row.more" } }] }] });
    if (!parsed.ok) throw new Error(parsed.error);
    mount(row(parsed.value));
    const holder = find('[role="button"]')!;
    expect(holder.tabIndex).toBe(0);
    fetchMock.mockClear();
    await act(async () => {
      holder.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(posted().body.widgetAction.ref).toBe(parsed.value.children![0]!.id);
    await press(button("More")!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted(1).body.widgetAction.ref).toBe(widgetActions(parsed.value).find((entry) => entry.label === "More")!.ref);
  });
});

describe("the widget renderer's sources", () => {
  it("name no colour of their own: every one comes from a token", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name));
    expect(sources.length).toBeGreaterThanOrEqual(8);
    const offending = sources.flatMap((name) =>
      readFileSync(join(here, name), "utf8").split("\n").flatMap((line, index) => (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line) ? [`${name}:${index + 1}`] : [])));
    expect(offending).toEqual([]);
  });
});
