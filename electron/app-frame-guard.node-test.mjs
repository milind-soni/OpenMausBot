import assert from "node:assert/strict";
import test from "node:test";

import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";

const appFrame = (url) => ({ isMainFrame: false, url, frame: { origin: "null", url: "" } });

test("an app frame may load its own document", () => {
  assert.equal(appFrameNavigationAllowed(appFrame("about:srcdoc")), true);
  assert.equal(appFrameNavigationAllowed(appFrame("about:blank")), true);
  assert.equal(appFrameNavigationAllowed(appFrame("about:srcdoc#totals")), true);
});

test("an app frame may not navigate anywhere else", () => {
  for (const url of [
    "http://127.0.0.1:9/sink",
    "https://example.com/",
    "https://cdnjs.cloudflare.com/ajax/libs/x.js",
    "http://localhost:8799/",
    "data:text/html,<p>hi</p>",
    "blob:null/1234",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "about:srcdocx",
    "about:blank/../srcdoc",
    "",
    undefined,
  ]) assert.equal(appFrameNavigationAllowed(appFrame(url)), false, String(url));
});

test("cancels, and never throws, when the frame can no longer be read", () => {
  // Electron throws from WebFrameMain's getters once its render frame is gone.
  const disposed = { get origin() { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); } };
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "http://127.0.0.1:9/location", frame: disposed }), false);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "about:srcdoc", frame: disposed }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: true, url: "http://127.0.0.1:9/", frame: disposed }), true);
});

test("leaves main frames and frames with a real origin alone", () => {
  assert.equal(appFrameNavigationAllowed({ isMainFrame: true, url: "https://example.com/", frame: { origin: "null" } }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "https://example.com/", frame: { origin: "http://127.0.0.1:5199" } }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "https://example.com/", frame: null }), true);
  assert.equal(appFrameNavigationAllowed(null), true);
  assert.equal(appFrameNavigationAllowed(undefined), true);
});
