// @vitest-environment happy-dom
// Datasource contracts and real AG Grid lifecycle; the isolated fixture checks browser interactions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, createRef, StrictMode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { GridApi, IGetRowsParams } from "ag-grid-community";
import { DATA_LIMITS, type DataColumn, type DataPage, type DataPageRequest } from "../../../shared/data-surface";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { createDataGridDatasource, DataGrid, type DataGridHandle } from "./DataGrid";

const PAGE = DATA_LIMITS.pageSize;
const TOTAL = 5000;
const columns: DataColumn[] = [{ name: "id", type: "BIGINT" }, { name: "display.name", type: "VARCHAR" }];
const answer = (request: DataPageRequest): DataPage => ({
  columns, rowCount: request.filter ? 7 : TOTAL, offset: request.offset,
  rows: Array.from({ length: Math.max(0, Math.min(request.limit, (request.filter ? 7 : TOTAL) - request.offset)) }, (_, index) => [String(request.offset + index), `row ${request.offset + index}`]),
});

describe("AG Grid component lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handle: RefObject<DataGridHandle | null>;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    handle = createRef<DataGridHandle>();
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const render = (revision: string, strict = false, schema = columns) => flushSync(() => {
    const grid = createElement(DataGrid, { botId: "pepper", target: { cardId: "c1" }, columns: schema, rowCount: TOTAL, name: "Orders", revision, handle });
    root.render(strict ? createElement(StrictMode, null, grid) : grid);
  });

  it("loads in the app's StrictMode lifecycle rather than keeping a destroyed datasource", async () => {
    render("initial", true);
    await vi.waitFor(() => expect(host.querySelector('.ag-row[row-index="0"]')?.textContent).toContain("row 0"));
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Copy rows"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("reloads same-count revisions but not unrelated renders", async () => {
    render("before");
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalled());
    const first = fixture.api.mock.calls.length;
    render("after");
    await vi.waitFor(() => expect(fixture.api.mock.calls.length).toBeGreaterThan(first));
    const second = fixture.api.mock.calls.length;
    render("after");
    await settle();
    expect(fixture.api).toHaveBeenCalledTimes(second);
  });

  it("exposes loaded visible rows to the footer's Markdown export", async () => {
    render("export");
    await vi.waitFor(() => expect(handle.current?.visibleRows().rows).toContainEqual(["0", "row 0"]));
    expect(handle.current?.visibleRows().columns).toEqual(["id", "display.name"]);
    expect(handle.current!.visibleRows().rows.length).toBeLessThan(PAGE);
  });

  it("filters a selected column, switches back to global search and clears", async () => {
    render("filters");
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalled());
    const click = (label: string) => flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === label)!.click());
    expect(host.querySelector('input[aria-label="Filter rows"]')).toBeNull();
    click("Filter"); click("display.name");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter value"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "row");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    await vi.waitFor(() => expect(bodies().at(-1)).toMatchObject({ filter: "row", filterColumn: "display.name" }));
    click("Choose column"); click("All columns");
    await vi.waitFor(() => expect(bodies().at(-1)).toMatchObject({ filter: "row" }));
    await vi.waitFor(() => expect(bodies().at(-1)?.filterColumn).toBeUndefined());
    click("Clear filter");
    await vi.waitFor(() => expect(bodies().at(-1)?.filter).toBeUndefined());
    expect(bodies().at(-1)?.filterColumn).toBeUndefined();
  });

  it("drops a removed filter column synchronously when a SQL edit changes the schema", async () => {
    render("before");
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalled());
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click());
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="display.name"]')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter value"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "row");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    await vi.waitFor(() => expect(bodies().at(-1)?.filterColumn).toBe("display.name"));
    const before = fixture.api.mock.calls.length;
    render("after", false, [{ name: "id", type: "BIGINT" }]);
    await vi.waitFor(() => expect(fixture.api.mock.calls.length).toBeGreaterThan(before));
    expect(bodies().slice(before).every((body) => body.filter === undefined && body.filterColumn === undefined)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Filter value"]')?.value).toBe("");
    expect(host.querySelector('button[aria-label="Filter"]')?.getAttribute("data-active")).toBe("false");
  });
});
const settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
let current: boolean;
let sources: Array<ReturnType<typeof createDataGridDatasource>>;
const onPage = vi.fn();
const onError = vi.fn();
const create = (filter = "", target: { cardId: string } | { table: string } = { cardId: "c1" }, filterColumn?: string) => {
  const source = createDataGridDatasource({ botId: "pepper", target, columns, rowCount: TOTAL, filter, filterColumn, isCurrent: () => current, onPage, onError });
  sources.push(source);
  return source;
};
const request = (source: ReturnType<typeof create>, startRow = 0, sortModel: IGetRowsParams["sortModel"] = []) => {
  const successCallback = vi.fn();
  const failCallback = vi.fn();
  source.getRows({ startRow, endRow: startRow + PAGE, sortModel, filterModel: {}, successCallback, failCallback, api: {} as GridApi, context: undefined });
  return { successCallback, failCallback };
};
const bodies = () => fixture.api.mock.calls.map(([, init]) => JSON.parse(init.body) as DataPageRequest);

beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  sources = [];
  fixture.api.mockImplementation(async (_path: string, init: RequestInit) => answer(JSON.parse(String(init.body))));
});
afterEach(() => sources.forEach((source) => source.destroy?.()));

