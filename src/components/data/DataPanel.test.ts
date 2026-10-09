// @vitest-environment happy-dom
// The Data tab shows the sheet the store holds: the loaded tables, every
// card with its result, SQL and controls, and the person's own SQL box. The
// heavy renderers (vega-embed, CodeMirror) load only when something needs
// them.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataCard, DataPage, DataSheet } from "../../../shared/data-surface";
import type { Bot } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  sheets: {} as Record<string, DataSheet>,
  dispatch: vi.fn(),
  api: vi.fn(),
  embedLoaded: false,
  embed: vi.fn(),
  appendComposerDraft: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { dataSheets: fixture.sheets }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/drafts", () => ({ appendComposerDraft: fixture.appendComposerDraft }));
vi.mock("../ChatMarkdown", () => ({ ChatMarkdown: ({ text }: { text: string }) => createElement("div", { "data-testid": "markdown" }, text) }));
vi.mock("vega-embed", () => {
  fixture.embedLoaded = true;
  return { default: fixture.embed };
});
// The editor's chunk fails to load here: the plain box must keep working.
vi.mock("codemirror", () => { throw new Error("no editor in this test"); });
vi.mock("@codemirror/lang-sql", () => ({}));
import { DataPanel } from "./DataPanel";

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
const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = () => flushSync(() => root.render(createElement(DataPanel, { bot })));
const textarea = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
const type = (text: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
  flushSync(() => textarea().dispatchEvent(new Event("input", { bubbles: true })));
};
const press = (key: string, modifiers: Partial<KeyboardEventInit> = {}) =>
  flushSync(() => textarea().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers })));

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  fixture.sheets = {};
  fixture.embedLoaded = false;
  fixture.embed.mockResolvedValue({ view: { resize: () => ({ runAsync: async () => undefined }) }, finalize: vi.fn() });
  fixture.api.mockResolvedValue(page);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 360; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 800; } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  flushSync(() => root.unmount());
  host.remove();
  await settle();
});

