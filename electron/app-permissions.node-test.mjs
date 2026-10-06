import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { appPermissionAllowed, appPermissionHandlers, externalWebUrl } from "./app-permissions.mjs";

const LOCAL_ORIGIN = "http://127.0.0.1:5199";
const LOCAL_PAGE = "http://127.0.0.1:5199/chat?botId=bot-1";

test("grants notifications, clipboard, and fullscreen to the local renderer page", () => {
  for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), true, permission);
  }
});

test("accepts a bare origin or a full URL on either side", () => {
  assert.equal(appPermissionAllowed("notifications", LOCAL_ORIGIN, LOCAL_ORIGIN), true);
  assert.equal(appPermissionAllowed("notifications", `${LOCAL_ORIGIN}/settings#voice`, `${LOCAL_ORIGIN}/`), true);
  assert.equal(appPermissionAllowed("fullscreen", "http://127.0.0.1:8799/chat", "http://127.0.0.1:8799"), true);
});

test("allows media for audio (microphone) and guarded display-capture, denies video (camera)", () => {
  // Audio only: allowed
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio"] }), true);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "audio" }), true);

  // Guarded display-capture path: Electron 43 routes getDisplayMedia through permission="media"
  // with an empty mediaTypes array before dispatching to setDisplayMediaRequestHandler
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: [] }), true);

  // Video / camera: strictly denied
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio", "video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "video" }), false);

  // Unknown or omitted details: fail closed
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "unknown" }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, {}), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("refuses permissions to any other origin", () => {
  assert.equal(appPermissionAllowed("notifications", "https://other.example/chat", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("clipboard-read", "http://127.0.0.1:5200/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("media", "https://127.0.0.1:5199/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("fullscreen", "http://localhost:5199/", LOCAL_ORIGIN), false);
});

test("keeps every privileged capability off even for the local renderer page", () => {
  const privileged = [
    "geolocation", "camera", "usb", "hid", "serial", "midi", "midiSysex",
    "display-capture", "fileSystem", "openExternal", "idle-detection", "speaker-selection",
    "window-management", "storage-access", "top-level-storage-access", "pointerLock",
    "keyboardLock", "mediaKeySystem", "unknown",
  ];
  for (const permission of privileged) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), false, permission);
  }
  assert.equal(appPermissionAllowed(undefined, LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("rejects mixed, unknown, and conflicting media details", () => {
  for (const details of [
    { mediaTypes: ["audio", "unknown"] }, { mediaTypes: ["unknown"] },
    { mediaType: "audio", mediaTypes: ["video"] },
    { mediaType: "unknown", mediaTypes: [] }, { mediaTypes: "audio" }, null,
  ]) assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, details), false);
});

test("web links reject embedded credentials and non-web schemes", () => {
  assert.equal(externalWebUrl("https://example.com/help?q=hello#more"), "https://example.com/help?q=hello#more");
  assert.equal(externalWebUrl("http://127.0.0.1:8799"), "http://127.0.0.1:8799/");
  for (const url of ["https://user:pass@example.com", "http://user@example.com", "https://:pass@example.com"])
    assert.throws(() => externalWebUrl(url), /credentials/);
  for (const url of ["file:///tmp/test", "javascript:alert(1)", "data:text/html,test", "mailto:test@example.com"])
    assert.throws(() => externalWebUrl(url), /Only web/);
  for (const url of [null, 123, "not a url"])
    assert.throws(() => externalWebUrl(url), /web address/);
});

test("both external-link entry points use the policy and IPC retains the local-origin gate", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("desktop:open-external", localOnly\("desktop:open-external"/);
  assert.match(main, /shell\.openExternal\(externalWebUrl\(rawUrl\)\)/);
  assert.match(main, /shell\.openExternal\(externalWebUrl\(url\)\)/);
});

test("fails closed on unparsable or opaque origins", () => {
  assert.equal(appPermissionAllowed("notifications", "not a url", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", "", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", undefined, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", null, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, "not a url"), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, undefined), false);
  // Opaque origins all serialise as "null"; two of them must never match.
  assert.equal(appPermissionAllowed("notifications", "data:text/html,x", "about:blank"), false);
  assert.equal(appPermissionAllowed("notifications", "javascript:alert(1)", LOCAL_ORIGIN), false);
});

// ── The person's own Cloud, open in this app's window ──
// A Cloud is personal, so its page hearing the microphone for a Live call is
// the person's own page hearing it. Only that: the microphone, in the main
// frame of the main window, at the exact origin the verified Cloud sign-in
// reports. Every other server, and every other capability, stays refused.
const CLOUD = "https://omb-u-0123456789ab.fly.dev";
function cloudFixture({ home = CLOUD } = {}) {
  const main = { getURL: () => `${CLOUD}/chat?botId=bot-1` };
  const state = { home, main, remote: false };
  const handlers = appPermissionHandlers({
    rendererOrigin: () => LOCAL_ORIGIN,
    mainContents: () => state.main,
    cloudHomeOrigin: () => state.home,
  });
  const ask = (permission, details, contents = state.main) => {
    let granted;
    handlers.request(contents, permission, (value) => { granted = value; }, details);
    return granted;
  };
  const check = (permission, requestingOrigin, details, contents = state.main) => handlers.check(contents, permission, requestingOrigin, details);
  return { state, ask, check };
}
const onCloud = (fields = {}) => ({ requestingUrl: `${CLOUD}/chat?botId=bot-1`, isMainFrame: true, ...fields });

test("the verified Cloud open in this window may use the microphone", () => {
  const { ask, check } = cloudFixture();
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] })), true);
  assert.equal(check("media", CLOUD, { requestingUrl: `${CLOUD}/`, isMainFrame: true, mediaType: "audio" }), true);
});

