import assert from "node:assert/strict";
import test from "node:test";

import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";

const VIEWER = "https://desktop.example";
const VIEWER_PAGE = "https://desktop.example/vnc.html?_token=secret";

test("grants the viewer page keyboard, pointer, clipboard and fullscreen", () => {
  for (const permission of ["keyboardLock", "pointerLock", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]) {
    assert.equal(desktopViewerPermissionAllowed(permission, VIEWER_PAGE, VIEWER), true, permission);
  }
});

test("accepts a bare origin or a full URL on either side", () => {
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", VIEWER, VIEWER), true);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", `${VIEWER}/vnc.html#x`, `${VIEWER}/session?y=1`), true);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "http://127.0.0.1:6080/vnc.html", "http://127.0.0.1:6080"), true);
});

test("refuses input permissions to any other origin", () => {
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "https://other.example/vnc.html", VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("clipboard-read", "https://desktop.example.evil/vnc.html", VIEWER), false);
  // Scheme and port are part of the origin.
  assert.equal(desktopViewerPermissionAllowed("pointerLock", "http://desktop.example/vnc.html", VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("fullscreen", "https://desktop.example:8443/vnc.html", VIEWER), false);
});

test("keeps every privileged capability off even for the viewer page", () => {
  const privileged = [
    "media", "mediaKeySystem", "notifications", "geolocation", "usb", "hid", "serial", "midi", "midiSysex",
    "display-capture", "fileSystem", "openExternal", "idle-detection", "speaker-selection", "window-management",
    "storage-access", "top-level-storage-access", "deprecated-sync-clipboard-read", "unknown",
  ];
  for (const permission of privileged) {
    assert.equal(desktopViewerPermissionAllowed(permission, VIEWER_PAGE, VIEWER), false, permission);
  }
  assert.equal(desktopViewerPermissionAllowed(undefined, VIEWER_PAGE, VIEWER), false);
});

test("fails closed on unparsable or opaque origins", () => {
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "not a url", VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "", VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", undefined, VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", null, VIEWER), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", VIEWER_PAGE, "not a url"), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", VIEWER_PAGE, undefined), false);
  // Opaque origins all serialise as "null"; two of them must never match.
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "data:text/html,x", "about:blank"), false);
  assert.equal(desktopViewerPermissionAllowed("keyboardLock", "javascript:alert(1)", VIEWER), false);
});
