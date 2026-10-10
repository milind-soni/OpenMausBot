// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataPage } from "../../../shared/data-surface";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), embed: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("vega-embed", () => ({ default: fixture.embed }));
import { DataChart } from "./DataChart";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const view = () => ({ view: { height: vi.fn(), resize: vi.fn(() => ({ runAsync: vi.fn().mockResolvedValue(undefined) })) }, finalize: vi.fn() });
const draw = (element: HTMLElement, label: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("data-chart-render", label);
  element.append(svg);
  return svg;
};
const page: DataPage = { columns: [{ name: "n", type: "INTEGER" }], rows: [[1]], rowCount: 1, offset: 0 };
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let viewportHeight: number;
let candidateHeight: number;
let observer: { callback: () => void; observe: (element: Element) => void; disconnect: () => void };
const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (revision: string, spec: Record<string, unknown> = { mark: "bar" }) => flushSync(() => root.render(createElement(DataChart, {
  botId: "bot", cardId: "c_1", spec, rowCount: 1, theme: "light", revision,
})));
const chart = (label: string) => host.querySelector<SVGElement>(`[data-chart-render="${label}"]`);

beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset().mockResolvedValue(page);
  fixture.embed.mockReset();
  viewportHeight = 0;
  candidateHeight = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.className === "relative h-full w-full" ? viewportHeight : candidateHeight;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { observer = { callback, observe: vi.fn(), disconnect: vi.fn() }; }
    observe(element: Element) { observer.observe(element); }
    disconnect() { observer.disconnect(); }
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) flushSync(() => root.unmount());
  host.remove();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataChart refresh", () => {
  it("caps chart height to its viewport and restores its natural height without reloading rows", async () => {
    const rendered = view();
    viewportHeight = 180;
    fixture.embed.mockImplementationOnce(async (element: HTMLElement) => { draw(element, "chart"); return rendered; });
    render("first", { mark: "line", height: 280 });
    await settle();
    expect(fixture.embed.mock.calls[0]![1]).toMatchObject({ height: 180, autosize: { type: "fit", contains: "padding" } });
    const original = chart("chart");
    viewportHeight = 800;
    observer.callback();
    expect(rendered.view.height).toHaveBeenLastCalledWith(280);
    viewportHeight = 120;
    observer.callback();
    expect(rendered.view.height).toHaveBeenLastCalledWith(120);
    expect(chart("chart")).toBe(original);
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    expect(rendered.finalize).not.toHaveBeenCalled();
  });

  it("fits a chart's measured default height and cleans up if unmounted during sizing", async () => {
    const pending = deferred<void>();
    const rendered = view();
    rendered.view.resize.mockReturnValue({ runAsync: vi.fn().mockReturnValue(pending.promise) });
    viewportHeight = 180;
    candidateHeight = 300;
    fixture.embed.mockImplementationOnce(async (element: HTMLElement) => { draw(element, "pending"); return rendered; });
    render("first");
    await settle();
    expect(rendered.view.height).toHaveBeenCalledWith(180);
    expect(chart("pending")?.parentElement?.style.visibility).toBe("hidden");
    flushSync(() => root.unmount());
    mounted = false;
    expect(rendered.finalize).toHaveBeenCalledTimes(1);
    pending.resolve();
    await settle();
    expect(rendered.finalize).toHaveBeenCalledTimes(1);
    expect(host.children).toHaveLength(0);
  });

  it("refits a staged chart if the dock moves again during asynchronous sizing", async () => {
    const first = view();
    const next = view();
    const embedded = deferred<ReturnType<typeof view>>();
    const firstSize = deferred<void>();
    const secondSize = deferred<void>();
    next.view.resize
      .mockReturnValueOnce({ runAsync: vi.fn().mockReturnValue(firstSize.promise) })
      .mockReturnValueOnce({ runAsync: vi.fn().mockReturnValue(secondSize.promise) });
    fixture.embed
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "first"); return first; })
      .mockImplementationOnce((element: HTMLElement) => { draw(element, "next"); return embedded.promise; });
    viewportHeight = 280;
    render("first", { mark: "line", height: 280 });
    await settle();
    const original = chart("first")!;
    render("next", { mark: "line", height: 280 });
    await settle();
    viewportHeight = 240;
    embedded.resolve(next);
    await settle();
    expect(next.view.height).toHaveBeenLastCalledWith(240);
    viewportHeight = 120;
    observer.callback();
    firstSize.resolve();
    await settle();
    expect(next.view.height.mock.calls).toEqual([[240], [120]]);
    expect(original.isConnected).toBe(true);
    expect(chart("next")?.parentElement?.style.visibility).toBe("hidden");
    secondSize.resolve();
    await settle();
    expect(original.isConnected).toBe(false);
    expect(chart("next")?.parentElement?.style.visibility).toBe("");
    expect(first.finalize).toHaveBeenCalledTimes(1);
    expect(next.finalize).not.toHaveBeenCalled();
  });

  it("keeps the last rendered chart in flow while rows and an attached full-width replacement load", async () => {
    const first = view();
    fixture.embed.mockImplementationOnce(async (element: HTMLElement) => { draw(element, "first"); return first; });
    render("first");
    await settle();
    const original = chart("first")!;
    const rows = deferred<DataPage>();
    const rendered = deferred<ReturnType<typeof view>>();
    const second = view();
    fixture.api.mockReturnValueOnce(rows.promise);
    fixture.embed.mockImplementationOnce((element: HTMLElement) => { draw(element, "second"); return rendered.promise; });
    render("second");
    await settle();
    expect(original.isConnected).toBe(true);
    expect(first.finalize).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(original.parentElement?.style.position).toBe("");
    rows.resolve(page);
    await settle();
    const candidate = chart("second")!.parentElement!;
    expect(candidate.isConnected).toBe(true);
    expect(candidate.parentElement).toBe(original.parentElement?.parentElement);
    expect(candidate.style).toMatchObject({ position: "absolute", width: "100%", visibility: "hidden" });
    expect(candidate.getAttribute("aria-hidden")).toBe("true");
    expect(original.isConnected).toBe(true);
    observer.callback();
    expect(first.view.resize).toHaveBeenCalledTimes(1);
    rendered.resolve(second);
    await settle();
    expect(original.isConnected).toBe(false);
    expect(first.finalize).toHaveBeenCalledTimes(1);
    expect(candidate.style.visibility).toBe("");
    expect(candidate.style.position).toBe("");
    expect(candidate.hasAttribute("aria-hidden")).toBe(false);
    expect(host.querySelectorAll("svg")).toHaveLength(1);
    observer.callback();
    expect(second.view.resize).toHaveBeenCalledTimes(1);
    expect(observer.observe).toHaveBeenCalledTimes(1);
  });

  it("finalizes stale render completions without replacing the latest chart", async () => {
    const first = view();
    const stale = view();
    const latest = view();
    const pending = deferred<ReturnType<typeof view>>();
    fixture.embed
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "first"); return first; })
      .mockImplementationOnce((element: HTMLElement) => { draw(element, "stale"); return pending.promise; })
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "latest"); return latest; });
    render("first");
    await settle();
    render("stale");
    await settle();
    const staleNode = chart("stale")!;
    render("latest");
    await settle();
    const latestNode = chart("latest")!;
    expect(staleNode.isConnected).toBe(false);
    pending.resolve(stale);
    await settle();
    expect(chart("latest")).toBe(latestNode);
    expect(chart("stale")).toBeNull();
    expect(stale.finalize).toHaveBeenCalledTimes(1);
    expect(latest.finalize).not.toHaveBeenCalled();
  });

  it("aborts stale row requests and ignores their eventual response", async () => {
    const pending = deferred<DataPage>();
    fixture.api.mockReturnValueOnce(pending.promise);
    fixture.embed.mockImplementation(async (element: HTMLElement) => { draw(element, "latest"); return view(); });
    render("old");
    await settle();
    const signal = fixture.api.mock.calls[0]![1].signal as AbortSignal;
    render("latest");
    await settle();
    expect(signal.aborted).toBe(true);
    pending.resolve(page);
    await settle();
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    expect(chart("latest")?.isConnected).toBe(true);
  });

  it("keeps the previous chart when the replacement renderer fails", async () => {
    const first = view();
    fixture.embed
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "first"); return first; })
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "failed"); throw new Error("Bad chart"); });
    render("first");
    await settle();
    const original = chart("first");
    render("failed");
    await settle();
    expect(chart("first")).toBe(original);
    expect(chart("failed")).toBeNull();
    expect(first.finalize).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Bad chart");
    expect(alert.classList.contains("absolute")).toBe(true);
    expect(alert.classList.contains("bottom-0")).toBe(true);
  });

  it("disconnects resize and finalizes both displayed and pending views on unmount", async () => {
    const first = view();
    const pendingView = view();
    const pending = deferred<ReturnType<typeof view>>();
    fixture.embed
      .mockImplementationOnce(async (element: HTMLElement) => { draw(element, "first"); return first; })
      .mockImplementationOnce((element: HTMLElement) => { draw(element, "pending"); return pending.promise; });
    render("first");
    await settle();
    render("pending");
    await settle();
    const candidate = chart("pending")!;
    const signal = fixture.api.mock.calls[1]![1].signal as AbortSignal;
    flushSync(() => root.unmount());
    mounted = false;
    expect(signal.aborted).toBe(true);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(first.finalize).toHaveBeenCalledTimes(1);
    expect(candidate.isConnected).toBe(false);
    observer.callback();
    expect(first.view.resize).not.toHaveBeenCalled();
    pending.resolve(pendingView);
    await settle();
    expect(pendingView.finalize).toHaveBeenCalledTimes(1);
    expect(first.finalize).toHaveBeenCalledTimes(1);
    expect(host.children).toHaveLength(0);
  });
});
