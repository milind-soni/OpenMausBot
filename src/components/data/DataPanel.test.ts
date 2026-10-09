// @vitest-environment happy-dom
// The Data tab shows one result, with earlier results in History and
// a single live SQL field and quiet table references in the bottom dock.
import { act, createElement } from "react";
import { EditorView } from "codemirror";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataCard, DataPage, DataSheet, DataTable } from "../../../shared/data-surface";
import type { Bot } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  sheets: {} as Record<string, DataSheet>,
  tables: {} as Record<string, DataTable[]>,
  connected: true,
  dispatch: vi.fn(),
  api: vi.fn(),
  embedLoaded: false,
  embed: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { dataSheets: fixture.sheets, dataTables: fixture.tables, connected: fixture.connected }, dispatch: fixture.dispatch }),
}));
vi.mock("../ChatMarkdown", () => ({ ChatMarkdown: ({ text }: { text: string }) => createElement("div", { "data-testid": "markdown" }, text) }));
vi.mock("vega-embed", () => {
  fixture.embedLoaded = true;
  return { default: fixture.embed };
});
import { DataPanel, LIVE_RUN_DELAY_MS } from "./DataPanel";

const bot = { id: "pepper", threadId: "thread-1", name: "Pepper" } as Bot;
const now = "2026-10-09T10:00:00.000Z";
const card = (id: string, extra: Partial<DataCard>): DataCard => ({
  id, kind: "table", title: id, status: "ready", by: "bot", createdAt: now, updatedAt: now, sql: `select * from ${id}`, result: `q_${id}`,
  columns: [{ name: "n", type: "BIGINT" }], rowCount: 3, ...extra,
});
const sheet = (cards: DataCard[], sources: DataSheet["sources"] = []): DataSheet => ({ version: 1, botId: bot.id, cards, sources, updatedAt: now });
const page: DataPage = { columns: [{ name: "n", type: "BIGINT" }], rows: [["1"], ["2"], ["3"]], rowCount: 3, offset: 0 };

let host: HTMLDivElement;
let root: Root;
let fullscreenElement: Element | null;
let panelHeight: number;
let observers: Array<{ callback: () => void; targets: Set<Element> }>;
let capturedPointers: Set<number>;
const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (requestedCard?: { id: string; requestId: number }) => flushSync(() => root.render(createElement(DataPanel, { bot, requestedCard })));
const click = (label: string) => flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!.click());
const toggleFullscreen = (label: "Enter fullscreen" | "Exit fullscreen") => flushSync(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
const selectHistory = (title: string) => {
  host.querySelector<HTMLDetailsElement>('[data-testid="data-history"]')!.open = true;
  flushSync(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) => button.textContent === title)!.click());
};
const editorDom = () => host.querySelector<HTMLElement>('[role="textbox"][aria-label="SQL"]')!;
const editorView = () => EditorView.findFromDOM(editorDom())!;
const editorValue = () => editorView().state.doc.toString();
const type = (text: string) => {
  const view = editorView();
  flushSync(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Type, then wait out the pause after which the text runs. */
const typeAndRun = async (text: string) => {
  type(text);
  await pause(LIVE_RUN_DELAY_MS + 10);
  await settle();
};
const runRequests = () => fixture.api.mock.calls.filter(([path]) => path.endsWith("/run"));
const cancelRequests = () => fixture.api.mock.calls.filter(([path]) => path.endsWith("/cancel"));
/** Runs never answer, so a request is still on the wire when the test looks at it. */
const holdRuns = () => fixture.api.mockImplementation((path: string) => path.endsWith("/run") ? new Promise(() => {}) : Promise.resolve(page));
const cancelButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel");
const viewedResult = () => fixture.dispatch.mock.calls.filter(([action]) => action.type === "dataView").at(-1)?.[0].view;
const separator = () => host.querySelector<HTMLDivElement>('[data-testid="data-query-resize"]')!;
const dock = () => host.querySelector<HTMLDivElement>('[data-testid="data-query"]')!;
const resizeKey = (key: string, ctrlKey = false) => flushSync(() => separator().dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })));
const resizePointer = (type: string, clientY: number, pointerId = 1) => act(() => { separator().dispatchEvent(new PointerEvent(type, { clientY, pointerId, button: 0, bubbles: true, cancelable: true })); });
const resizePanel = (height: number) => {
  panelHeight = height;
  const panel = host.querySelector('[data-testid="data-panel"]')!;
  flushSync(() => observers.filter((observer) => observer.targets.has(panel)).forEach((observer) => observer.callback()));
};

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  fixture.sheets = {};
  fixture.tables = {};
  fixture.connected = true;
  fixture.embedLoaded = false;
  fixture.embed.mockResolvedValue({ view: { resize: () => ({ runAsync: async () => undefined }) }, finalize: vi.fn() });
  fixture.api.mockReset().mockResolvedValue(page);
  panelHeight = 600;
  observers = [];
  capturedPointers = new Set();
  vi.stubGlobal("ResizeObserver", class {
    entry: { callback: () => void; targets: Set<Element> };
    constructor(callback: () => void) { this.entry = { callback, targets: new Set() }; observers.push(this.entry); }
    observe(element: Element) { this.entry.targets.add(element); }
    unobserve(element: Element) { this.entry.targets.delete(element); }
    disconnect() { this.entry.targets.clear(); }
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() {
    if ((this as HTMLElement).dataset.testid === "data-panel") return panelHeight;
    if ((this as HTMLElement).dataset.testid === "data-query") return Number.parseFloat((this as HTMLElement).style.height) || 152;
    return 360;
  } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn((pointerId: number) => capturedPointers.add(pointerId)) });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: (pointerId: number) => capturedPointers.has(pointerId) });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn((pointerId: number) => capturedPointers.delete(pointerId)) });
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: vi.fn(async () => {
    fullscreenElement = host.querySelector('[data-testid="data-panel"]');
    document.dispatchEvent(new Event("fullscreenchange"));
  }) });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: vi.fn(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  }) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  flushSync(() => root.unmount());
  host.remove();
  await settle();
  vi.unstubAllGlobals();
});

