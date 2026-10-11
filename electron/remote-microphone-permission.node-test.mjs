import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { appPermissionHandlers } from "./app-permissions.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");

// A Live call on a self-hosted server (#2424): the active saved server hears
// the microphone only after the person allowed it, asked on its first request.
const LOCAL = "http://127.0.0.1:48993";
const VPS = "https://viernes.tail1.ts.net:9444";
const OTHER = "https://other.tail1.ts.net:9444";
const AUDIO = { isMainFrame: true, mediaTypes: ["audio"] };
const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The real appPermissionHandlers fed by the real environments authority, with
// main's dialog replaced by `ctx.answer` ("allow", "deny" or null for no dialog).
function harness(envState) {
  const mainContents = { getURL: () => "" };
  const ctx = { state: envState, main: mainContents, answer: null, asked: [] };
  const handlers = appPermissionHandlers({
    rendererOrigin: () => LOCAL,
    mainContents: () => ctx.main,
    cloudHomeOrigin: () => null,
    activeRemoteOrigin: () => environments.activeEnvironment(ctx.state)?.origin ?? null,
    activeRemoteMicrophone: () => environments.activeEnvironment(ctx.state)?.microphone === true,
    askRemoteMicrophone: (origin) => {
      ctx.asked.push(origin);
      if (ctx.answer === null) return null;
      return Promise.resolve().then(() => {
        if (typeof ctx.beforeAnswer === "function") ctx.beforeAnswer();
        const env = environments.activeEnvironment(ctx.state);
        if (ctx.answer === "allow" && env?.origin === origin) ctx.state = environments.withMicrophone(ctx.state, env.id);
      });
    },
  });
  const request = (url, details = AUDIO, contents = mainContents, permission = "media") =>
    new Promise((resolve) => handlers.request(contents, permission, resolve, { requestingUrl: url, ...details }));
  const check = (origin, details = AUDIO) => handlers.check(mainContents, "media", origin, details);
  const pageMic = (url) => {
    const frame = { url };
    return handlers.pageMicrophone({ sender: Object.assign(mainContents, { mainFrame: frame }), senderFrame: frame });
  };
  return { ctx, request, check, pageMic, mainContents };
}

let state = environments.withEnvironment({ environments: [], activeId: environments.LOCAL_ID }, { origin: VPS, name: "VPS" }, () => "vps");
state = environments.withEnvironment(state, { origin: OTHER, name: "Other" }, () => "other");
const viewing = (id, s = state) => environments.withActive(s, id);

test("a saved server's page is refused the microphone until the person allows it", async () => {
  const h = harness(viewing("vps"));
  assert.equal(await h.request(`${VPS}/chat`), false, "no dialog to ask: refused");
  assert.equal(h.check(VPS), false, "check never grants unasked");
  assert.equal(h.pageMic(`${VPS}/chat`), "refused", "pageMic reads only a remembered answer");
  h.ctx.answer = "deny";
  assert.equal(await h.request(`${VPS}/chat`), false, "Don't Allow");
  assert.deepEqual(h.ctx.asked, [VPS, VPS], "asked for the exact active origin");
  assert.equal(environments.activeEnvironment(h.ctx.state).microphone, undefined, "nothing remembered");
});

test("an address typed before pairing gets no microphone on its own (the review's repro)", async () => {
  const typed = environments.parseHostedWorkspaceLink("stranger-server.example.com");
  let s = environments.withEnvironment({ environments: [], activeId: environments.LOCAL_ID }, { origin: typed.origin }, () => "typed");
  s = environments.withActive(s, "typed");
  const h = harness(s);
  assert.equal(await h.request(`${typed.origin}/`), false);
  assert.equal(h.check(typed.origin), false);
});

