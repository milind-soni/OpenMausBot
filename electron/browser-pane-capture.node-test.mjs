import assert from "node:assert/strict";
import test from "node:test";

import { captureUndrawn, windowDraws } from "./browser-pane-capture.mjs";

function fakeImage(width, height, label, calls) {
  return {
    label,
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize(size) { calls.push(["resize", size]); return fakeImage(size.width, size.height, label, calls); },
    toPNG: () => Buffer.from(`png ${width}x${height} ${label}`),
    toJPEG: (quality) => Buffer.from(`jpeg ${width}x${height} q${quality} ${label}`),
  };
}

/**
 * A pane whose page is 365x576 CSS px at the page's device pixel ratio `pageRatio`, in a window on a screen of scale
 * `screen`: capturePage gives screen pixels. The first capture holds the frame drawn before the bot's action.
 */
function fakeContents({ pageRatio = 1, screen = 1, empty = false, unreadable = false } = {}) {
  const calls = [];
  let captures = 0;
  return {
    calls,
    debugger: {
      async sendCommand(method) {
        calls.push([method]);
        if (method === "Runtime.evaluate") {
          if (unreadable) throw new Error("A JavaScript dialog is open on the page");
          return { result: { type: "number", value: pageRatio } };
        }
        return { cssVisualViewport: { pageX: 0, pageY: 400, clientWidth: 365, clientHeight: 576 }, visualViewport: { clientWidth: 365 * pageRatio, clientHeight: 576 * pageRatio } };
      },
    },
    invalidate() { calls.push(["invalidate"]); },
    async capturePage(rect) {
      calls.push(["capturePage", rect]);
      captures++;
      const width = rect ? rect.width : 365;
      const height = rect ? rect.height : 576;
      return fakeImage(empty ? 0 : width * screen, height * screen, captures === 1 ? "before" : "fresh", calls);
    },
  };
}

const text = (answer) => Buffer.from(answer.data, "base64").toString();
const now = { wait: async () => {} };

test("draws the viewport as CDP would, at the page's ratio whatever the window's screen, from a fresh frame", async () => {
  for (const [pageRatio, screen, expected] of [[1, 1, "365x576"], [2, 2, "730x1152"], [2, 1, "730x1152"], [1, 2, "365x576"]]) {
    const contents = fakeContents({ pageRatio, screen });
    assert.equal(text(await captureUndrawn(contents, {}, now)), `png ${expected} fresh`, `page ${pageRatio}, screen ${screen}`);
    assert.deepEqual(contents.calls.map(([name]) => name).filter((name) => name === "capturePage" || name === "invalidate"), ["capturePage", "invalidate", "capturePage"]);
  }
});

test("takes the driver's clip in page coordinates at its scale: one picture pixel per CSS pixel, at either screen scale", async () => {
  // The driver asks for scale 1/ratio so the picture has one pixel per CSS pixel.
  for (const [pageRatio, screen] of [[1, 1], [2, 2], [2, 1], [1, 2]]) {
    const contents = fakeContents({ pageRatio, screen });
    const answer = await captureUndrawn(contents, { format: "jpeg", quality: 80, clip: { x: 0, y: 400, width: 365, height: 576, scale: 1 / pageRatio } }, now);
    assert.equal(text(answer), "jpeg 365x576 q80 fresh", `page ${pageRatio}, screen ${screen}`);
    assert.deepEqual(contents.calls.find(([name]) => name === "capturePage"), ["capturePage", { x: 0, y: 0, width: 365, height: 576 }]);
  }
});

test("falls back on the layout metrics for the page's ratio where the page cannot be read", async () => {
  const contents = fakeContents({ pageRatio: 2, screen: 1, unreadable: true });
  assert.equal(text(await captureUndrawn(contents, { clip: { x: 0, y: 400, width: 365, height: 576, scale: 0.5 } }, now)), "png 365x576 fresh");
});

test("refuses a whole-page capture and says when nothing was drawn", async () => {
  await assert.rejects(captureUndrawn(fakeContents(), { captureBeyondViewport: true }, now), /whole-page/);
  await assert.rejects(captureUndrawn(fakeContents({ empty: true }), {}, now), /did not draw/);
});

test("knows a minimised or hidden window draws nothing", () => {
  const win = (minimised, visible) => ({ isDestroyed: () => false, isMinimized: () => minimised, isVisible: () => visible });
  assert.equal(windowDraws(win(false, true)), true);
  assert.equal(windowDraws(win(true, true)), false);
  assert.equal(windowDraws(win(false, false)), false);
  assert.equal(windowDraws(null), false);
});
