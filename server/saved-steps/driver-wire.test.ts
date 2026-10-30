import { describe, expect, it } from "vitest";
import { MAX_ELEMENTS, elementPath, slimResponse, type WireElement } from "./driver-wire.ts";

describe("slimResponse", () => {
  it("keeps only what replay needs and drops every image and text", () => {
    const slim = slimResponse({ jsonrpc: "2.0", id: 3, result: {
      content: [{ type: "image", data: "AAAA" }, { type: "text", text: "secret text" }],
      structuredContent: { pid: 4242, window_id: 7, app_name: "TextEdit", window_title: "Untitled", snapshot_id: "x",
        elements: [{ element_index: 2, element_token: "s1-e2", role: "AXTextArea", label: "Document", value: "secret value",
          frame: { x: 1, y: 2, w: 3, h: 4 }, actions: ["AXPress"], parent_index: 1, depth: 2 }] } } });
    expect(slim).toEqual({ isError: false, structured: { pid: 4242, window_id: 7, app_name: "TextEdit", window_title: "Untitled",
      elements: [{ element_index: 2, element_token: "s1-e2", role: "AXTextArea", label: "Document", parent_index: 1, depth: 2, value_read: true }] } });
    expect(JSON.stringify(slim)).not.toMatch(/AAAA|secret/);
  });

  it("notes that the driver read what an element holds, an empty field included, never the text itself", () => {
    const read = (element: Record<string, unknown>) => slimResponse({ id: 1, result: { content: [], structuredContent: {
      elements: [{ element_index: 1, role: "AXTextField", label: "To", depth: 1, ...element }] } } }).structured?.elements?.[0]?.value_read;
    expect(read({ value: "" })).toBe(true);
    expect(read({ value: "ann@example.com" })).toBe(true);
    expect(read({})).toBeUndefined();
    expect(read({ value: null })).toBeUndefined();
    expect(read({ value: 3 })).toBeUndefined();
  });

  it("flags RPC errors, isError and refusals", () => {
    expect(slimResponse({ id: 1, error: { code: -32601, message: "x" } })).toEqual({ isError: true, rpcError: true });
    expect(slimResponse({ id: 1, result: { content: [], isError: true } }).isError).toBe(true);
    expect(slimResponse({ id: 1, result: { content: [], structuredContent: { refusal: { code: "c", message: "m", extra: 1 } } } }).structured)
      .toEqual({ refusal: { code: "c", message: "m" } });
  });

  it("keeps apps and windows for identity", () => {
    const slim = slimResponse({ id: 1, result: { content: [], structuredContent: {
      apps: [{ pid: 1, name: "Notes", bundle_id: "com.apple.Notes", running: true, icon: "AAAA" }],
      windows: [{ window_id: 9, pid: 1, title: "Todo", app_name: "Notes", bounds: { x: 0 } }],
    } } });
    expect(slim.structured).toEqual({
      apps: [{ pid: 1, name: "Notes", bundle_id: "com.apple.Notes", running: true }],
      windows: [{ window_id: 9, pid: 1, title: "Todo", app_name: "Notes" }],
    });
  });

  it("drops items missing their required keys instead of passing partial records", () => {
    const slim = slimResponse({ id: 1, result: { content: [], structuredContent: {
      elements: [{ element_index: 1, role: "AXButton", depth: 1 }, { element_index: 2, role: "AXButton" }, { role: "AXButton", depth: 1 }],
      apps: [{ pid: 1, name: "Notes" }, { pid: 2 }],
      windows: [{ window_id: 3, title: "T" }, { title: "no id" }],
    } } });
    expect(slim.structured).toEqual({
      elements: [{ element_index: 1, role: "AXButton", depth: 1 }],
      apps: [{ pid: 1, name: "Notes" }],
      windows: [{ window_id: 3, title: "T" }],
    });
  });

  const whole = (elements: unknown[], extra: Record<string, unknown> = {}) => slimResponse({ id: 1, result: { content: [], structuredContent: {
    elements, elements_complete: true, element_count: elements.length, ...extra } } }).structured?.elements_complete;
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ element_index: index, role: "AXButton", depth: 1 }));

  it("says a tree is whole only when the driver read all of it and slimming kept every element", () => {
    expect(whole(rows(3))).toBe(true);
    expect(whole(rows(3), { elements_complete: false })).toBeUndefined();
    expect(whole(rows(3), { elements_complete: "true" })).toBeUndefined();
    expect(whole(rows(3), { truncated: true })).toBeUndefined();
    expect(whole(rows(3), { element_count: 9 })).toBeUndefined();
    expect(whole(rows(3), { degraded: true })).toBeUndefined();
    expect(whole([...rows(3), { role: "AXButton", depth: 1 }])).toBeUndefined();
    expect(whole(rows(MAX_ELEMENTS + 1))).toBeUndefined();
  });

  it("caps elements at MAX_ELEMENTS", () => {
    const elements = Array.from({ length: 1600 }, (_, index) => ({ element_index: index, role: "AXButton", depth: 1 }));
    const slim = slimResponse({ id: 1, result: { content: [], structuredContent: { elements } } });
    expect(slim.structured?.elements).toHaveLength(MAX_ELEMENTS);
    expect(slim.structured?.elements?.[MAX_ELEMENTS - 1].element_index).toBe(MAX_ELEMENTS - 1);
  });
});

describe("elementPath", () => {
  const elements: WireElement[] = [
    { element_index: 0, role: "AXWindow", label: "Untitled", depth: 0 },
    { element_index: 1, role: "AXScrollArea", parent_index: 0, depth: 1 },
    { element_index: 2, role: "AXTextArea", label: "Document", parent_index: 1, depth: 2 },
  ];

  it("walks an element's ancestors from the root, leaving the window out", () => {
    expect(elementPath(elements, elements[2])).toEqual(["AXScrollArea:"]);
    expect(elementPath(elements, elements[0])).toEqual([]);
  });

  it("keeps non-window ancestors from the root down, skipping AXApplication too", () => {
    const deep: WireElement[] = [
      { element_index: 0, role: "AXApplication", label: "App", depth: 0 },
      { element_index: 1, role: "AXWindow", label: "W", parent_index: 0, depth: 1 },
      { element_index: 2, role: "AXGroup", label: "Outer", parent_index: 1, depth: 2 },
      { element_index: 3, role: "AXGroup", label: "Inner", parent_index: 2, depth: 3 },
      { element_index: 4, role: "AXButton", label: "Go", parent_index: 3, depth: 4 },
    ];
    expect(elementPath(deep, deep[4])).toEqual(["AXGroup:Outer", "AXGroup:Inner"]);
  });

  it("returns null on a missing parent or a cycle", () => {
    const orphan = { ...elements[2], parent_index: 9 };
    expect(elementPath([orphan], orphan)).toBeNull();
    const loop: WireElement[] = [
      { element_index: 0, role: "AXGroup", parent_index: 1, depth: 1 },
      { element_index: 1, role: "AXGroup", parent_index: 0, depth: 1 },
    ];
    expect(elementPath(loop, loop[0])).toBeNull();
  });

  it("returns null when an element or an ancestor below the root has no parent", () => {
    const loose: WireElement = { element_index: 5, role: "AXButton", label: "Go", depth: 2 };
    expect(elementPath([...elements, loose], loose)).toBeNull();
    const cutAbove: WireElement[] = [
      { element_index: 0, role: "AXGroup", label: "Outer", depth: 1 },
      { element_index: 1, role: "AXButton", label: "Go", parent_index: 0, depth: 2 },
    ];
    expect(elementPath(cutAbove, cutAbove[1])).toBeNull();
  });
});