describe("DataPanel", () => {
  it("shares only the mounted selection and its unsaved draft with chat", async () => {
    fixture.sheets.pepper = sheet([card("old", {}), card("orders", {})]);
    render();
    await settle();
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "orders" });
    type("select incomplete");
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "orders", draftSql: "select incomplete" });
    fixture.sheets.pepper = sheet([card("old", {}), card("orders", { by: "person", sql: "select 1", result: "q_person" })]);
    render();
    expect(viewedResult().draftSql).toBe("select incomplete");
    fixture.sheets.pepper = sheet([card("old", {}), card("orders", { by: "bot", status: "running", result: "q_person" })]);
    render();
    expect(viewedResult().draftSql).toBe("select incomplete");
    fixture.sheets.pepper = sheet([card("old", {}), card("orders", { by: "bot", sql: "select 42", result: "q_bot_edit" })]);
    render();
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "orders" });
    expect(editorValue()).toBe("select 42");
    selectHistory("old");
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "old" });
    type("");
    expect(viewedResult().draftSql).toBe("");
    type("select * from old");
    expect(viewedResult().draftSql).toBeUndefined();
    flushSync(() => root.render(null));
    expect(viewedResult()).toBeNull();
  });

  it("clears selection context for missing results, other bots, and thread changes", async () => {
    fixture.sheets.pepper = sheet([card("orders", {})]);
    holdRuns();
    render();
    await settle();
    await typeAndRun("select unfinished");
    const previousEditor = editorDom();
    const previousSignal = runRequests()[0]![1].signal as AbortSignal;
    flushSync(() => root.render(createElement(DataPanel, { bot: { ...bot, threadId: "thread-2" } })));
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-2", cardId: "orders" });
    expect(editorDom()).not.toBe(previousEditor);
    expect(editorValue()).toBe("select * from orders");
    expect(previousSignal.aborted).toBe(true);
    render({ id: "missing", requestId: 1 });
    await settle();
    expect(viewedResult()).toBeNull();
    flushSync(() => root.render(createElement(DataPanel, { bot: { ...bot, id: "other" } })));
    expect(viewedResult()).toBeNull();
  });

  it("clears a failed local edit's error when the bot repairs the same result", async () => {
    fixture.sheets.pepper = sheet([card("orders", {})]);
    fixture.api.mockImplementation((path: string) => path.endsWith("/run") ? Promise.reject(new Error("Parser Error: incomplete query")) : Promise.resolve(page));
    render();
    await settle();
    await typeAndRun("select incomplete");
    expect(host.querySelector('[data-testid="data-query-error"]')?.textContent).toBe("Parser Error: incomplete query");
    fixture.sheets.pepper = sheet([card("orders", { sql: "select 42", result: "q_repaired" })]);
    render();
    await settle();
    expect(editorValue()).toBe("select 42");
    expect(host.querySelector('[data-testid="data-query-error"]')?.textContent).toBe("");
    expect(viewedResult().draftSql).toBeUndefined();
  });

  it("aborts an older local request and ignores its late failure after a bot repair", async () => {
    fixture.sheets.pepper = sheet([card("orders", {})]);
    let rejectRun!: (error: Error) => void;
    fixture.api.mockImplementation((path: string) => path.endsWith("/run") ? new Promise((_resolve, reject) => { rejectRun = reject; }) : Promise.resolve(page));
    render();
    await settle();
    await typeAndRun("select incomplete");
    const signal = runRequests()[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    fixture.sheets.pepper = sheet([card("orders", { sql: "select 42", result: "q_repaired" })]);
    render();
    expect(signal.aborted).toBe(true);
    rejectRun(new Error("Late parser error"));
    await settle();
    expect(editorValue()).toBe("select 42");
    expect(host.querySelector('[data-testid="data-query-error"]')?.textContent).toBe("");
    expect(viewedResult().draftSql).toBeUndefined();
  });

  it("resizes the bottom dock with keyboard bounds without changing the query, caret or DOM", async () => {
    fixture.sheets.pepper = sheet([card("old", {}), card("orders", {})]);
    render();
    await settle();
    const editor = editorDom();
    const grid = host.querySelector('[role="region"]');
    await typeAndRun("select unfinished");
    editorView().dispatch({ selection: { anchor: 7, head: 10 } });
    const calls = runRequests().length;
    expect(calls).toBe(1);
    expect(separator().getAttribute("aria-controls")).toBe(dock().id);
    expect(separator().getAttribute("aria-valuenow")).toBe("152");
    expect(separator().getAttribute("aria-valuemin")).toBe("128");
    expect(separator().getAttribute("aria-valuemax")).toBe("414");
    expect(host.querySelector('[data-testid="data-result"]')?.nextElementSibling).toBe(separator());
    expect(separator().nextElementSibling).toBe(dock());
    resizeKey("ArrowUp");
    expect(dock().style.height).toBe("176px");
    resizeKey("ArrowUp", true);
    expect(dock().style.height).toBe("176px");
    for (let index = 0; index < 20; index++) resizeKey("ArrowUp");
    expect(separator().getAttribute("aria-valuenow")).toBe("414");
    for (let index = 0; index < 20; index++) resizeKey("ArrowDown");
    expect(separator().getAttribute("aria-valuenow")).toBe("128");
    expect(editorDom()).toBe(editor);
    expect(editorValue()).toBe("select unfinished");
    expect(editorView().state.selection.main).toMatchObject({ from: 7, to: 10 });
    expect(host.querySelector('[role="region"]')).toBe(grid);
    expect(runRequests()).toHaveLength(calls);
    selectHistory("old");
    expect(dock().style.height).toBe("128px");
  });

  it("captures a drag, ignores other pointers, and stops after cancellation or lost capture", async () => {
    fixture.sheets.pepper = sheet([card("orders", {})]);
    render();
    await settle();
    resizePointer("pointerdown", 400);
    expect(capturedPointers.has(1)).toBe(true);
    resizePointer("pointermove", 320, 2);
    expect(dock().style.height).toBe("152px");
    resizePointer("pointermove", 320);
    expect(dock().style.height).toBe("232px");
    resizePointer("pointercancel", 320);
    expect(capturedPointers.has(1)).toBe(false);
    resizePointer("pointermove", 200);
    expect(dock().style.height).toBe("232px");
    resizePointer("pointerdown", 320);
    resizePointer("pointermove", -1000);
    expect(dock().style.height).toBe("414px");
    resizePointer("lostpointercapture", -1000);
    resizePointer("pointermove", 1000);
    expect(dock().style.height).toBe("414px");
    expect(runRequests()).toHaveLength(0);
  });

  it("clamps a resized dock when its container shrinks and keeps the resized editor on fullscreen changes", async () => {
    fixture.sheets.pepper = sheet([card("orders", {})]);
    render();
    await settle();
    const editor = editorDom();
    resizePointer("pointerdown", 400);
    resizePointer("pointermove", 0);
    resizePointer("pointerup", 0);
    expect(dock().style.height).toBe("414px");
    resizePanel(360);
    expect(separator().getAttribute("aria-valuemax")).toBe("174");
    expect(separator().getAttribute("aria-valuenow")).toBe("174");
    toggleFullscreen("Enter fullscreen");
    resizePanel(900);
    expect(separator().getAttribute("aria-valuemax")).toBe("714");
    resizeKey("ArrowUp");
    expect(dock().style.height).toBe("198px");
    toggleFullscreen("Exit fullscreen");
    resizePanel(360);
    expect(dock().style.height).toBe("174px");
    expect(editorDom()).toBe(editor);
    expect(runRequests()).toHaveLength(0);
  });

  it("refreshes a mounted cached viewer after connection recovery", async () => {
    fixture.sheets.pepper = sheet([card("one", {})]);
    render();
    const requests = () => fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet").length;
    expect(requests()).toBe(1);
    fixture.connected = false;
    render();
    expect(requests()).toBe(1);
    fixture.connected = true;
    render();
    expect(requests()).toBe(2);
  });
  it("loads the sheet once on first open and says what to do while it is empty", async () => {
    render();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "loadDataSheet", botId: "pepper" }));
    expect(host.textContent).toContain("Loading data…");
    fixture.sheets = { pepper: sheet([]) };
    render();
    await settle();
    expect(host.querySelector('[data-testid="data-empty"]')?.textContent).toBe("Ask your bot to load a file, or write SQL below.");
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(1);
  });

  it("offers SQL on an empty sheet: the first run makes the card, which takes over without losing the typing", async () => {
    fixture.sheets = { pepper: sheet([]) };
    let answerCreate!: (body: unknown) => void;
    fixture.api.mockImplementation((path: string) => path.endsWith("/run") ? new Promise((resolve) => { answerCreate = resolve; }) : Promise.resolve(page));
    render();
    await settle();
    expect(editorValue()).toBe("");
    expect(viewedResult()).toBeNull();
    await typeAndRun("select 1");
    expect(runRequests()).toHaveLength(1);
    expect(JSON.parse(runRequests()[0]![1].body)).toEqual({ sql: "select 1" });
    expect(host.querySelector('[data-testid="data-result-footer"]')?.textContent).toContain("Running…");
    // Typed before the card arrives: no second card, the text waits for it.
    await typeAndRun("select 1 + 1");
    expect(runRequests()).toHaveLength(1);
    const created = card("c_new", { by: "person", status: "running", result: null, rowCount: undefined, sql: "select 1" });
    fixture.sheets = { pepper: sheet([created]) };
    render();
    await settle();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("c_new");
    expect(editorValue()).toBe("select 1 + 1");
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "c_new", draftSql: "select 1 + 1" });
    // The waiting text runs on the new card; with no result yet it is a plain re-run, not a live edit.
    expect(runRequests()).toHaveLength(2);
    expect(JSON.parse(runRequests()[1]![1].body)).toEqual({ cardId: "c_new", sql: "select 1 + 1" });
    answerCreate({ card: { id: "c_new" }, result: { id: "c_new" } });
    await settle();
    fixture.sheets = { pepper: sheet([{ ...created, status: "ready", result: "q_new", rowCount: 2, sql: "select 1 + 1" }]) };
    render();
    await settle();
    expect(editorValue()).toBe("select 1 + 1");
    expect(viewedResult()).toEqual({ botId: "pepper", threadId: "thread-1", cardId: "c_new" });
    await typeAndRun("select 2");
    expect(JSON.parse(runRequests()[2]![1].body)).toEqual({ cardId: "c_new", sql: "select 2", live: true });
    expect(host.querySelector('[data-testid="data-result-footer"]')?.textContent).toContain("Running…");
  });

  it("shows Cancel while a live run is on the wire; Cancel drops it and asks the server to stop the card", async () => {
    fixture.sheets = { pepper: sheet([card("orders", {})]) };
    holdRuns();
    render();
    await settle();
    expect(cancelButton()).toBeUndefined();
    await typeAndRun("select 2");
    const signal = runRequests()[0]![1].signal as AbortSignal;
    expect(host.querySelector('[data-testid="data-result-footer"]')?.textContent).toContain("Running…");
    expect(host.querySelector('[role="region"]')).not.toBeNull();
    flushSync(() => cancelButton()!.click());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(cancelRequests().map(([path, init]) => [path, init.method, JSON.parse(init.body)])).toEqual([["/api/bots/pepper/data/cancel", "POST", { cardId: "orders" }]]);
    expect(cancelButton()).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(editorValue()).toBe("select 2");
  });

  it("shows only the latest result, preserves history and keeps SQL and references in one dock", async () => {
    fixture.sheets = { pepper: sheet(
      [card("orders", { title: "Orders by month" }), card("note", { kind: "text", title: "Reading", text: "**Up** 12%", sql: undefined, result: null })],
      [{ name: "sales", kind: "csv", source: "/tmp/sales.csv", rowCount: 12345, loadedAt: now, columns: [{ name: "amount", type: "DOUBLE" }] }],
    ) };
    render();
    await settle();
    expect(host.querySelectorAll("article")).toHaveLength(1);
    expect(host.querySelector("article")?.getAttribute("aria-label")).toBe("Reading");
    expect(host.querySelector("article h3, article header")).toBeNull();
    // A text result has no SQL: the box is there, empty, for a new query.
    expect(editorValue()).toBe("");
    expect(host.querySelector('[data-testid="sources-strip"]')?.textContent).toContain("sales");
    expect(host.querySelector('[data-testid="markdown"]')?.textContent).toBe("**Up** 12%");
    expect(fixture.api).not.toHaveBeenCalled();
    selectHistory("Orders by month");
    await settle();
    const strip = host.querySelector('[data-testid="sources-strip"]')!;
    expect(strip.textContent).toContain("sales");
    expect(strip.textContent).toContain("12,345 rows");
    const cards = host.querySelectorAll("article");
    expect([...cards].map((node) => node.getAttribute("data-card-id"))).toEqual(["orders"]);
    expect(editorValue()).toBe("select * from orders");
    expect(host.querySelector('[data-testid="data-query"]')?.querySelectorAll('[role="textbox"][aria-label="SQL"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="data-query"]')?.querySelectorAll("button, pre")).toHaveLength(0);
    expect(host.querySelector('[data-testid="data-result-footer"] [data-testid="data-history"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="data-result-footer"] [aria-label="Export"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="data-result-footer"] [aria-label="Enter fullscreen"]')).not.toBeNull();
    expect(strip.querySelectorAll("button")).toHaveLength(0);
    // The table card paged its rows from the server; the text card did not.
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/pepper/data/page", expect.objectContaining({ method: "POST" }));
    expect(host.querySelector('[data-testid="data-card-table"]')?.textContent).toContain("3 rows");
    expect(fixture.embedLoaded).toBe(false);
  });

  it("draws a chart card with vega-embed loaded on demand and the reduced rows bound as \"table\"", async () => {
    const spec = { mark: "bar", encoding: { x: { field: "n", type: "quantitative" } } };
    fixture.sheets = { pepper: sheet([card("c", { kind: "chart", vegaLite: spec, reduction: { method: "group", inputRows: 1000, outputRows: 3 } })]) };
    expect(fixture.embedLoaded).toBe(false);
    render();
    await settle();
    expect(fixture.embedLoaded).toBe(true);
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    const [element, bound, options] = fixture.embed.mock.calls[0]!;
    expect(element).toBeInstanceOf(HTMLElement);
    expect(bound).toMatchObject({ mark: "bar", data: { name: "table" }, width: "container", datasets: { table: [{ n: 1 }, { n: 2 }, { n: 3 }] } });
    expect(options).toMatchObject({ actions: false });
    expect(host.textContent).toContain("Charted 3 of 1,000 rows, grouped");
    click("Table");
    await settle();
    expect(host.querySelector('[data-testid="data-chart"]')).toBeNull();
    expect(host.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Rows of c");
    expect(host.querySelectorAll("article")).toHaveLength(1);
    click("Chart");
    await settle();
    expect(fixture.embed).toHaveBeenCalledTimes(2);
  });

  it("shows a running card with Cancel, and Cancel asks the server to stop it", async () => {
    fixture.sheets = { pepper: sheet([card("slow", { status: "running", by: "person", result: null, rowCount: undefined })]) };
    render();
    await settle();
    expect(host.textContent).toContain("Running…");
    flushSync(() => cancelButton()!.click());
    await settle();
    expect(cancelRequests().map(([, init]) => JSON.parse(init.body))).toEqual([{ cardId: "slow" }]);
    expect(editorValue()).toBe("select * from slow");
    // Still editable: with no result to keep, an edit re-runs the card outright.
    const editor = editorDom();
    await typeAndRun("select 5");
    expect(JSON.parse(runRequests()[0]![1].body)).toEqual({ cardId: "slow", sql: "select 5" });
    fixture.sheets = { pepper: sheet([card("slow", { by: "person", sql: "select 5" })]) };
    render();
    await settle();
    expect(editorDom()).toBe(editor);
    expect(editorValue()).toBe("select 5");
    expect(cancelButton()).toBeUndefined();
  });

  it("shows DuckDB's own message on a failed result, with SQL still available", async () => {
    fixture.sheets = { pepper: sheet([card("bad", {
      status: "failed", result: null, sql: "selec 1",
      error: { code: "sql_error", message: 'Parser Error: syntax error at or near "selec"', sql: "selec 1", line: 1 },
    })]) };
    render();
    await settle();
    const error = host.querySelector('[data-testid="card-error"]')!;
    expect(error.textContent).toContain('Parser Error: syntax error at or near "selec"');
    expect(error.textContent).toContain("Line 1");
    expect(editorValue()).toBe("selec 1");
  });

  it("runs the text once typing pauses, latest text winning, and aborts the run a newer edit replaces", async () => {
    fixture.sheets = { pepper: sheet([card("orders", {})]) };
    holdRuns();
    render();
    await settle();
    // Five keystrokes inside the pause: one run, with the final text.
    for (const text of ["s", "se", "sel", "sele", "select 42"]) type(text);
    await settle();
    expect(runRequests()).toHaveLength(0);
    await pause(LIVE_RUN_DELAY_MS + 10);
    await settle();
    expect(runRequests()).toHaveLength(1);
    expect(JSON.parse(runRequests()[0]![1].body)).toEqual({ cardId: "orders", sql: "select 42", live: true });
    const firstSignal = runRequests()[0]![1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    // Two edits further apart than the pause: two runs, the first interrupted.
    await typeAndRun("select 43");
    expect(runRequests()).toHaveLength(2);
    expect(firstSignal.aborted).toBe(true);
    await typeAndRun("");
    expect(runRequests()).toHaveLength(3);
    expect(JSON.parse(runRequests()[2]![1].body)).toEqual({ cardId: "orders", sql: "", live: true });
    expect(editorValue()).toBe("");
    expect(host.querySelector('button[aria-label="Run"]')).toBeNull();
  });

  it("keeps typed SQL through broadcasts and prefills the newly selected result", async () => {
    fixture.sheets = { pepper: sheet([card("old", {}), card("orders", {})]) };
    holdRuns();
    render();
    await settle();
    expect(editorValue()).toBe("select * from orders");
    await typeAndRun("select * from orders limit 5");
    const signal = runRequests()[0]![1].signal as AbortSignal;
    fixture.sheets = { pepper: sheet([card("old", {}), card("orders", { sql: "select * from orders limit 1", updatedAt: "2026-10-09T12:00:00Z" })]) };
    render();
    expect(editorValue()).toBe("select * from orders limit 5");
    selectHistory("old");
    await settle();
    expect(editorValue()).toBe("select * from old");
    expect(signal.aborted).toBe(true);
  });

  it("keeps the same input, draft, caret and grid while entering and leaving fullscreen", async () => {
    fixture.sheets = { pepper: sheet([card("orders", {})]) };
    render();
    await settle();
    type("select unfinished");
    const editor = editorDom();
    const grid = host.querySelector('[role="region"]');
    editorView().dispatch({ selection: { anchor: 7, head: 10 } });
    toggleFullscreen("Enter fullscreen");
    await settle();
    expect(fullscreenElement).toBe(host.querySelector('[data-testid="data-panel"]'));
    expect(editorDom()).toBe(editor);
    expect(host.querySelector('[role="region"]')).toBe(grid);
    expect(editorView().state.selection.main).toMatchObject({ from: 7, to: 10 });
    toggleFullscreen("Exit fullscreen");
    await settle();
    expect(fullscreenElement).toBeNull();
    expect(editorDom()).toBe(editor);
    expect(editorValue()).toBe("select unfinished");
    toggleFullscreen("Enter fullscreen");
    await settle();
    fullscreenElement = null;
    flushSync(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(host.querySelector('button[aria-label="Enter fullscreen"]')).not.toBeNull();
    expect(editorDom()).toBe(editor);
  });

  it("reports fullscreen failure without replacing the input or its error slot", async () => {
    fixture.sheets = { pepper: sheet([card("orders", {})]) };
    render();
    await settle();
    const editor = editorDom();
    const error = host.querySelector('[data-testid="data-query-error"]');
    vi.mocked(HTMLElement.prototype.requestFullscreen).mockRejectedValueOnce(new Error("Unavailable"));
    toggleFullscreen("Enter fullscreen");
    await settle();
    expect(host.querySelector('[role="alert"]')).toBe(error);
    expect(error?.textContent).not.toBe("");
    expect(editorDom()).toBe(editor);
  });

  it("shows catalog table names and counts as plain references without extra controls", async () => {
    fixture.sheets = { pepper: sheet([card("orders", {})]) };
    fixture.tables = { pepper: [
      { name: "sales", rowCount: 2, columns: [{ name: "amount", type: "DOUBLE" }] },
      { name: "monthly sales", sqlName: '"monthly sales"', rowCount: 10, columns: [] },
    ] };
    render();
    await settle();
    expect(host.querySelectorAll("article")).toHaveLength(1);
    const details = host.querySelector('[data-testid="data-query"]')!;
    expect(details.textContent).toContain("sales");
    expect(details.textContent).toContain('"monthly sales"');
    expect(details.textContent).toContain("2 rows");
    expect(details.querySelectorAll("button, pre, aside")).toHaveLength(0);
    expect(details.querySelectorAll('[role="textbox"][aria-label="SQL"]')).toHaveLength(1);
    expect(fixture.api.mock.calls.some(([path]) => path.endsWith("/stats"))).toBe(false);
  });

  it("keeps the last good chart during incomplete edits and suppresses blank-query errors", async () => {
    fixture.sheets = { pepper: sheet([card("chart", { kind: "chart", chart: { type: "bar", x: "n" }, vegaLite: { mark: "bar" } })]) };
    render();
    await settle();
    fixture.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/run")) throw new Error("Parser Error: incomplete SQL");
      return page;
    });
    const error = host.querySelector('[data-testid="data-query-error"]');
    const editor = editorDom();
    await typeAndRun("select");
    expect(JSON.parse(runRequests()[0]![1].body)).toEqual({ cardId: "chart", sql: "select", live: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Parser Error: incomplete SQL");
    expect(host.querySelector('[role="alert"]')).toBe(error);
    expect(editorDom()).toBe(editor);
    expect(host.querySelector('[data-testid="data-chart"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="card-error"]')).toBeNull();
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    await typeAndRun("");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-testid="data-query-error"]')).toBe(error);
    expect(editorDom()).toBe(editor);
    expect(host.querySelector('[data-testid="data-chart"]')).not.toBeNull();
  });

  it("ignores errors from superseded edits and aborts a pending edit when switching history", async () => {
    fixture.sheets = { pepper: sheet([card("old", {}), card("orders", {})]) };
    render();
    await settle();
    let rejectOld!: (error: Error) => void;
    holdRuns().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    await typeAndRun("select incomplete");
    await typeAndRun("select 1");
    rejectOld(new Error("Old query error"));
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(editorValue()).toBe("select 1");
    const latestSignal = runRequests()[1]![1].signal as AbortSignal;
    selectHistory("old");
    await settle();
    expect(latestSignal.aborted).toBe(true);
    expect(editorValue()).toBe("select * from old");
  });

  it("follows updated results but keeps an explicit History selection through broadcasts", async () => {
    const old = card("old", { createdAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z", pinned: true });
    const newer = card("new", {});
    fixture.sheets = { pepper: sheet([old, newer]) };
    render();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("new");
    selectHistory("old");
    fixture.sheets = { pepper: { ...sheet([old, newer]), updatedAt: "2026-10-09T11:00:00Z" } };
    render();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
    fixture.sheets = { pepper: sheet([old, newer, card("newest", { updatedAt: "2026-10-09T12:00:00Z" })]) };
    render();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
    selectHistory("Latest result");
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("newest");
    fixture.sheets = { pepper: sheet([{ ...old, updatedAt: "2026-10-09T13:00:00Z" }, newer]) };
    render();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
    expect(fixture.dispatch.mock.calls.every(([action]) => ["loadDataSheet", "dataView"].includes(action.type))).toBe(true);
  });

  it("opens an exact older result requested from chat, including repeated requests", async () => {
    fixture.sheets = { pepper: sheet([card("old", {}), card("new", {})]) };
    render({ id: "old", requestId: 1 });
    await settle();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
    selectHistory("new");
    render({ id: "old", requestId: 2 });
    await settle();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
  });

  it("reports an unavailable requested result without opening a different result", async () => {
    fixture.sheets = { pepper: sheet([card("latest", {})]) };
    render({ id: "removed", requestId: 1 });
    await settle();
    expect(host.querySelector("article")).toBeNull();
    expect(host.textContent).toContain("This result is no longer available.");
    selectHistory("Latest result");
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("latest");
  });

  it("refreshes cached sheets on mount and when a new chat request is missing, preserving selection", async () => {
    fixture.sheets = { pepper: sheet([card("old", {}), card("latest", {})]) };
    render();
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(1);
    selectHistory("old");
    fixture.sheets = { pepper: sheet([card("old", {}), card("latest", {}), card("newest", {})]) };
    render();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("old");
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(1);

    render({ id: "missing", requestId: 1 });
    await settle();
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(2);
    expect(host.querySelector("article")).toBeNull();
    fixture.sheets = { pepper: sheet([card("missing", {}), card("newest", {})]) };
    render({ id: "missing", requestId: 1 });
    await settle();
    expect(host.querySelector("article")?.getAttribute("data-card-id")).toBe("missing");
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(2);
  });

  it("refreshes chart rows when a result is updated without changing its spec or row count", async () => {
    const result = card("c", { kind: "chart", vegaLite: { mark: "bar" } });
    fixture.sheets = { pepper: sheet([result]) };
    render();
    await settle();
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    fixture.api.mockResolvedValue({ ...page, rows: [["9"], ["8"], ["7"]] });
    fixture.sheets = { pepper: sheet([{ ...result, result: "q_updated" }]) };
    render();
    await settle();
    expect(fixture.embed).toHaveBeenCalledTimes(2);
    expect(fixture.embed.mock.calls[1]![1]).toMatchObject({ datasets: { table: [{ n: 9 }, { n: 8 }, { n: 7 }] } });
    // Unrelated broadcasts leave the active chart alone.
    fixture.sheets = { pepper: { ...fixture.sheets.pepper!, updatedAt: "2026-10-09T12:00:00Z" } };
    render();
    await settle();
    expect(fixture.embed).toHaveBeenCalledTimes(2);
  });
});
