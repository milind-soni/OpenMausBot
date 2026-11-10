import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview } from "./testing/preview-fixture.ts";
import { ensureUiBrowser, sessionEnv, agentBrowser } from "./testing/control-omb-ui.ts";

const fixture = await launchVerificationServer();
let mode: "healthy" | "blocked" | "auth" | "network" = "healthy";
let delay = 0;
const requests: string[] = [];
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let closeBrowser: (() => Promise<unknown>) | undefined;
const evidence = join(import.meta.dirname, "..", ".omb-scratch", "usage-status");
mkdirSync(evidence, { recursive: true });
try {
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/usage-status-preview.tsx", route: "/__usage-status.html", title: "Usage status fixture",
    extraRoutes: [{ path: /^\/api\//, async handler(req, res) {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET" || !req.url?.startsWith("/api/limit-resets")) {
        res.statusCode = 403; res.end(JSON.stringify({ error: "Fixture rejects unrelated requests" })); return;
      }
      requests.push(req.url);
      const current = mode;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (current === "network") { res.destroy(); return; }
      const blocked = current === "blocked" || current === "auth";
      const resetsAt = Date.now() + 86_400_000;
      res.end(JSON.stringify({ checkedAt: Date.now(), checkedEngines: current === "auth" ? [] : ["codexWork"], engines: [{ engine: "codexWork", name: "Fixture Codex", driver: "codex", blocked,
        window: "5-hour", usedPercent: blocked ? 100 : 15, resetsAt,
        windows: [{ window: "5-hour", usedPercent: blocked ? 100 : 15, resetsAt }],
      }], ...(current === "auth" ? { errors: { codexWork: "Sign in again in Codex" } } : {}) }));
    } }],
  });
  const browser = await ensureUiBrowser();
  const socket = join(fixture.info.dataDir, "ab");
  mkdirSync(socket, { recursive: true });
  const env = { ...sessionEnv({ home: fixture.info.dataDir, session: `u${process.pid}`, chrome: browser.chrome }), AGENT_BROWSER_SOCKET_DIR: socket };
  const command = (...args: string[]) => agentBrowser(browser.binary, env, args);
  closeBrowser = () => command("close");
  const evaluate = async (js: string) => (await command("eval", js)).result;
  const wait = (js: string) => command("wait", "--fn", js);
  const click = () => command("find", "role", "button", "click", "--name", "Refresh status");
  await command("open", preview.previewUrl);
  await command("set", "viewport", "390", "844");
  await wait("document.querySelector('[data-usage-check]') !== null");
  assert.match(String(await evaluate("document.body.innerText")), /85% left/);
  mode = "blocked"; delay = 1500;
  const before = requests.length;
  await click();
  assert.equal(await evaluate("document.querySelector('[data-usage-check]').disabled"), true);
  await evaluate("for(let i=0;i<5;i++) document.querySelector('[data-usage-check]').click()");
  await wait("!document.querySelector('[data-usage-check]').disabled");
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1), "/api/limit-resets?refresh=1");
  assert.match(String(await evaluate("document.body.innerText")), /At its limit/);
  delay = 0; mode = "auth";
  await click();
  await wait("document.querySelector('[role=alert]') !== null");
  assert.match(String(await evaluate("document.querySelector('[role=alert]').innerText")), /Sign in again/i);
  assert.match(String(await evaluate("document.body.innerText")), /At its limit/);
  mode = "network";
  await click();
  await wait("document.querySelector('[role=alert]') !== null");
  assert.match(String(await evaluate("document.body.innerText")), /At its limit/);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await command("screenshot", join(evidence, "refresh-error-mobile.png"));
  mode = "healthy";
  await click();
  await wait("document.querySelector('[role=status]') !== null && document.querySelector('[role=alert]') === null");
  assert.match(String(await evaluate("document.body.innerText")), /85% left/);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await command("screenshot", join(evidence, "refreshed-mobile.png"));
  const result = { ok: true, requests, logPath: fixture.info.logPath, evidence };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  try { await closeBrowser?.(); } finally {
    try { await preview?.close(); } finally { await fixture.close(); }
  }
}