test("the Cloud never gets the camera, screen capture or any other capability", () => {
  const { ask, check } = cloudFixture();
  for (const mediaTypes of [["video"], ["audio", "video"], [], ["unknown"]]) {
    assert.equal(ask("media", onCloud({ mediaTypes })), false, JSON.stringify(mediaTypes));
  }
  assert.equal(ask("media", onCloud()), false, "media with no type");
  assert.equal(check("media", CLOUD, { isMainFrame: true, mediaType: "video" }), false);
  assert.equal(check("media", CLOUD, { isMainFrame: true, mediaType: "unknown" }), false);
  for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "geolocation", "display-capture", "camera"]) {
    assert.equal(ask(permission, onCloud()), false, permission);
    assert.equal(check(permission, CLOUD, { isMainFrame: true }), false, permission);
    // Audio details on another permission do not make it the microphone.
    assert.equal(ask(permission, onCloud({ mediaTypes: ["audio"] })), false, `${permission} with audio details`);
    assert.equal(check(permission, CLOUD, { isMainFrame: true, mediaType: "audio" }), false, `${permission} with audio details`);
  }
});

test("a server that is not the verified Cloud never hears the microphone", () => {
  const { state, ask, check } = cloudFixture();
  const mic = { isMainFrame: true, mediaTypes: ["audio"] };
  for (const other of ["https://my-vps.example.com", "http://omb-u-0123456789ab.fly.dev", "https://omb-u-0123456789ab.fly.dev:8443", "https://evil.fly.dev"]) {
    assert.equal(ask("media", { ...mic, requestingUrl: `${other}/chat` }), false, other);
    assert.equal(check("media", other, { isMainFrame: true, mediaType: "audio" }), false, other);
  }
  // The Cloud's own page in a subframe, or in any other window, is not the Cloud open here.
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"], isMainFrame: false })), false, "a subframe");
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] }), { getURL: () => `${CLOUD}/` }), false, "another window");
  assert.equal(check("media", CLOUD, { isMainFrame: true, mediaType: "audio" }, null), false, "no window");
  state.main = null;
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] })), false, "the main window is gone");
});

test("signed out of Cloud, or the Cloud not running, its page loses the microphone at once", () => {
  const { state, ask } = cloudFixture();
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] })), true);
  state.home = null;
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] })), false);
  state.home = "not a url";
  assert.equal(ask("media", onCloud({ mediaTypes: ["audio"] })), false);
});

test("this computer's own page keeps its permissions through the same handlers", () => {
  const { ask, check } = cloudFixture({ home: null });
  const local = { getURL: () => LOCAL_PAGE };
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: ["audio"] }, local), true);
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: [] }, local), true, "guarded display capture");
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: ["video"] }, local), false);
  assert.equal(ask("notifications", { requestingUrl: LOCAL_PAGE, isMainFrame: true }, local), true);
  // No requesting URL: the window's own address decides, as before.
  assert.equal(ask("notifications", {}, local), true);
  assert.equal(check("clipboard-read", "", { isMainFrame: true }, local), true);
  assert.equal(check("clipboard-read", "https://other.example", { isMainFrame: true }, local), false);
});

