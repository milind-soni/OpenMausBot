import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { appPermissionAllowed, appPermissionHandlers, externalWebUrl, remoteClipboardWriteAllowed } from "./app-permissions.mjs";
import { cloudPlanSnapshot, createCloudAccountClient } from "./cloud-account.mjs";
import { myCloudOrigin, rememberedCloudHome } from "./cloud-home.mjs";

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
// the person's own page hearing it. Only that and clipboard writes (its copy
// buttons): in the main frame of the main window, at the exact origin the
// verified Cloud sign-in reports. Every other server, and every other
// capability, stays refused.
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

test("the Cloud never gets the camera, screen capture or any other capability but clipboard writes", () => {
  const { ask, check } = cloudFixture();
  for (const mediaTypes of [["video"], ["audio", "video"], [], ["unknown"]]) {
    assert.equal(ask("media", onCloud({ mediaTypes })), false, JSON.stringify(mediaTypes));
  }
  assert.equal(ask("media", onCloud()), false, "media with no type");
  assert.equal(check("media", CLOUD, { isMainFrame: true, mediaType: "video" }), false);
  assert.equal(check("media", CLOUD, { isMainFrame: true, mediaType: "unknown" }), false);
  for (const permission of ["notifications", "clipboard-read", "fullscreen", "geolocation", "display-capture", "camera"]) {
    assert.equal(ask(permission, onCloud()), false, permission);
    assert.equal(check(permission, CLOUD, { isMainFrame: true }), false, permission);
    // Audio details on another permission do not make it the microphone.
    assert.equal(ask(permission, onCloud({ mediaTypes: ["audio"] })), false, `${permission} with audio details`);
    assert.equal(check(permission, CLOUD, { isMainFrame: true, mediaType: "audio" }), false, `${permission} with audio details`);
  }
});

