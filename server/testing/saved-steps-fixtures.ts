import type { SlimStructured, WireElement } from "../saved-steps/driver-wire.ts";
import type { RecordedCall, RequestJournal } from "../saved-steps/journal.ts";

export function windowState(snapshot: number): SlimStructured {
  const token = (index: number) => `s${snapshot}-e${index}`;
  const elements: WireElement[] = [
    { element_index: 0, element_token: token(0), role: "AXWindow", label: "Untitled", depth: 0 },
    { element_index: 1, element_token: token(1), role: "AXScrollArea", parent_index: 0, depth: 1 },
    { element_index: 2, element_token: token(2), role: "AXTextArea", label: "Document", parent_index: 1, depth: 2 },
    { element_index: 3, element_token: token(3), role: "AXButton", label: "Save", parent_index: 0, depth: 1 },
  ];
  return { pid: 4242, app_name: "TextEdit", bundle_id: "com.apple.TextEdit", window_id: 7, window_title: "Untitled", elements };
}

const isText = (element: WireElement) => element.role === "AXTextArea";

/** A tree as the bridge records it when the driver read all of it: the document's text was reported, and not kept. */
export function recordedWindowState(snapshot: number): SlimStructured {
  const state = windowState(snapshot);
  return { ...state, elements: state.elements?.map((element) => (isText(element) ? { ...element, value_read: true } : element)), elements_complete: true };
}

/** A whole tree as the driver answers it, its document holding `document`. */
export function completeWindowState(structured: SlimStructured, document = ""): Record<string, unknown> {
  const elements = structured.elements?.map(({ value_read: _read, ...element }) => (isText(element) ? { ...element, value: document } : element));
  const count = elements?.length ?? 0;
  return { ...structured, ...(elements ? { elements } : {}), elements_complete: true, element_count: count, returned_element_count: count, total_element_count: count };
}

const ok = (structured?: SlimStructured) => ({ isError: false, ...(structured ? { structured } : {}) });

export function textEditJournal(overrides: { calls?: RecordedCall[]; complete?: boolean; tainted?: boolean } = {}): RequestJournal {
  const calls: RecordedCall[] = overrides.calls ?? [
    { tool: "list_apps", arguments: {}, result: ok({ apps: [{ pid: 4242, name: "TextEdit", bundle_id: "com.apple.TextEdit", running: true }] }), generation: "g1" },
    { tool: "list_windows", arguments: { pid: 4242 }, result: ok({ windows: [{ window_id: 7, pid: 4242, title: "Untitled", app_name: "TextEdit" }] }), generation: "g1" },
    { tool: "get_window_state", arguments: { pid: 4242, window_id: 7 }, result: ok(recordedWindowState(1)), generation: "g1" },
    { tool: "click", arguments: { element_token: "s1-e2" }, result: ok(), generation: "g1" },
    { tool: "set_value", arguments: { element_token: "s1-e2", value: "hello world" }, result: ok(), generation: "g1" },
  ];
  return { calls, complete: overrides.complete ?? true, tainted: overrides.tainted ?? false };
}
