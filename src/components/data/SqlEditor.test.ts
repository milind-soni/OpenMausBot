// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "codemirror";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";

let host: HTMLDivElement;
let root: Root;
const change = vi.fn();
const render = (sql: string, externalRevision?: string) => flushSync(() => root.render(createElement(SqlEditor, { sql, externalRevision, onChange: change })));
const editor = () => host.querySelector<HTMLElement>('[role="textbox"][aria-label="SQL"]')!;
const view = () => EditorView.findFromDOM(editor())!;
const text = () => view().state.doc.toString();
const type = (text: string) => {
  flushSync(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }));
};
beforeEach(() => {
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect());
  change.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("shows a completed bot SQL edit without remounting or executing it again", async () => {
  render("SELECT * FROM orders", "result-1");
  const original = editor();
  render("SELECT * FROM orders WHERE region = 'India'", "result-2");
  await vi.waitFor(() => expect(text()).toBe("SELECT * FROM orders WHERE region = 'India'"));
  expect(editor()).toBe(original);
  expect(change).not.toHaveBeenCalled();
});

it("does not overwrite a newer local draft with query echoes or unrelated broadcasts", async () => {
  render("SELECT 1", "result-1");
  type("SELECT unfinished");
  view().dispatch({ selection: { anchor: 3, head: 7 } });
  render("SELECT 12");
  render("SELECT 1", "result-1");
  expect(text()).toBe("SELECT unfinished");
  expect([view().state.selection.main.from, view().state.selection.main.to]).toEqual([3, 7]);
  render("SELECT 42", "result-2");
  await vi.waitFor(() => expect(text()).toBe("SELECT 42"));
  expect(change).toHaveBeenCalledExactlyOnceWith("SELECT unfinished");
});

it("accepts the next bot result after a person-created result", async () => {
  render("SELECT 1");
  type("broken SQL");
  render("SELECT 2", "bot-result");
  await vi.waitFor(() => expect(text()).toBe("SELECT 2"));
});

it("colours SQL and DuckDB clauses while running edits immediately", () => {
  render("SELECT 'India', 42 FROM orders QUALIFY row_number() OVER () = 1 -- comment");
  const keyword = [...editor().querySelectorAll("span")].find((span) => span.textContent === "QUALIFY");
  expect(keyword?.className).toBeTruthy();
  expect([...editor().querySelectorAll("span")].some((span) => span.textContent === "'India'" && span.className)).toBe(true);
  type("SELECT 2");
  expect(change).toHaveBeenCalledExactlyOnceWith("SELECT 2");
  expect(host.querySelector("button")).toBeNull();
});