describe("AG Grid DuckDB datasource", () => {
  it("requests bounded blocks directly without loading intermediate rows", async () => {
    const source = create();
    const first = request(source);
    const deep = request(source, PAGE * 3);
    await settle();
    expect(bodies().map((body) => body.offset)).toEqual([0, PAGE * 3]);
    expect(bodies().every((body) => body.limit <= PAGE)).toBe(true);
    expect(fixture.api.mock.calls[0]).toEqual(["/api/bots/pepper/data/page", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })]);
    expect(first.successCallback).toHaveBeenCalledWith(expect.arrayContaining([{ index: 0, cells: ["0", "row 0"] }]), TOTAL);
    expect(deep.successCallback).toHaveBeenCalledWith(expect.arrayContaining([{ index: PAGE * 3, cells: [String(PAGE * 3), `row ${PAGE * 3}`] }]), TOTAL);
    expect(first.failCallback).not.toHaveBeenCalled();
  });

  it("clips the last block and supports a named source table", async () => {
    const done = request(create("", { table: "sales" }), PAGE * 4);
    await settle();
    expect(bodies()[0]).toEqual({ table: "sales", offset: PAGE * 4, limit: TOTAL - PAGE * 4 });
    expect(done.successCallback).toHaveBeenCalledWith(expect.any(Array), TOTAL);
  });

  it("sends sorting and global search to DuckDB, not the loaded subset", async () => {
    const done = request(create("row"), 0, [{ colId: "display.name", sort: "desc" }]);
    await settle();
    expect(bodies()[0]).toMatchObject({ offset: 0, filter: "row", sort: { column: "display.name", direction: "desc" } });
    expect(done.successCallback).toHaveBeenCalledWith(expect.any(Array), 7);
  });

  it("sends an exact column name with contains text and omits scope when cleared", async () => {
    request(create("99", { cardId: "c1" }, "display.name"));
    await settle();
    expect(bodies()[0]).toMatchObject({ filter: "99", filterColumn: "display.name" });
    request(create("", { cardId: "c1" }, "display.name"));
    await settle();
    expect(bodies()[1]).not.toHaveProperty("filterColumn");
    expect(bodies()[1]).not.toHaveProperty("filter");
  });

  it("does not send a removed column's stale sort after a schema change", async () => {
    request(create(), 0, [{ colId: "removed", sort: "asc" }]);
    await settle();
    expect(bodies()[0]?.sort).toBeUndefined();
  });

  it("preserves large integers, decimals, nulls, booleans and text without coercion", async () => {
    const cells = ["9223372036854775807", "9999999999999.123456", null, false, "<script>not HTML</script>"];
    fixture.api.mockResolvedValue({ columns, rows: [cells], offset: 0, rowCount: 1 });
    const done = request(create());
    await settle();
    expect(done.successCallback).toHaveBeenCalledWith([{ index: 0, cells }], 1);
  });

  it("reports an empty result with an exact count", async () => {
    fixture.api.mockResolvedValue({ columns, rows: [], offset: 0, rowCount: 0 });
    const done = request(create("not present"));
    await settle();
    expect(done.successCallback).toHaveBeenCalledWith([], 0);
    expect(done.failCallback).not.toHaveBeenCalled();
  });

  it("reports failure once and permits a successful block retry", async () => {
    fixture.api.mockRejectedValueOnce(new Error("DuckDB unavailable"));
    const source = create();
    const failed = request(source);
    await settle();
    expect(failed.failCallback).toHaveBeenCalledTimes(1);
    expect(failed.successCallback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("DuckDB unavailable");
    const retry = request(source);
    await settle();
    expect(retry.successCallback).toHaveBeenCalledTimes(1);
    expect(retry.failCallback).not.toHaveBeenCalled();
  });

  it("settles destroyed requests once and discards their late result", async () => {
    let resolve!: (page: DataPage) => void;
    fixture.api.mockImplementationOnce(() => new Promise<DataPage>((done) => { resolve = done; }));
    const source = create();
    const old = request(source);
    const signal = fixture.api.mock.calls[0]![1].signal as AbortSignal;
    source.destroy?.();
    expect(signal.aborted).toBe(true);
    expect(old.failCallback).toHaveBeenCalledTimes(1);
    resolve(answer({ cardId: "c1", offset: 0, limit: PAGE }));
    await settle();
    expect(old.successCallback).not.toHaveBeenCalled();
    expect(old.failCallback).toHaveBeenCalledTimes(1);
    expect(onPage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    const deferred = request(source);
    expect(deferred.failCallback).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it("ignores late errors once the result revision changes but releases the loader", async () => {
    let reject!: (cause: Error) => void;
    fixture.api.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    const old = request(create());
    current = false;
    reject(new Error("Stale revision"));
    await settle();
    expect(old.successCallback).not.toHaveBeenCalled();
    expect(old.failCallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("invalidates in-flight blocks when sorting changes on the same datasource", async () => {
    let resolve!: (page: DataPage) => void;
    fixture.api.mockImplementationOnce(() => new Promise<DataPage>((done) => { resolve = done; }));
    const source = create();
    const old = request(source, 0, [{ colId: "id", sort: "asc" }]);
    const signal = fixture.api.mock.calls[0]![1].signal as AbortSignal;
    const newer = request(source, 0, [{ colId: "id", sort: "desc" }]);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(newer.successCallback).toHaveBeenCalledTimes(1);
    resolve({ ...answer({ cardId: "c1", offset: 0, limit: PAGE }), rows: [["stale", "stale"]] });
    await settle();
    expect(old.successCallback).not.toHaveBeenCalled();
    expect(old.failCallback).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
  });
});
