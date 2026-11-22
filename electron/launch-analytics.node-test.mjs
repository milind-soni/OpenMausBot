import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchAnalytics, launchAnalyticsAllowed } from "./launch-analytics.mjs";

const ON = { packaged: true, env: {} };

function launch({ choice = null, lastVersion = null, version = "0.1.170", packaged = true, env = {}, platform = "darwin" } = {}) {
  const sent = [];
  let clock = 1_000;
  const analytics = createLaunchAnalytics({
    fetch: async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true }; },
    choice: () => choice, lastVersion, version, platform, packaged, env, now: () => clock, id: "launch-id",
  });
  return { analytics, sent, tick: (ms) => { clock += ms; } };
}

test("each stage of one launch is sent once, under that launch's own id, with no person profile", () => {
  const { analytics, sent, tick } = launch();
  analytics.stage("started", { hidden: false });
  tick(1_500);
  analytics.stage("server_spawned");
  analytics.stage("server_spawned");
  tick(2_000);
  analytics.stage("server_ready");
  analytics.stage("window_shown", { reason: "painted" });
  assert.deepEqual(sent.map(({ body }) => body.properties.stage), ["started", "server_spawned", "server_ready", "window_shown"]);
  assert.equal(sent[0].url, "https://us.i.posthog.com/i/v0/e/");
  const [first, , ready, shown] = sent.map(({ body }) => body);
  assert.equal(first.event, "desktop_launch");
  assert.equal(first.distinct_id, "launch-id");
  assert.deepEqual(first.properties, {
    stage: "started", ms: 0, first_launch: true, updated: false, hidden: false, app_version: "0.1.170", platform: "desktop", surface: "main",
    $os: "Mac OS X", $process_person_profile: false,
  });
  assert.equal(ready.properties.ms, 3_500);
  assert.equal(shown.properties.reason, "painted");
});

test("a failed server says why in a word from its list, and a main-window crash counts while other pages do not", () => {
  const { analytics, sent } = launch({ lastVersion: "0.1.169" });
  analytics.serverFailed("timeout");
  analytics.stage("server_failed");
  analytics.crashed({ kind: "renderer", surface: "auxiliary", reason: "crashed" });
  analytics.crashed({ kind: "renderer", surface: "main-window", reason: "clean-exit" });
  analytics.crashed({ kind: "child", reason: "oom" });
  analytics.crashed({ kind: "renderer", surface: "main-window", reason: "/Users/ada/secret" });
  assert.deepEqual(sent.map(({ body }) => [body.properties.stage, body.properties.reason]), [["server_failed", "timeout"], ["page_crashed", "other"]]);
  assert.equal(sent[0].body.properties.first_launch, false);
  assert.equal(sent[0].body.properties.updated, true);
  analytics.stage("not-a-stage");
  assert.equal(sent.length, 2);
});

test("nothing is sent with the switch off, in development, under the smoke tests or in CI", () => {
  for (const options of [{ choice: false }, { packaged: false }, { env: { OMB_SMOKE_TEST: "1" } }, { env: { CI: "true" } }]) {
    const { analytics, sent } = launch(options);
    analytics.stage("started");
    analytics.stage("server_failed");
    assert.equal(sent.length, 0, JSON.stringify(options));
  }
});

test("with no choice kept, only a first launch or one after a version that kept page opt-outs sends", () => {
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: true, firstLaunch: false, lastVersion: "0.1.1" }), true);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: false, firstLaunch: true, lastVersion: null }), false);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: null, firstLaunch: true, lastVersion: null }), true);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: null, firstLaunch: false, lastVersion: "0.1.113" }), true);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: null, firstLaunch: false, lastVersion: "0.2.0" }), true);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: null, firstLaunch: false, lastVersion: "0.1.112" }), false);
  assert.equal(launchAnalyticsAllowed({ ...ON, choice: null, firstLaunch: false, lastVersion: "garbage" }), false);
});

test("a send that throws or rejects never reaches the launch", async () => {
  for (const fetch of [() => { throw new Error("offline"); }, async () => { throw new Error("offline"); }]) {
    const analytics = createLaunchAnalytics({ fetch, choice: () => true, lastVersion: null, version: "1.0.0", platform: "win32", packaged: true, env: {} });
    assert.doesNotThrow(() => analytics.stage("started"));
  }
  await new Promise((resolve) => setImmediate(resolve));
});
