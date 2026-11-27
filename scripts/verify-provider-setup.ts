// Offline install → detect → sign in → ready with the real renderer/store.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceInfo } from "../src/state/store.tsx";
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview } from "./testing/preview-fixture.ts";
import { ensureUiBrowser, sessionEnv, agentBrowser } from "./testing/control-omb-ui.ts";

const fixture = await launchVerificationServer();
const engine: InstanceInfo = {
  instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi",
  models: { default: "fixture", options: [] },
  snapshot: { state: "unavailable", reason: "Fixture CLI is not installed." },
  install: { platform: "linux", command: { linux: "echo fixture-only" }, signInCommand: "echo fixture-sign-in" },
};
let offline = false;
let reads = 0;
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let closeBrowser: (() => Promise<unknown>) | undefined;
try {
  // Inspect the actual isolated server, not only the presentation fixture.
  const live = await fetch(`${fixture.info.url}/api/instances`).then((response) => response.json()) as { instances: InstanceInfo[] };
  assert.ok(live.instances.some((instance) => instance.install?.platform === process.platform));
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/provider-setup-preview.tsx", route: "/__provider-setup.html", title: "Provider setup fixture",
    extraRoutes: [{ path: /^\/api\/instances(?:\/.*)?$/, handler(req, res) {
      res.setHeader("content-type", "application/json");
      // Never let an installer or auth mutation escape this offline fixture.
      if (req.method !== "GET") { res.statusCode = 403; res.end(JSON.stringify({ error: "Fixture forbids provider mutations" })); return; }
      reads++;
      res.statusCode = offline ? 503 : 200;
      res.end(JSON.stringify(offline ? { error: "Fixture server offline" } : { instances: [engine] }));
    } }],
  });
  const browser = await ensureUiBrowser();
  const socket = join(fixture.info.dataDir, "ab");
  mkdirSync(socket, { recursive: true });
  const env = { ...sessionEnv({ home: fixture.info.dataDir, session: `p${process.pid}`, chrome: browser.chrome }), AGENT_BROWSER_SOCKET_DIR: socket };
  const command = (...args: string[]) => agentBrowser(browser.binary, env, args);
  closeBrowser = () => command("close");
  const evaluate = async (js: string) => (await command("eval", js)).result;
  await command("open", preview.previewUrl);
  await command("wait", "--fn", "document.querySelector('[data-engine-card=kimi]') !== null");
  await command("set", "viewport", "390", "844");
  await command("eval", "document.querySelector('[data-engine-card=kimi]').open = true");
  const check = () => command("find", "role", "button", "click", "--name", "Check again");
  assert.match(String(await evaluate("document.body.innerText")), /Set up Kimi/);
  offline = true;
  await check();
  await command("wait", "--fn", "document.body.innerText.includes('previous status is still shown')");
  assert.match(String(await evaluate("document.body.innerText")), /Fixture CLI is not installed/);
  offline = false;
  engine.snapshot = { state: "available", authenticated: false, version: "fixture 1.0.0" };
  await check();
  await command("wait", "--fn", "document.body.innerText.includes('Sign in to Kimi')");
  assert.match(String(await evaluate("document.body.innerText")), /Sign-in required/);
  assert.equal(await evaluate("document.querySelector('[data-engine-card=kimi]').open"), true);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  const evidence = join(import.meta.dirname, "..", ".omb-scratch", "provider-setup");
  mkdirSync(evidence, { recursive: true });
  await command("screenshot", join(evidence, "sign-in.png"));
  engine.snapshot = { state: "available", authenticated: true, version: "fixture 1.0.0" };
  // Same action a person returning from Terminal causes. No page/app restart.
  await command("eval", "window.dispatchEvent(new Event('focus'))");
  await command("wait", "--fn", "document.body.innerText.includes('Ready to use')");
  assert.equal(await evaluate("document.querySelector('[data-engine-card=kimi]').open"), true);
  const result = { ok: true, reads, transitions: ["missing", "refresh-failed", "installed-sign-in-required", "ready-on-focus"], console: await command("console"), logPath: fixture.info.logPath };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  try { await closeBrowser?.(); } finally {
    try { await preview?.close(); } finally { await fixture.close(); }
  }
}