test("the Cloud's microphone is decided by this computer's media rule, never a copy of it", () => {
  // One rule says what counts as the microphone. The Cloud only narrows it
  // (its own origin, the main frame, no screen capture), so a new media
  // shape this computer accepts or refuses is accepted or refused on the Cloud too.
  const { ask } = cloudFixture();
  const shapes = [
    {}, { mediaType: "audio" }, { mediaType: "video" }, { mediaTypes: ["audio"] }, { mediaTypes: ["audio", "audio"] },
    { mediaTypes: ["video"] }, { mediaTypes: ["audio", "video"] }, { mediaTypes: ["audio"], mediaType: "video" },
    { mediaTypes: null }, { mediaTypes: "audio" }, { mediaTypes: [""] },
  ];
  for (const shape of shapes) {
    assert.equal(ask("media", onCloud(shape)), appPermissionAllowed("media", CLOUD, CLOUD, shape), JSON.stringify(shape));
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

test("the verified Cloud open in this window may write the clipboard, by the remote server's rule", () => {
  const write = "clipboard-sanitized-write";
  const { state, ask, check } = cloudFixture();
  // The Grok sign-in card's copy button, on My Cloud.
  assert.equal(ask(write, onCloud()), true);
  assert.equal(check(write, CLOUD, { requestingUrl: `${CLOUD}/`, isMainFrame: true }), true);
  // Never reading it.
  assert.equal(ask("clipboard-read", onCloud()), false);
  assert.equal(check("clipboard-read", CLOUD, { isMainFrame: true }), false);
  // Never a subframe, or no frame information.
  assert.equal(ask(write, onCloud({ isMainFrame: false })), false, "a subframe");
  assert.equal(check(write, CLOUD, { isMainFrame: false }), false, "a subframe");
  assert.equal(check(write, CLOUD, {}), false, "no frame information");
  // Never another origin.
  for (const other of ["https://my-vps.example.com", "http://omb-u-0123456789ab.fly.dev", "https://omb-u-0123456789ab.fly.dev:8443", "https://evil.fly.dev"]) {
    assert.equal(ask(write, { requestingUrl: `${other}/chat`, isMainFrame: true }), false, other);
    assert.equal(check(write, other, { isMainFrame: true }), false, other);
  }
  // Never another window, or with no window at all.
  assert.equal(ask(write, onCloud(), { getURL: () => `${CLOUD}/` }), false, "another window");
  assert.equal(check(write, CLOUD, { isMainFrame: true }, null), false, "no window");
  // Signed out of Cloud (no Cloud), or a damaged value: withdrawn at once.
  for (const home of [null, "not a url", "about:blank"]) {
    state.home = home;
    assert.equal(ask(write, onCloud()), false, String(home));
    assert.equal(check(write, CLOUD, { isMainFrame: true }), false, String(home));
  }
  state.home = CLOUD;
  state.main = null;
  assert.equal(ask(write, onCloud(), { getURL: () => `${CLOUD}/` }), false, "the main window is gone");
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

test("the app installs these handlers, with its one rule for My Cloud and a wait for the saved sign-in", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /setPermissionRequestHandler\(appPermissions\.request\)/);
  assert.match(main, /setPermissionCheckHandler\(appPermissions\.check\)/);
  // perm:status's pageMic asks these very handlers: one module-level set,
  // never a second const that would leave perm:status answering "refused".
  assert.match(main, /ipcMain\.handle\("perm:status", \(event\) => \(\{[^}]*pageMic: appPermissions\?\.pageMicrophone\(event\) \?\? "refused",/s);
  assert.match(main, /^let appPermissions = null;$/m);
  assert.match(main, /^  appPermissions = appPermissionHandlers\(\{$/m);
  assert.doesNotMatch(main, /(const|let|var) appPermissions = appPermissionHandlers/);
  assert.match(main, /cloudHomeOrigin: myCloud,\n/);
  assert.match(main, /cloudHomeRestoring: \(\) => cloudAccountRestoring \? cloudAccountRestored\(\) : null,\n/);
  // One definition of "my Cloud": the Cloud page's own channels ask it too,
  // and nothing else in main compares a remembered Cloud's account.
  assert.equal(main.match(/myCloudOrigin\(/g)?.length, 1);
  assert.match(main, /cloudPageSenderAllowed\(event, \{ contents, homeOrigin: myCloud\(\),/);
  assert.doesNotMatch(main, /rememberedHome\??\.accountId/);
  assert.doesNotMatch(main, /remembered: true/);
  // The flag covers exactly the restore it waits for.
  assert.match(main, /cloudAccountRestoring = true;\n\s+cloudAccountStarted = ensureCloudAccount\(\)\.start\(\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ cloudAccountRestoring = false; \}\);/);
});

// ── My Cloud: one rule, decided once the saved sign-in has restored ──
// The app's own wiring (main.mjs), end to end: the real Cloud sign-in client
// restoring a saved record against a stand-in OpenMausBot Cloud, the Cloud remembered
// for its account as main remembers it, and the handlers asking myCloudOrigin,
// the same rule the Cloud page's Settings → Plan channels use.
const ADMIN = "http://127.0.0.1:9";
const ACCOUNT = { id: "account-1", email: "person@example.test" };
function myCloudFixture() {
  const f = { now: 1_800_000_000_000, remembered: null, remoteAccess: null, restoring: null, admin: "ready", answers: [] };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86_400_000, device: { id: "device-1" }, account: ACCOUNT });
  f.saved = { origin: ADMIN, token: `omc_${"T".repeat(43)}`, ...identity() };
  delete f.saved.cloudContractVersion;
  // `f.cloud`: the machine OpenMausBot Cloud names for this account (null: none).
  f.cloud = { state: "ready", origin: CLOUD };
  const session = () => ({ ...identity(), cloud: f.cloud,
    entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 30 * 86_400_000, version: 1 } });
  // OpenMausBot Cloud answers now ("ready"), later (a promise the test releases),
  // not at all ("down"), or that this computer's sign-in no longer counts ("ended").
  const fetch = async (url, { method = "GET" } = {}) => {
    if (!url.endsWith("/api/cloud/desktop/session")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    if (method === "DELETE") return Response.json({ revoked: true });
    if (f.admin === "down") throw new TypeError("fetch failed");
    if (f.admin === "ended") return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
    if (f.admin !== "ready") await f.admin;
    return Response.json(session());
  };
  f.client = createCloudAccountClient({ origin: ADMIN, fixture: true, deviceName: "Fixture computer", platform: "darwin", now: () => f.now, fetch,
    store: { read: async () => f.saved, write: async (value) => { f.saved = value; } }, openBrowser: async () => {},
    onState: (state) => { f.remembered = rememberedCloudHome(f.remembered, state); }, setTimer: () => 1, clearTimer: () => {} });
  const main = { getURL: () => `${CLOUD}/chat?botId=bot-1` };
  const handlers = appPermissionHandlers({
    rendererOrigin: () => LOCAL_ORIGIN,
    mainContents: () => main,
    cloudHomeOrigin: () => myCloudOrigin({ account: f.client, remembered: f.remembered, remoteAccess: f.remoteAccess }),
    cloudHomeRestoring: () => f.restoring,
  });
  f.restore = () => { f.restoring = f.client.start().finally(() => { f.restoring = null; }); return f.restoring; };
  // The answer, once given: undefined while the request is still waiting.
  f.ask = (permission, details) => {
    const answer = { value: undefined };
    answer.done = new Promise((resolve) => handlers.request(main, permission, (granted) => { answer.value = granted; resolve(granted); }, details));
    f.answers.push(answer);
    return answer;
  };
  f.check = (details = { isMainFrame: true, mediaType: "audio" }) => handlers.check(main, "media", CLOUD, details);
  return f;
}
const MIC = onCloud({ mediaTypes: ["audio"] });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a Live call placed while the saved sign-in is still restoring hears the microphone once it has", async () => {
  const f = myCloudFixture();
  let answer;
  f.admin = new Promise((resolve) => { answer = resolve; });
  const restored = f.restore();
  const mic = f.ask("media", MIC);
  const camera = f.ask("media", onCloud({ mediaTypes: ["video"] }));
  await settle();
  assert.equal(mic.value, undefined, "decided once the sign-in has restored, not refused for being early");
  assert.equal(camera.value, false, "anything but the microphone is refused at once, never waited on");
  answer();
  await restored;
  assert.equal(await mic.done, true);
  // Restored: decided at once from then on.
  assert.equal(f.ask("media", MIC).value, true);
  assert.equal(f.check(), true);
});

test("a restore that ends without this Cloud, or outlasts the wait, refuses rather than waiting on", async () => {
  const f = myCloudFixture();
  // OpenMausBot Cloud does not answer at launch: nothing says this page is My Cloud.
  f.admin = "down";
  const restored = f.restore();
  const mic = f.ask("media", MIC);
  await restored;
  assert.equal(await mic.done, false);
  // main caps the wait (5 s): once it ends, the request is decided with what is known.
  f.admin = new Promise(() => {});
  f.restore();
  f.restoring = Promise.resolve();
  assert.equal(await f.ask("media", MIC).done, false);
});

test("with OpenMausBot Cloud unreachable past the verified window, the same account's Cloud keeps the microphone", async () => {
  const f = myCloudFixture();
  await f.restore();
  assert.equal(f.client.homeTarget()?.origin, CLOUD);
  f.admin = "down";
  f.now += 20 * 60_000;
  await f.client.refresh();
  assert.equal(f.client.state().message, "verification-expired");
  assert.equal(f.client.homeTarget(), null, "no verified Cloud to connect to");
  assert.equal(f.ask("media", MIC).value, true, "but this account's Cloud is still the person's own");
  assert.equal(f.check(), true);
  // Signing out takes it away at once, reachable or not.
  await f.client.signOut();
  assert.equal(f.ask("media", MIC).value, false);
  assert.equal(f.check(), false);
});

test("signed out, the Cloud's page never hears the microphone", async () => {
  const f = myCloudFixture();
  f.saved = null;
  await f.restore();
  assert.equal(f.client.state().status, "signed-out");
  assert.equal(f.ask("media", MIC).value, false);
  const g = myCloudFixture();
  await g.restore();
  assert.equal(g.ask("media", MIC).value, true);
  await g.client.signOut();
  assert.equal(g.ask("media", MIC).value, false);
});

test("a Cloud remembered for another account is not this account's Cloud", async () => {
  const f = myCloudFixture();
  f.admin = "down";
  await f.restore();
  assert.equal(f.client.state().account?.id, ACCOUNT.id);
  f.remembered = { accountId: "someone-else", origin: CLOUD };
  assert.equal(myCloudOrigin({ account: f.client, remembered: f.remembered, remoteAccess: null }), null);
  assert.equal(f.ask("media", MIC).value, false);
  f.remembered = { accountId: ACCOUNT.id, origin: CLOUD };
  assert.equal(f.ask("media", MIC).value, true);
});

test("companion client mode has no Cloud of its own, so no Cloud page hears the microphone", async () => {
  const f = myCloudFixture();
  await f.restore();
  assert.equal(f.ask("media", MIC).value, true);
  f.remoteAccess = { endpoint: "https://relay.example.test", serverName: "Office Mac", deviceId: "device-2" };
  assert.equal(myCloudOrigin({ account: f.client, remembered: f.remembered, remoteAccess: f.remoteAccess }), null);
  assert.equal(f.ask("media", MIC).value, false);
  assert.equal(f.check(), false);
  assert.equal(myCloudOrigin({ account: null, remembered: f.remembered, remoteAccess: null }), null, "no Cloud sign-in on this computer");
});

test("a check that finds no Cloud for this account ends it, for the microphone and the Plan channels alike", async () => {
  const f = myCloudFixture();
  await f.restore();
  assert.equal(f.ask("media", MIC).value, true);
  // OpenMausBot Cloud answers for this account and names no machine: the
  // address it named before is no longer theirs, whatever serves it now.
  f.cloud = null;
  await f.client.refresh();
  assert.equal(f.client.state().status, "connected");
  assert.equal(myCloudOrigin({ account: f.client, remembered: f.remembered, remoteAccess: null }), null);
  assert.equal(f.ask("media", MIC).value, false);
  assert.equal(f.check(), false);
  // A failed check after that does not bring it back.
  f.admin = "down";
  await f.client.refresh();
  assert.equal(f.ask("media", MIC).value, false);
});

test("a stopped Cloud named without its address is still this account's Cloud", async () => {
  // OpenMausBot Cloud still names the machine, so the Server menu's My Cloud
  // keeps opening through the Cloud's own connection (cloud-home.mjs isCloudHomeEntry).
  const f = myCloudFixture();
  await f.restore();
  f.cloud = { state: "stopped", origin: null };
  await f.client.refresh();
  assert.equal(f.client.homeTarget(), null);
  assert.equal(f.ask("media", MIC).value, true);
});

test("after the sign-in has ended or expired, the same account's Cloud keeps the microphone until sign-out", async () => {
  // The rule the Cloud page's Settings → Plan uses to say "sign in again on
  // your computer" (cloudPlanSnapshot "signin"), not an error; signing out,
  // another account or restarting the app ends it (kept in memory only).
  const ended = myCloudFixture();
  await ended.restore();
  ended.admin = "ended";
  await ended.client.refresh();
  assert.deepEqual([ended.client.state().status, ended.client.state().message], ["reauth-required", "access-ended"]);
  assert.equal(cloudPlanSnapshot(ended.client.state()).status, "signin");
  assert.equal(ended.ask("media", MIC).value, true);
  await ended.client.signOut();
  assert.equal(ended.ask("media", MIC).value, false);

  const expired = myCloudFixture();
  await expired.restore();
  expired.now = expired.client.state().expiresAt + 1;
  await expired.client.refresh();
  assert.deepEqual([expired.client.state().status, expired.client.state().message], ["reauth-required", "expired"]);
  assert.equal(expired.ask("media", MIC).value, true);
  await expired.client.signOut();
  assert.equal(expired.ask("media", MIC).value, false);
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

const REMOTE = "https://viernes.tail1.ts.net:9444";

test("a remote server may write clipboard text only as the active origin's main frame", () => {
  const write = "clipboard-sanitized-write";
  assert.equal(remoteClipboardWriteAllowed(write, `${REMOTE}/chat?x=1`, REMOTE, { isMainFrame: true }), true);
  assert.equal(remoteClipboardWriteAllowed(write, REMOTE, `${REMOTE}/`, { isMainFrame: true }), true);
  // Read and everything else stay denied for the same trusted origin.
  for (const permission of ["clipboard-read", "notifications", "fullscreen", "media", "geolocation", "camera", "openExternal", "unknown", undefined]) {
    assert.equal(remoteClipboardWriteAllowed(permission, REMOTE, REMOTE, { isMainFrame: true }), false, String(permission));
  }
  // Frame requirement: a child frame, or no frame information, never counts.
  for (const details of [{ isMainFrame: false }, {}, undefined, null, { isMainFrame: "true" }]) {
    assert.equal(remoteClipboardWriteAllowed(write, REMOTE, REMOTE, details), false);
  }
  // Exact origin only.
  for (const requesting of [
    "https://viernes.tail1.ts.net:9445/", "https://viernes.tail1.ts.net/", "http://viernes.tail1.ts.net:9444/",
    "https://other.tail1.ts.net:9444/", "https://viernes.tail1.ts.net.evil.test:9444/", "https://evil.test/#https://viernes.tail1.ts.net:9444",
    "about:blank", "data:text/html,x", "javascript:alert(1)", "not a url", "", null, undefined,
  ]) assert.equal(remoteClipboardWriteAllowed(write, requesting, REMOTE, { isMainFrame: true }), false, String(requesting));
  // No active remote server (Local, or a damaged value): nothing to match.
  for (const active of [undefined, null, "", "not a url", "about:blank", "data:text/html,x"]) {
    assert.equal(remoteClipboardWriteAllowed(write, REMOTE, active, { isMainFrame: true }), false, String(active));
    assert.equal(remoteClipboardWriteAllowed(write, "about:blank", active, { isMainFrame: true }), false);
  }
});

test("the base policy itself still grants a remote origin nothing", () => {
  for (const permission of ["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]) {
    assert.equal(appPermissionAllowed(permission, REMOTE, LOCAL_ORIGIN, { isMainFrame: true }), false, permission);
  }
});
