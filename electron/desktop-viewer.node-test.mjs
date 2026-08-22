import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");

test("accepts a secret-bearing HTTPS VNC URL", () => {
  const url = desktopViewerUrl("https://desktop.example/vnc.html?_token=secret");
  assert.equal(url.origin, "https://desktop.example");
});

test("accepts Local VM viewers on loopback", () => {
  assert.equal(desktopViewerUrl("http://127.0.0.1:6080/vnc.html#password=x").port, "6080");
  assert.equal(desktopViewerUrl("http://localhost:6080/vnc.html").hostname, "localhost");
});

test("rejects insecure remote and privileged URLs", () => {
  assert.throws(() => desktopViewerUrl("http://desktop.example/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("file:///tmp/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("data:text/html,hello"), /HTTPS/);
});

test("rejects URL user info", () => {
  assert.throws(() => desktopViewerUrl("https://user:password@desktop.example/vnc.html"), /user info/);
});

test("allows only same-origin viewer navigation", () => {
  assert.equal(sameDesktopViewerOrigin("https://desktop.example/session", "https://desktop.example"), true);
  assert.equal(sameDesktopViewerOrigin("https://other.example/session", "https://desktop.example"), false);
  assert.equal(sameDesktopViewerOrigin("javascript:alert(1)", "https://desktop.example"), false);
});