// ── What a page is told when its microphone is refused ──
// perm:status answers `pageMic` for the asking page, so a blocked Live call
// can say who blocked it: this app (then a web browser can make the call) or
// the computer (then its privacy settings can). The answer is the request
// handler's own, never a second copy of the rule.
const ipcFrom = (contents, frameUrl, { mainFrame = true } = {}) => {
  const frame = { url: frameUrl };
  if (mainFrame) contents.mainFrame = frame;
  else contents.mainFrame ??= { url: contents.getURL() };
  return { sender: contents, senderFrame: frame };
};
const pageMicFixture = () => {
  const state = { home: CLOUD, main: { getURL: () => `${CLOUD}/chat?botId=bot-1` } };
  const handlers = appPermissionHandlers({ rendererOrigin: () => LOCAL_ORIGIN, mainContents: () => state.main, cloudHomeOrigin: () => state.home });
  return { state, handlers };
};

test("a page asking about its microphone hears whether this app lets it use it", () => {
  const { state, handlers } = pageMicFixture();
  assert.equal(handlers.pageMicrophone(ipcFrom(state.main, `${CLOUD}/chat?botId=bot-1`)), "allowed", "the verified Cloud");
  const local = { getURL: () => LOCAL_PAGE };
  assert.equal(handlers.pageMicrophone(ipcFrom(local, LOCAL_PAGE)), "allowed", "this computer's own page");
  state.main = { getURL: () => "https://my-vps.example.com/chat" };
  assert.equal(handlers.pageMicrophone(ipcFrom(state.main, "https://my-vps.example.com/chat")), "refused", "another server");
});

test("the Cloud's page is refused where its microphone request would be", () => {
  const { state, handlers } = pageMicFixture();
  assert.equal(handlers.pageMicrophone(ipcFrom(state.main, `${CLOUD}/frame`, { mainFrame: false })), "refused", "a subframe");
  const other = { getURL: () => `${CLOUD}/` };
  assert.equal(handlers.pageMicrophone(ipcFrom(other, `${CLOUD}/`)), "refused", "another window");
  assert.equal(handlers.pageMicrophone({ sender: state.main, senderFrame: null }), "refused", "a frame that is gone");
  assert.equal(handlers.pageMicrophone(undefined), "refused", "no sender");
  state.home = null;
  assert.equal(handlers.pageMicrophone(ipcFrom(state.main, `${CLOUD}/chat`)), "refused", "signed out of Cloud");
});

// The request may decide later (Electron's callback allows it), so the test
// waits for its answer rather than reading it as the call returns.
test("the page's answer is the request handler's answer for its microphone", async () => {
  const { state, handlers } = pageMicFixture();
  const local = { getURL: () => LOCAL_PAGE };
  const other = { getURL: () => `${CLOUD}/` };
  for (const home of [CLOUD, null, "https://evil.fly.dev"]) {
    state.home = home;
    for (const contents of [state.main, local, other]) {
      for (const url of [`${CLOUD}/chat`, LOCAL_PAGE, "https://my-vps.example.com/", "http://omb-u-0123456789ab.fly.dev/"]) {
        for (const mainFrame of [true, false]) {
          const granted = await new Promise((resolve) => {
            handlers.request(contents, "media", resolve, { requestingUrl: url, isMainFrame: mainFrame, mediaTypes: ["audio"] });
          });
          const label = JSON.stringify({ home, page: contents.getURL(), url, mainFrame });
          assert.equal(await handlers.pageMicrophone(ipcFrom(contents, url, { mainFrame })), granted ? "allowed" : "refused", label);
        }
      }
    }
  }
});

test("the app installs these handlers, with the Cloud the sign-in verified", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /setPermissionRequestHandler\(appPermissions\.request\)/);
  assert.match(main, /setPermissionCheckHandler\(appPermissions\.check\)/);
  assert.match(main, /ipcMain\.handle\("perm:status", \(event\) => \(\{[^}]*pageMic: appPermissions\?\.pageMicrophone\(event\) \?\? "refused",/s);
  assert.match(main, /cloudHomeOrigin: \(\) => desktopRemoteAccess \? null : cloudAccount\?\.homeTarget\(\)\?\.origin \?\? null/);
});