describe("DataPanel", () => {
  it("loads the sheet once on first open and says what to do while it is empty", async () => {
    render();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "loadDataSheet", botId: "pepper" }));
    expect(host.textContent).toContain("Loading data…");
    fixture.sheets = { pepper: sheet([]) };
    render();
    await settle();
    expect(host.querySelector('[data-testid="data-empty"]')?.textContent).toBe("Ask your bot to load a file, or run SQL below.");
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "loadDataSheet")).toHaveLength(1);
  });

  it("shows the loaded tables with row counts and every card with its title and SQL", async () => {
    fixture.sheets = { pepper: sheet(
      [card("orders", { title: "Orders by month" }), card("note", { kind: "text", title: "Reading", text: "**Up** 12%", sql: undefined, result: null })],
      [{ name: "sales", kind: "csv", source: "/tmp/sales.csv", rowCount: 12345, loadedAt: now, columns: [{ name: "amount", type: "DOUBLE" }] }],
    ) };
    render();
    await settle();
    const strip = host.querySelector('[data-testid="sources-strip"]')!;
    expect(strip.textContent).toContain("sales");
    expect(strip.textContent).toContain("12,345 rows");
    const cards = host.querySelectorAll("article");
    expect([...cards].map((node) => node.querySelector("h3")?.textContent)).toEqual(["Orders by month", "Reading"]);
    expect(host.querySelector('[data-testid="card-sql"] pre')?.textContent).toBe("select * from orders");
    expect(host.querySelector('[data-testid="markdown"]')?.textContent).toBe("**Up** 12%");
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
  });

  it("shows a running card with Cancel, and Cancel asks the server to stop it", async () => {
    fixture.sheets = { pepper: sheet([card("slow", { status: "running", by: "person", result: null, rowCount: undefined })]) };
    render();
    await settle();
    expect(host.textContent).toContain("Running…");
    const cancel = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
    flushSync(() => cancel.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "cancelDataCard", botId: "pepper", cardId: "slow" });
    // Esc in the SQL box cancels the person's running card too.
    press("Escape");
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "cancelDataCard")).toHaveLength(2);
  });

  it("shows DuckDB's own message on a failed card, with the SQL open", async () => {
    fixture.sheets = { pepper: sheet([card("bad", {
      status: "failed", result: null, sql: "selec 1",
      error: { code: "sql_error", message: 'Parser Error: syntax error at or near "selec"', sql: "selec 1", line: 1 },
    })]) };
    render();
    await settle();
    const error = host.querySelector('[data-testid="card-error"]')!;
    expect(error.textContent).toContain('Parser Error: syntax error at or near "selec"');
    expect(error.textContent).toContain("Line 1");
    expect(host.querySelector<HTMLDetailsElement>('[data-testid="card-sql"]')!.open).toBe(true);
    expect(host.querySelector('[data-testid="card-sql"] pre')?.textContent).toBe("selec 1");
  });

  it("runs the typed SQL on Cmd/Ctrl+Enter and on the Run button, as a new card", async () => {
    fixture.sheets = { pepper: sheet([]) };
    render();
    await settle();
    type("select 42");
    press("Enter", { metaKey: true });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "runDataSql", botId: "pepper", request: { sql: "select 42" } }));
    expect(textarea().value).toBe("");
    type("select 43");
    press("Enter", { ctrlKey: true });
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "runDataSql")).toHaveLength(2);
    type("  ");
    press("Enter", { metaKey: true });
    expect(fixture.dispatch.mock.calls.filter(([action]) => action.type === "runDataSql")).toHaveLength(2);
    type("select 44");
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ request: { sql: "select 44" } }));
  });

  it("Edit puts a card's SQL in the box and the next run updates that card", async () => {
    fixture.sheets = { pepper: sheet([card("orders", { title: "Orders" })]) };
    render();
    await settle();
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click());
    await settle();
    expect(textarea().value).toBe("select * from orders");
    expect(host.textContent).toContain("Editing “Orders”");
    type("select * from orders limit 5");
    press("Enter", { metaKey: true });
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "runDataSql", request: { sql: "select * from orders limit 5", cardId: "orders" } }));
    expect(textarea().value).toBe("select * from orders limit 5");
    press("Escape");
    expect(host.textContent).not.toContain("Editing");
  });

  it("\"Ask to change\" puts the card's id into the bot's composer; pin and remove go to the server", async () => {
    fixture.sheets = { pepper: sheet([card("c7", {})]) };
    render();
    await settle();
    flushSync(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Ask to change")!.click());
    expect(fixture.appendComposerDraft).toHaveBeenCalledWith("bot:pepper:thread-1", "Change card c7: ");
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Pin"]')!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "patchDataCard", botId: "pepper", cardId: "c7", patch: { pinned: true } });
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove card"]')!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteDataCard", botId: "pepper", cardId: "c7" });
  });

  it("opens a loaded table as a grid and in the column explorer", async () => {
    fixture.api.mockImplementation(async (path: string) => path.endsWith("/stats")
      ? { table: "sales", rowCount: 2, columns: [{ name: "amount", type: "DOUBLE", nullPct: 0, approxUnique: 2, min: "1", max: "9" }] }
      : page);
    fixture.sheets = { pepper: sheet([], [{ name: "sales", kind: "csv", source: "/tmp/sales.csv", rowCount: 2, loadedAt: now, columns: [{ name: "amount", type: "DOUBLE" }] }]) };
    render();
    await settle();
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Open table sales"]')!.click());
    await settle();
    expect(host.querySelector('[data-testid="data-source-view"] h3')?.textContent).toBe("sales");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/pepper/data/page", expect.objectContaining({ body: expect.stringContaining('"table":"sales"') }));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/pepper/data/tables/sales/stats");
    const explorer = host.querySelector('[data-testid="column-explorer"]')!;
    expect(explorer.textContent).toContain("amount");
    expect(explorer.textContent).toContain("0% null");
    expect(explorer.textContent).toContain("2 distinct");
    expect(explorer.textContent).toContain("1 to 9");
  });
});
