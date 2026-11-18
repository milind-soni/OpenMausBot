import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createComputerSharing } from "./computer-sharing.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "omb-sharing-persistence-"));
  const file = path.join(dir, "computer-sharing.json");
  const env = { id: "fixture-cloud", origin: "https://cloud.fixture.test", name: "Fixture" };
  const grant = { id: randomUUID(), secret: "a".repeat(64), sessionId: randomUUID(), environmentId: randomUUID(), enabled: true,
    folders: [], terminal: false, computer: false, internet: true, chrome: true, cloud: { accountId: "fixture-account", origin: env.origin } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: { [env.id]: grant }, automatic: { paused: false } }));
  const summaries = [], connects = [], polls = [];
  const polled = Promise.withResolvers();
  const controllers = [];
  const options = {
    file, home: dir, environments: () => [env],
    cloud: () => ({ status: "connected", accountId: "fixture-account", origin: env.origin }),
    onChange: summary => summaries.push(summary),
    async fetch(url, { signal }) {
      const route = new URL(url).pathname;
      if (route === "/api/auth/session") return Response.json({ kind: "session", id: grant.sessionId, cloudHome: true, scopes: ["admin"] });
      if (route === "/.well-known/openmausbot/environment") return Response.json({ environmentId: grant.environmentId, capabilities: { sharedComputers: true } });
      if (route === "/api/shared-computers/connect") connects.push(url);
      if (route.endsWith("/poll")) await new Promise((resolve, reject) => {
        polls.push(signal);
        polled.resolve();
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return Response.json({ ok: true });
    },
  };
  t.after(() => { for (const controller of controllers) controller.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, env, summaries, connects, polls, polled: polled.promise,
    make(overrides = {}) { const controller = createComputerSharing({ ...options, ...overrides }); controllers.push(controller); return controller; },
    saved: () => JSON.parse(fs.readFileSync(file, "utf8")),
    block: () => fs.mkdirSync(`${file}.tmp`),
    unblock: () => fs.rmdirSync(`${file}.tmp`),
  };
}

test("a failed Pause save stops active sharing and reports that the pause is not saved", async t => {
  const f = fixture(t), sharing = f.make();
  sharing.start();
  await f.polled;
  f.block();
  const write = fs.writeFileSync;
  let stoppedBeforeSave;
  t.mock.method(fs, "writeFileSync", (...args) => {
    if (args[0] === `${f.file}.tmp`) stoppedBeforeSave = f.polls[0].aborted;
    return write(...args);
  });
  sharing.pause();
  assert.equal(stoppedBeforeSave, true, "work stops before the save is attempted");
  assert.equal(sharing.paused(), true);
  assert.equal(f.polls[0].aborted, true);
  assert.equal(sharing.lendingToCloud(), false);
  assert.equal(f.saved().automatic.paused, false);
  assert.match(f.summaries.at(-1).pauseError, /not saved/i);
});

test("Pause retries a failed save while sharing stays paused", async t => {
  const f = fixture(t), sharing = f.make();
  f.block();
  sharing.pause();
  f.unblock();
  sharing.pause();
  assert.equal(f.saved().automatic.paused, true);
  assert.equal(f.summaries.at(-1).pauseError, undefined);
  sharing.close();
  assert.equal(f.make().paused(), true);
});

test("a terminal confirmation after a failed Pause save cannot resume lending", async t => {
  const f = fixture(t), sharing = f.make({ ownClouds: () => [f.env] });
  sharing.start();
  await f.polled;
  f.block();
  sharing.pause();
  f.unblock();
  await sharing.lendTerminal(true);
  assert.equal(sharing.paused(), true);
  assert.equal(sharing.lendingToCloud(), false);
  assert.equal(f.connects.length, 1);
  assert.equal(f.saved().automatic.paused, true);
  assert.equal(f.saved().automatic.terminalAccount, "fixture-account");
  sharing.close();
  const restarted = f.make({ ownClouds: () => [f.env] });
  restarted.start();
  await restarted.screenChanged();
  assert.equal(restarted.paused(), true);
  assert.equal(f.connects.length, 1);
});

test("Resume stays paused if its save fails and can be retried", async t => {
  const f = fixture(t), sharing = f.make();
  sharing.pause();
  f.block();
  await sharing.resume();
  assert.equal(sharing.paused(), true);
  assert.equal(sharing.lendingToCloud(), false);
  assert.equal(f.saved().automatic.paused, true);
  assert.match(f.summaries.at(-1).pauseError, /not saved/i);
  f.unblock();
  await sharing.resume();
  assert.equal(sharing.paused(), false);
  assert.equal(f.saved().automatic.paused, false);
  assert.equal(f.summaries.at(-1).pauseError, undefined);
});

test("the tray reports an unsaved pause and offers a save retry alongside Resume", () => {
  let tray, retries = 0;
  class Tray {
    constructor() { tray = this; }
    setToolTip(value) { this.tooltip = value; }
    setTitle(value) { this.title = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return false; }
    on() {}
    destroy() {}
  }
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    iconPath: "fixture.png", onPause: () => retries++, onResume() {}, onActivity() {} });
  try {
    indicator.update({ clouds: ["Fixture"], using: [], paused: true });
    indicator.update({ clouds: ["Fixture"], using: [], paused: true, pauseError: "Pause is not saved. Retry saving pause." });
    assert.match(tray.tooltip, /not saved/);
    assert.match(tray.title, /save/i);
    const retry = tray.menu.find(item => item.label === "Retry saving pause");
    assert.ok(retry);
    retry.click();
    assert.equal(retries, 1);
    assert.ok(tray.menu.some(item => item.label === "Resume"));
    assert.equal(tray.menu.some(item => item.type === "checkbox"), false);
  } finally { indicator.destroy(); }
});
