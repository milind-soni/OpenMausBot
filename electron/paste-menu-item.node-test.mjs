import assert from "node:assert/strict";
import { test } from "node:test";
import { pasteMenuItem } from "./paste-menu-item.mjs";

const params = { isEditable: true, editFlags: { canPaste: false } };
const clipboard = (formats = [], image = false) => ({
  availableFormats: () => formats,
  readImage: () => ({ isEmpty: () => !image }),
});

test("image and Finder file clipboards get an explicit enabled paste action", () => {
  for (const contents of [clipboard([], true), ...["public.file-url", "NSFilenamesPboardType", "text/uri-list"].map(format => clipboard([format]))]) {
    let pastes = 0;
    const item = pasteMenuItem(params, contents, { paste: () => pastes++ });
    assert.equal(item.enabled, true);
    assert.equal(item.role, undefined);
    item.click();
    assert.equal(pastes, 1);
  }
});

test("text paste keeps its native role without inspecting the clipboard", () => {
  const item = pasteMenuItem({ ...params, editFlags: { canPaste: true } }, null, null);
  assert.deepEqual(item, { label: "Paste", enabled: true, role: "paste" });
});

test("read-only targets, empty clipboards, and clipboard failures stay disabled", () => {
  assert.equal(pasteMenuItem({ ...params, isEditable: false }, null, null).enabled, false);
  assert.equal(pasteMenuItem(params, clipboard(), null).enabled, false);
  assert.equal(pasteMenuItem(params, { availableFormats() { throw Error("unavailable"); } }, null).enabled, false);
});
