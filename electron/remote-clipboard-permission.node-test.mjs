import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { appPermissionHandlers } from "./app-permissions.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");

const LOCAL = "http://127.0.0.1:48993";
const VPS = "https://viernes.tail1.ts.net:9444";
const OTHER = "https://other.tail1.ts.net:9444";
const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The real appPermissionHandlers (the ones main.mjs installs) fed by the real
// environments authority: only Electron itself is faked. `ctx.state` is read
// per request, exactly like main's `activeEnvironment(environmentsState)`.
function harness(envState, { cloud = null } = {}) {
  const mainContents = { getURL: () => "" };
  const ctx = { state: envState, main: mainContents, cloud };
  const handlers = appPermissionHandlers({
    rendererOrigin: () => LOCAL,
    mainContents: () => ctx.main,
    cloudHomeOrigin: () => ctx.cloud,
    activeRemoteOrigin: () => environments.activeEnvironment(ctx.state)?.origin ?? null,
  });
  const request = (permission, url, details = { isMainFrame: true }, contents = mainContents) => {
    let granted;
    handlers.request(contents, permission, (value) => { granted = value; }, { requestingUrl: url, ...details });
    return granted;
  };
  const check = (permission, origin, details = { isMainFrame: true }, contents = mainContents) =>
    handlers.check(contents, permission, origin, details);
  return { ctx, request, check, mainContents, handlers };
}

let state = environments.withEnvironment({ environments: [], activeId: environments.LOCAL_ID }, { origin: VPS, name: "VPS" }, () => "vps");
state = environments.withEnvironment(state, { origin: OTHER, name: "Other" }, () => "other");
const viewing = (id) => environments.withActive(state, id);

test("the local page keeps clipboard read and write", () => {
  const h = harness(viewing("local"));
  assert.equal(h.request("clipboard-sanitized-write", `${LOCAL}/chat`), true);
  assert.equal(h.request("clipboard-read", `${LOCAL}/chat`), true);
  assert.equal(h.check("clipboard-sanitized-write", LOCAL), true);
});

