// While this app is open, each of the person's own Clouds hears how this computer is and asks for it when a bot there
// needs it: the app's own prompt comes up once per ask, and Turn on, there or on the card, does here what it takes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ownCloud } from "./cloud-list.mjs";
import { createComputerAsks, QUIET_AFTER_NOT_NOW_MS } from "./computer-asks.mjs";
import { createComputerSharing } from "./computer-sharing.mjs";
import { createLendingTarget } from "./lending-target.mjs";
import { createAskPrompt } from "./ask-prompt.mjs";

const HOME = "https://omb-u-fixture.fly.dev", TEAM = "https://omb-t-acme.fly.dev";
const myCloud = { id: "my-cloud", name: "My Cloud", origin: HOME, home: true };
const acme = { id: "acme", name: "Acme team", origin: TEAM, team: { id: "t-acme", role: "owner" } };
const READY = { ready: true, lent: true, reason: null, fix: null };
const BLOCKED = { ready: false, lent: false, reason: "blocked", fix: "start" };

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

/** A Cloud that takes asks: what this computer said each poll, and the asks it answers with. */
function cloudHome() {
  const json = value => ({ ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), connects: [], polls: [], asks: [], version: 0 };
  state.say = asks => { state.asks = asks; state.version++; };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: ["admin", "client"], cloudHome: true });
    if (route === "/.well-known/openmausbot/environment") {
      return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, lendingDetails: true, deviceLink: true, myChromeLink: true, computerAsks: true } });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route === "/api/shared-computers/asks") {
      state.polls.push(body);
      if (body.heard === state.version) await delay(40, undefined, { signal: init?.signal }).catch(() => {});
      init?.signal?.throwIfAborted();
      return json({ version: state.version, asks: state.asks });
    }
    if (route.endsWith("/poll")) { await delay(40, undefined, { signal: init?.signal }).catch(() => {}); init?.signal?.throwIfAborted(); return json({ job: null }); }
    return json({ ok: true });
  };
  return state;
}

function session() {
  const state = { status: "connected", account: { id: "acct_1" }, machine: { status: "ready", origin: HOME }, clouds: [
    { id: "c-home", origin: HOME, teamId: null, role: "owner", primary: true },
    { id: "c-team", origin: TEAM, teamId: "t-acme", role: "owner" },
  ] };
  return { state: () => state, isOwnCloud: origin => state.machine?.origin === origin || state.clouds.some(cloud => ownCloud(cloud) && cloud.origin === origin) };
}

async function computer(t, { homes, places = [myCloud], screen = () => READY, prompt = async () => null, startScreen = async () => READY, confirmTerminal = async () => false }) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-computer-asks-")));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const account = session();
  const target = createLendingTarget({ account: () => account, environments: () => places });
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), environments: () => places, enabled: async () => false, home: path.join(dir, "home"),
    fetch: (url, init) => homes[new URL(url).origin].fetch(url, init),
    cloud: target.cloud, myCloud: target.environment, ownClouds: target.places, screen, prompt, startScreen, confirmTerminal,
    hostControl: async () => ({ renew: async () => {}, release: async () => {} }),
    WebSocket: class { close() {} send() {} },
  });
  t.after(() => sharing.close());
  return sharing;
}

const ask = (fields = {}) => ({ id: "ask-1", need: "screen", reason: "paused", bot: "Scout", why: "Open the invoice in Excel", state: "asking", turnOn: 0, ...fields });

test("paused, this computer still tells its own Cloud so, and the card's Turn on resumes it", async t => {
  const homes = { [HOME]: cloudHome() };
  const prompts = [];
  const sharing = await computer(t, { homes, prompt: async (env, entry) => { prompts.push([env.id, entry.id]); return null; } });
  sharing.start();
  await until(() => homes[HOME].connects.length === 1, "lending to start");
  sharing.pause();
  await until(() => homes[HOME].polls.some(poll => poll.paused === true), "My Cloud to hear that this computer is paused");
  assert.deepEqual(homes[HOME].polls.at(-1).screen, { ready: true, reason: null });
  homes[HOME].say([ask()]);
  await until(() => prompts.length === 1, "the app's own prompt");
  homes[HOME].say([ask({ state: "turning-on", turnOn: 1 })]);
  await until(() => !sharing.paused(), "Turn on to resume this computer");
  await until(() => homes[HOME].connects.length === 2, "lending to come back");
  assert.equal(homes[HOME].connects[1].computer, true);
  await delay(150);
  assert.equal(prompts.length, 1, "one prompt per ask");
});

