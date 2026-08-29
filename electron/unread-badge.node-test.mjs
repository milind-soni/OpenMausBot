import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { unreadBadgeDataUrl, unreadBadgeLabel } = require("./unread-badge.cjs");

test("taskbar badge uses readable count labels", () => {
  assert.equal(unreadBadgeLabel(1), "1");
  assert.equal(unreadBadgeLabel(27), "27");
  assert.equal(unreadBadgeLabel(999), "99+");
});

test("taskbar badge produces a raster data URL Windows can use as an overlay icon", () => {
  const url = unreadBadgeDataUrl(7);
  assert.match(url, /^data:image\/png;base64,/);
  const png = Buffer.from(url.split(",")[1], "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