test("the active paired server may write the clipboard, on request and on check", () => {
  const h = harness(viewing("vps"));
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`), true);
  assert.equal(h.check("clipboard-sanitized-write", VPS), true);
  assert.equal(h.check("clipboard-sanitized-write", "", { isMainFrame: true }, Object.assign(h.mainContents, { getURL: () => `${VPS}/chat` })), true);
});

test("a remote page can never read the clipboard or gain another permission", () => {
  const h = harness(viewing("vps"));
  for (const permission of ["clipboard-read", "notifications", "fullscreen", "media", "geolocation", "camera", "display-capture", "openExternal", "unknown"]) {
    assert.equal(h.request(permission, `${VPS}/`, { isMainFrame: true, mediaTypes: ["audio"] }), false, `request ${permission}`);
    assert.equal(h.check(permission, VPS), false, `check ${permission}`);
  }
});

test("only the exact active origin writes: another server, port, scheme, host, blank or unknown origin is denied", () => {
  const h = harness(viewing("vps"));
  for (const url of [OTHER, "https://viernes.tail1.ts.net:9445/", "https://viernes.tail1.ts.net/", "http://viernes.tail1.ts.net:9444/",
    "https://viernes.tail1.ts.net.evil.test:9444/", "about:blank", "data:text/html,x", "", "not a url", "http://127.0.0.1:1/"]) {
    assert.equal(h.request("clipboard-sanitized-write", url), false, url);
    assert.equal(h.check("clipboard-sanitized-write", url), false, url);
  }
  assert.equal(h.request("clipboard-sanitized-write", undefined), false);
});

test("a child frame never inherits the trust, even on the active origin", () => {
  const h = harness(viewing("vps"));
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/embed`, { isMainFrame: false }), false);
  assert.equal(h.check("clipboard-sanitized-write", VPS, { isMainFrame: false }), false);
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/embed`, {}), false);
});

test("only the main application window is trusted", () => {
  const h = harness(viewing("vps"));
  const someOtherContents = { getURL: () => `${VPS}/` };
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`, { isMainFrame: true }, someOtherContents), false);
  assert.equal(h.check("clipboard-sanitized-write", VPS, { isMainFrame: true }, someOtherContents), false);
  h.ctx.main = null;
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`), false, "no main window yet");
});

test("the main-window guard is explicit: no main contents, missing or foreign contents all deny", () => {
  const h = harness(viewing("vps"));
  // Call the handlers directly: the harness helpers default an undefined contents to the main one.
  const ask = (contents) => {
    let granted;
    h.handlers.request(contents, "clipboard-sanitized-write", (value) => { granted = value; }, { requestingUrl: `${VPS}/`, isMainFrame: true });
    return [granted, h.handlers.check(contents, "clipboard-sanitized-write", VPS, { isMainFrame: true })];
  };
  assert.deepEqual(ask(h.mainContents), [true, true], "exact live main window");
  for (const contents of [null, undefined, { getURL: () => `${VPS}/` }]) assert.deepEqual(ask(contents), [false, false], String(contents));
  h.ctx.main = null; // main passes null for a missing or destroyed window
  assert.deepEqual(ask(h.mainContents), [false, false], "no main window");
  assert.deepEqual(ask(null), [false, false], "null never matches a null main");
  assert.deepEqual(ask(undefined), [false, false], "undefined never matches a null main");
});

test("switching or forgetting the server withdraws the old origin at once", () => {
  const h = harness(viewing("vps"));
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`), true);
  h.ctx.state = viewing("other");
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`), false, "previous remote after switch");
  assert.equal(h.check("clipboard-sanitized-write", VPS), false);
  assert.equal(h.request("clipboard-sanitized-write", `${OTHER}/`), true, "the new active one");
  h.ctx.state = viewing("local");
  assert.equal(h.request("clipboard-sanitized-write", `${OTHER}/`), false, "back on Local");
  assert.equal(h.request("clipboard-sanitized-write", `${LOCAL}/`), true, "Local still works");
  h.ctx.state = environments.withoutEnvironment(viewing("vps"), "vps");
  assert.equal(h.request("clipboard-sanitized-write", `${VPS}/`), false, "forgotten server");
});

test("the Cloud keeps its microphone and writes the clipboard by the same rule, and the server gets no microphone", () => {
  const CLOUD = "https://omb-u-0123456789ab.fly.dev";
  const audio = { isMainFrame: true, mediaTypes: ["audio"] };
  // The Cloud is the page in the main window; no remote server is active.
  const h = harness(viewing("local"), { cloud: CLOUD });
  h.mainContents.getURL = () => `${CLOUD}/chat`;
  assert.equal(h.request("media", `${CLOUD}/chat`, audio), true, "Cloud still hears the microphone");
  assert.equal(h.request("media", `${CLOUD}/chat`, { isMainFrame: true, mediaTypes: ["audio", "video"] }), false, "never the camera");
  assert.equal(h.request("media", `${CLOUD}/chat`, { isMainFrame: false, mediaTypes: ["audio"] }), false, "main frame only");
  assert.equal(h.request("clipboard-sanitized-write", `${CLOUD}/chat`), true, "the Cloud writes the clipboard (its copy buttons)");
  assert.equal(h.request("clipboard-sanitized-write", `${CLOUD}/chat`, { isMainFrame: false }), false, "main frame only");
  assert.equal(h.request("clipboard-read", `${CLOUD}/chat`), false, "never reads it");
  // The active remote server writes the clipboard but never hears the microphone.
  const r = harness(viewing("vps"), { cloud: CLOUD });
  assert.equal(r.request("clipboard-sanitized-write", `${VPS}/`), true);
  assert.equal(r.request("media", `${VPS}/`, audio), false, "a paired server never hears the microphone");
  assert.equal(r.check("media", VPS, audio), false);
  // Both trusts together: the Cloud keeps its microphone and clipboard writes while a remote server is the active environment elsewhere.
  r.mainContents.getURL = () => `${CLOUD}/chat`;
  assert.equal(r.request("media", `${CLOUD}/chat`, audio), true);
  assert.equal(r.request("clipboard-sanitized-write", `${CLOUD}/chat`), true);
  assert.equal(r.request("clipboard-read", `${CLOUD}/chat`), false);
});

test("main installs the active environment's origin into the shared handlers, with no second handler registration", () => {
  assert.match(mainSource, /activeRemoteOrigin: \(\) => activeEnvironment\(environmentsState\)\?\.origin \?\? null,\n/);
  assert.equal(mainSource.match(/setPermissionRequestHandler\(appPermissions\.request\)/g)?.length, 1);
  assert.equal(mainSource.match(/setPermissionCheckHandler\(appPermissions\.check\)/g)?.length, 1);
  assert.doesNotMatch(mainSource, /remoteClipboardWrite\b/, "no parallel permission handler left in main");
});