test("screen control isn't running: Turn on starts it, and a start that fails tells the Cloud why", async t => {
  const homes = { [HOME]: cloudHome() };
  let status = BLOCKED, starts = 0, fixed = false;
  const sharing = await computer(t, { homes, screen: () => status, startScreen: async () => { starts++; if (fixed) status = READY; return status; } });
  sharing.start();
  await until(() => homes[HOME].polls.some(poll => poll.screen.reason === "blocked"), "My Cloud to hear why apps and screen aren't lent");
  homes[HOME].say([ask({ reason: "blocked", state: "turning-on", turnOn: 1 })]);
  await until(() => homes[HOME].polls.some(poll => poll.answers.some(answer => answer.outcome === "failed")), "the failure to reach the Cloud");
  assert.deepEqual(homes[HOME].polls.find(poll => poll.answers.length).answers, [{ id: "ask-1", outcome: "failed", reason: "blocked" }]);
  assert.equal(starts, 1);
  fixed = true;
  homes[HOME].say([ask({ reason: "blocked", state: "turning-on", turnOn: 2 })]);
  await until(() => starts === 2, "Try again to start it again");
  await sharing.screenChanged();
  await until(() => homes[HOME].connects.some(connect => connect.computer === true), "apps and screen to be lent");
  await until(() => homes[HOME].polls.at(-1).screen.ready === true, "the Cloud to hear it works");
});

test("the app's own prompt: Turn on there acts at once, Not now keeps it quiet for that Cloud and need", async () => {
  const answers = [], acted = [];
  let choice = "turn-on";
  const prompts = [];
  const asks = createComputerAsks({ prompt: async (_env, entry) => { prompts.push(entry.id); return choice; }, turnOn: async (_env, entry) => { acted.push(entry.id); return { ok: true }; },
    answered: () => {}, now: () => 1_000 });
  const env = { id: "my-cloud", name: "My Cloud" };
  asks.heard(env, [ask()]);
  await until(() => acted.length === 1, "Turn on to act");
  answers.push(...asks.pending(env.id));
  assert.deepEqual(answers, [{ id: "ask-1", outcome: "turning-on" }]);
  asks.sent(env.id, answers);
  asks.heard(env, [ask({ state: "turning-on" })]);
  await delay(10);
  assert.deepEqual([prompts, acted], [["ask-1"], ["ask-1"]], "nothing comes up or runs twice");

  choice = "not-now";
  asks.heard(env, [ask({ id: "ask-2" })]);
  await until(() => asks.pending(env.id).length === 1, "Not now to go back");
  assert.deepEqual(asks.pending(env.id), [{ id: "ask-2", outcome: "declined" }]);
  asks.heard(env, [ask({ id: "ask-3" })]);
  asks.heard(env, [ask({ id: "ask-4", need: "terminal", reason: "terminal-off" })]);
  await delay(10);
  assert.deepEqual(prompts, ["ask-1", "ask-2", "ask-4"], `quiet for ${QUIET_AFTER_NOT_NOW_MS / 60_000} minutes for the same need only`);
  asks.heard(env, [ask({ id: "ask-5", reason: "starting" })]);
  await delay(10);
  assert.equal(prompts.includes("ask-5"), false, "nothing to turn on while it starts by itself");
});

test("a prompt closes when the ask was answered elsewhere, and doesn't come up while the person looks at that Cloud", async () => {
  const closed = [];
  let shownTimes = 0;
  const asks = createComputerAsks({ prompt: (_env, _entry, signal) => { shownTimes++; return new Promise(resolve => signal.addEventListener("abort", () => { closed.push(true); resolve(null); })); },
    turnOn: async () => ({ ok: true }) });
  const env = { id: "my-cloud", name: "My Cloud" };
  asks.heard(env, [ask()]);
  await delay(5);
  asks.heard(env, [ask()]);
  asks.heard(env, [ask()]);
  await delay(5);
  assert.equal(shownTimes, 1, "the same ask heard again while its prompt is up never shows another");
  asks.heard(env, [ask(), ask({ id: "ask-other", need: "folders" })]);
  await delay(5);
  assert.equal(shownTimes, 1, "one prompt at a time for a Cloud: another ask waits until it closes");
  asks.heard(env, []);
  await until(() => closed.length === 1, "the prompt to close");

  const shown = [];
  const dialog = { showMessageBox: async (...args) => { shown.push(args); return { response: 0 }; } };
  const focused = { isDestroyed: () => false, isFocused: () => true, isVisible: () => true, show: () => {}, webContents: { getURL: () => `${HOME}/chat` } };
  const prompt = createAskPrompt({ dialog, window: () => focused, platform: "win32" });
  assert.equal(await prompt({ id: "my-cloud", name: "My Cloud", origin: HOME }, ask(), new AbortController().signal), null, "the card is right there");
  assert.equal(await prompt({ id: "client", name: "Client A", origin: "https://omb-c-a.fly.dev" }, ask(), new AbortController().signal), "turn-on");
  assert.equal(shown.at(-1).length, 1, "a PC's prompt has no parent window, so it shows even with the app in the tray");
  const mac = createAskPrompt({ dialog, window: () => null, platform: "darwin" });
  assert.equal(await mac({ id: "client", name: "Client A", origin: "https://omb-c-a.fly.dev" }, ask(), new AbortController().signal), null,
    "on a Mac only a window's sheet can be closed again, so no window, no prompt");
});

test("a Team Cloud never hears this computer", async t => {
  const homes = { [HOME]: cloudHome(), [TEAM]: cloudHome() };
  const sharing = await computer(t, { homes, places: [myCloud, acme] });
  sharing.start();
  await until(() => homes[HOME].polls.length > 0, "My Cloud to hear this computer");
  await delay(100);
  assert.equal(homes[TEAM].polls.length, 0);
});
