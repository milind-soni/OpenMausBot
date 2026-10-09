// @vitest-environment happy-dom
// The grid keeps no rows of its own: it asks the server for pageSize windows
// around what is on screen, sends sort and filter with every page, and
// starts an empty cache when either changes.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_LIMITS, type DataColumn, type DataPage, type DataPageRequest } from "../../../shared/data-surface";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  requests: [] as DataPageRequest[],
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/copy-text", () => ({ copyText: vi.fn(async () => "copied") }));
import { DataGrid } from "./DataGrid";

const PAGE = DATA_LIMITS.pageSize;
const TOTAL = 5000;
const columns: DataColumn[] = [{ name: "id", type: "BIGINT" }, { name: "name", type: "VARCHAR" }];
const answer = (request: DataPageRequest): DataPage => ({
  columns,
  rowCount: request.filter ? 7 : TOTAL,
  offset: request.offset,
  rows: Array.from({ length: Math.min(request.limit, (request.filter ? 7 : TOTAL) - request.offset) }, (_, index) => [String(request.offset + index), `row ${request.offset + index}`]),
});

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const region = () => host.querySelector<HTMLDivElement>('[role="region"]')!;
const render = () => flushSync(() => root.render(createElement(DataGrid, { botId: "pepper", target: { cardId: "c1" }, columns, rowCount: TOTAL, name: "Sales" })));
const scrollTo = async (top: number) => {
  region().scrollTop = top;
  flushSync(() => region().dispatchEvent(new Event("scroll")));
  await settle();
};

beforeEach(() => {
  setLocale("en");
  fixture.requests = [];
  fixture.api.mockReset().mockImplementation(async (_path: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as DataPageRequest;
    fixture.requests.push(request);
    return answer(request);
  });
  // happy-dom lays nothing out; the virtualizer reads these for its window.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return (this as HTMLElement).getAttribute("role") === "region" ? 360 : 32; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 800; } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("DataGrid paging", () => {
  it("asks for the first page around the top of the result, never more than pageSize rows", async () => {
    render();
    await settle();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ cardId: "c1", offset: 0, limit: PAGE });
    expect(fixture.requests[0]!.sort).toBeUndefined();
    expect(fixture.requests[0]!.filter).toBeUndefined();
    expect(fixture.api.mock.calls[0]![0]).toBe("/api/bots/pepper/data/page");
    expect(host.textContent).toContain("row 0");
    expect(host.textContent).toContain("5,000 rows");
  });

  it("fetches the pages around a deep scroll position and nothing in between", async () => {
    render();
    await settle();
    // Row 3,200 is on page 3; the window around it stays inside that page.
    await scrollTo(3200 * 32);
    const offsets = fixture.requests.map((request) => request.offset);
    expect(offsets).toEqual([0, 3 * PAGE]);
    for (const request of fixture.requests) expect(request.limit).toBeLessThanOrEqual(PAGE);
    expect(host.textContent).toContain("row 3200");
    // Scrolling back to a loaded page asks for nothing new.
    await scrollTo(0);
    expect(fixture.requests).toHaveLength(2);
  });

  it("clips the last page to the result's end", async () => {
    render();
    await settle();
    await scrollTo((TOTAL - 5) * 32);
    const last = fixture.requests.at(-1)!;
    expect(last.offset).toBe(4 * PAGE);
    expect(last.limit).toBe(TOTAL - 4 * PAGE);
  });

  it("sorts on the server: a header click restarts paging with the sort in the body", async () => {
    render();
    await settle();
    await scrollTo(3200 * 32);
    const header = host.querySelector<HTMLButtonElement>('button[aria-label="Sort by name"]')!;
    flushSync(() => header.click());
    await settle();
    const sorted = fixture.requests.slice(2);
    expect(sorted.length).toBeGreaterThan(0);
    expect(sorted[0]).toMatchObject({ offset: 0, sort: { column: "name", direction: "asc" } });
    expect(host.querySelector('th[aria-sort="ascending"]')?.textContent).toContain("name");
    flushSync(() => header.click());
    await settle();
    expect(fixture.requests.at(-1)!.sort).toEqual({ column: "name", direction: "desc" });
    flushSync(() => header.click());
    await settle();
    expect(fixture.requests.at(-1)!.sort).toBeUndefined();
  });

  it("filters on the server after a short pause and shows the narrowed count", async () => {
    render();
    await settle();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter rows"]')!;
    const type = (text: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    };
    // Two keystrokes inside the pause are one query, sent after it.
    type("r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    type("ro");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.requests.some((request) => request.filter)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    const filtered = fixture.requests.filter((request) => request.filter);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ offset: 0, limit: PAGE, filter: "ro" });
    expect(host.textContent).toContain("7 of 5,000 rows");
  });

  it("shows the server's own message when a page fails", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Catalog Error: Table with name q_1 does not exist!"));
    render();
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Catalog Error: Table with name q_1 does not exist!");
  });
});
