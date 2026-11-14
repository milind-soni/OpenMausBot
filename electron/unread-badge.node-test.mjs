import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { unreadBadgeIcon } from "./color-dot.mjs";

const fakeImages = () => ({ createEmpty: () => ({ reps: [], addRepresentation(options) { this.reps.push(options); }, isEmpty() { return this.reps.length === 0; } }) });

/** The RGBA of pixel (x, y) in a PNG data URL drawn by colorDotPng (8-bit RGBA, filter byte 0 on every row). */
function pixel(dataURL, x, y) {
  const png = Buffer.from(dataURL.split(",")[1], "base64");
  const size = png.readUInt32BE(16);
  const idat = png.indexOf("IDAT"), length = png.readUInt32BE(idat - 4);
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  const at = y * (size * 4 + 1) + 1 + x * 4;
  return { size, rgba: [...rows.subarray(at, at + 4)] };
}

test("the Windows unread overlay is a red dot at 16 px and 32 px, not the app icon", () => {
  const image = unreadBadgeIcon(fakeImages());
  assert.deepEqual(image.reps.map(rep => rep.scaleFactor), [1, 2]);
  for (const [index, size] of [[0, 16], [1, 32]]) {
    const middle = pixel(image.reps[index].dataURL, size / 2, size / 2);
    assert.equal(middle.size, size);
    assert.deepEqual(middle.rgba, [0xD9, 0x4B, 0x52, 255], "the middle is solid red");
    assert.equal(pixel(image.reps[index].dataURL, 0, 0).rgba[3], 0, "the corner is clear, so the taskbar icon shows around the dot");
  }
});

test("an overlay that cannot be drawn is no overlay", () => {
  assert.equal(unreadBadgeIcon({ createEmpty: () => { throw new Error("no"); } }), null);
  assert.equal(unreadBadgeIcon({ createEmpty: () => ({ addRepresentation() {}, isEmpty: () => true }) }), null);
});

test("main's Windows badge uses the red dot, not a shrunk copy of the app icon (#5885)", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const badge = main.slice(main.indexOf("function applyUnreadBadge"), main.indexOf("app.setBadgeCount(count)"));
  assert.match(badge, /unreadBadgeIcon\(nativeImage\)/);
  assert.doesNotMatch(badge, /APP_ICON/);
});