test("once allowed, the active server hears the microphone: main frame, main window, audio only", async () => {
  const h = harness(viewing("vps"));
  h.ctx.answer = "allow";
  assert.equal(await h.request(`${VPS}/chat?botId=bot-1`), true, "granted after the person allowed it");
  assert.equal(h.ctx.asked.length, 1);
  assert.equal(await h.request(`${VPS}/chat`), true, "remembered: not asked again");
  assert.equal(h.ctx.asked.length, 1);
  assert.equal(h.check(VPS, { isMainFrame: true, mediaType: "audio" }), true, "check");
  assert.equal(h.pageMic(`${VPS}/chat`), "allowed");
  for (const details of [{ isMainFrame: true, mediaTypes: ["video"] }, { isMainFrame: true, mediaTypes: ["audio", "video"] },
    { isMainFrame: true, mediaTypes: [] }, { isMainFrame: true, mediaType: "video" }, { isMainFrame: true }, { isMainFrame: false, mediaTypes: ["audio"] },
    { mediaTypes: ["audio"] }]) {
    assert.equal(await h.request(`${VPS}/`, details), false, JSON.stringify(details));
    assert.equal(h.check(VPS, details), false, JSON.stringify(details));
  }
  assert.equal(await h.request(`${VPS}/`, AUDIO, { getURL: () => `${VPS}/` }), false, "another window");
  for (const url of [OTHER, "https://viernes.tail1.ts.net:9445/", "http://viernes.tail1.ts.net:9444/", "https://viernes.tail1.ts.net.evil.test:9444/", "about:blank", ""]) {
    assert.equal(await h.request(url), false, url);
  }
  assert.equal(h.ctx.asked.length, 1, "only the active origin's own request ever asks");
  assert.equal(await h.request(`${VPS}/`, AUDIO, h.mainContents, "camera"), false, "never another permission");
});

test("the answer belongs to one server: no carry-over on a switch, and forgetting takes it back", async () => {
  const h = harness(viewing("vps"));
  h.ctx.answer = "allow";
  assert.equal(await h.request(`${VPS}/`), true);
  h.ctx.answer = null;
  h.ctx.state = environments.withActive(h.ctx.state, "other");
  assert.equal(await h.request(`${OTHER}/`), false, "the other server is not allowed by VPS's answer");
  assert.equal(await h.request(`${VPS}/`), false, "nor VPS while it is not active");
  h.ctx.state = environments.withActive(h.ctx.state, environments.LOCAL_ID);
  assert.equal(await h.request(`${LOCAL}/`), true, "Local keeps its microphone");
  h.ctx.state = environments.withActive(h.ctx.state, "vps");
  assert.equal(await h.request(`${VPS}/`), true, "back on VPS: still allowed");
  // Forget, then pair the same address again: asked afresh.
  h.ctx.state = environments.withoutEnvironment(h.ctx.state, "vps");
  assert.equal(await h.request(`${VPS}/`), false, "forgotten");
  h.ctx.state = environments.withActive(environments.withEnvironment(h.ctx.state, { origin: VPS }, () => "vps2"), "vps2");
  assert.equal(await h.request(`${VPS}/`), false, "re-added: not remembered");
});

test("a switch while the dialog is open refuses the waiting request", async () => {
  const h = harness(viewing("vps"));
  h.ctx.answer = "allow";
  h.ctx.beforeAnswer = () => { h.ctx.state = environments.withActive(h.ctx.state, "other"); };
  assert.equal(await h.request(`${VPS}/`), false);
});

test("the answer is saved with the server and survives a restart, only as true", () => {
  const allowed = environments.withMicrophone(viewing("vps"), "vps");
  const restored = environments.parseEnvironments(environments.serializeEnvironments(allowed));
  assert.equal(environments.activeEnvironment(restored).microphone, true);
  assert.equal(restored.environments.find((e) => e.id === "other").microphone, undefined);
  const damaged = environments.parseEnvironments({ environments: [{ id: "vps", origin: VPS, microphone: "yes" }], activeId: "vps" });
  assert.equal(environments.activeEnvironment(damaged).microphone, undefined, "anything but true is no");
  assert.equal(environments.withMicrophone(allowed, "missing"), allowed, "unknown id changes nothing");
});

test("main asks through its dialog, remembers on the record and clears a refusal on forget", () => {
  assert.match(mainSource, /activeRemoteMicrophone: \(\) => activeEnvironment\(environmentsState\)\?\.microphone === true,/);
  assert.match(mainSource, /\n    askRemoteMicrophone,\n/);
  assert.match(mainSource, /persistEnvironments\(withMicrophone\(environmentsState, env\.id\)\)/);
  assert.match(mainSource, /sharingController\(\)\.forget\(env\);\n  remoteMicrophoneRefused\.delete\(env\.origin\);/);
  assert.match(mainSource, /defaultId: 1,\n        cancelId: 1,\n        message: `Allow “\$\{env\.name\}” to use the microphone\?`/, "Don't Allow is the default");
});
