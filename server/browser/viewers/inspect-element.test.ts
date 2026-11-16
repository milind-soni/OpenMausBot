import { Buffer } from "node:buffer";
import { expect, it, vi } from "vitest";
import type { Tab } from "../tabs.ts";
import { inspectBrowserElement } from "./inspect-element.ts";

function fixture() {
  const element = {
    document: "page-1",
    rect: { x: 5, y: 6, width: 20, height: 30 },
    clip: { x: 5, y: 106, width: 20, height: 30 },
  };
  const evaluate = vi.fn(async (): Promise<unknown> => element);
  const screenshot = vi.fn(async () => ({ data: Buffer.from("fixture-png") }));
  const tab = { page: { evaluate, screenshot } } as unknown as Tab;
  const push = vi.fn();
  return { element, evaluate, screenshot, tab, push };
}

it("captures only the inspected element clip and correlates the reply", async () => {
  const f = fixture();
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "selection-1",
    x: 10,
    y: 12,
    capture: true,
    document: "page-1",
  });
  expect(f.screenshot).toHaveBeenCalledWith({
    format: "png",
    clip: f.element.clip,
  });
  expect(f.push).toHaveBeenCalledWith({
    type: "ombElementInspection",
    requestId: "selection-1",
    element: f.element,
    image: Buffer.from("fixture-png").toString("base64"),
    mime: "image/png",
  });
});

it("refuses a capture after the document changes", async () => {
  const f = fixture();
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "selection-1",
    x: 10,
    y: 12,
    capture: true,
    document: "old-page",
  });
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "selection-1",
      error: "The page changed. Select the element again.",
    }),
  );
});

it.each([
  { requestId: "bad id", x: 1, y: 2 },
  { requestId: "ok", x: Number.NaN, y: 2 },
  { x: 1, y: 2 },
])("ignores malformed inspection requests: %j", async (message) => {
  const f = fixture();
  await inspectBrowserElement({ push: f.push }, f.tab, message);
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).not.toHaveBeenCalled();
});

it("does not capture an image for a hover-only inspection", async () => {
  const f = fixture();
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "hover-1",
    x: 10,
    y: 12,
    capture: false,
  });
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith({
    type: "ombElementInspection",
    requestId: "hover-1",
    element: f.element,
  });
});

it("refuses an oversized image without returning its bytes", async () => {
  const f = fixture();
  f.screenshot.mockResolvedValue({ data: Buffer.alloc(8 * 1024 * 1024 + 1) });
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "selection-1",
    x: 10,
    y: 12,
    capture: true,
  });
  expect(f.push).toHaveBeenCalledWith({
    type: "ombElementInspection",
    requestId: "selection-1",
    error: "Select a smaller element.",
  });
});

it("discards image bytes if navigation completes during capture", async () => {
  const f = fixture();
  f.evaluate
    .mockResolvedValueOnce(f.element)
    .mockResolvedValueOnce({ ...f.element, document: "page-2" });
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "selection-1",
    x: 10,
    y: 12,
    capture: true,
    document: "page-1",
  });
  expect(f.push).toHaveBeenCalledWith({
    type: "ombElementInspection",
    requestId: "selection-1",
    error: "The page changed. Select the element again.",
  });
  expect(f.push.mock.calls.some(([reply]) => "image" in reply)).toBe(false);
});

it("discards captured bytes when the selected region becomes private", async () => {
  const f = fixture();
  f.evaluate
    .mockResolvedValueOnce(f.element)
    .mockRejectedValueOnce(
      new Error(
        "Select a smaller element without private or editable content.",
      ),
    );
  await inspectBrowserElement({ push: f.push }, f.tab, {
    requestId: "selection-1",
    x: 10,
    y: 12,
    capture: true,
  });
  expect(f.push).toHaveBeenCalledWith({
    type: "ombElementInspection",
    requestId: "selection-1",
    error: "Select a smaller element without private or editable content.",
  });
  expect(f.push.mock.calls.some(([reply]) => "image" in reply)).toBe(false);
});
