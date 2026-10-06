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

test("accepts a macOS Cua Space viewer on this Mac's VM bridge, not on the LAN", () => {
  const nic = (address) => [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` }];
  const link = "http://192.168.64.5:3211/viewer/#ticket=t";
  assert.equal(desktopViewerUrl(link, { bridge100: nic("192.168.64.1") }, "darwin").host, "192.168.64.5:3211");
  assert.equal(desktopViewerUrl(link, { bridge199: nic("192.168.64.1") }, "darwin").host, "192.168.64.5:3211");
  assert.throws(() => desktopViewerUrl(link, { en0: nic("192.168.64.20") }, "darwin"), /HTTPS/);
  assert.throws(() => desktopViewerUrl(link, { bridge0: nic("192.168.64.20") }, "darwin"), /HTTPS/);
  assert.throws(() => desktopViewerUrl(link, { bridge200: nic("192.168.64.20") }, "darwin"), /HTTPS/);
  assert.throws(() => desktopViewerUrl(link, { bridge100: nic("192.168.65.1") }, "darwin"), /HTTPS/);
  for (const platform of ["linux", "win32", "freebsd"]) {
    assert.throws(() => desktopViewerUrl(link, { bridge100: nic("192.168.64.1") }, platform), /HTTPS/);
    assert.equal(desktopViewerUrl("http://127.0.0.1:6080/vnc.html", {}, platform).port, "6080");
    assert.equal(desktopViewerUrl("https://desktop.example/vnc.html", {}, platform).origin, "https://desktop.example");
  }
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
