// The X card in the real Apps pop-up, against fake-engine servers and one loopback stand-in for both treg and the
// MausBot Cloud relay: no real treg key, account or call.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const RELAY_PATH = "/api/cloud/services/x", PLAN_TOKEN = "omb_x_verify_fixture", OWN_KEY = "treg_verify_fixture_key";
const month = { calls: 312, max: 5_000, resetsAt: "2026-11-01T00:00:00.000Z" };
let usedUp = false;

async function serveStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers["x-treg-token"] === OWN_KEY && req.url === "/auth/me") return send(200, { org_id: "org-verify" });
    if (req.headers["x-treg-token"] === OWN_KEY && req.url === "/orgs/org-verify/balance?limit=1") return send(200, { balance_micro: 4_250_000 });
    if (req.headers.authorization === `Bearer ${PLAN_TOKEN}` && req.url === `${RELAY_PATH}/usage`) {
      return send(200, usedUp ? { ...month, calls: month.max, usedUp: true } : month);
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const stub = await serveStub();
const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-x-connector-evidence";
mkdirSync(output, { recursive: true });
const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
const opened: Array<{ fixture: VerificationServer; ui: MountedPreview }> = [];

async function open(plan: boolean) {
  const fixture = await launchVerificationServer({ ...process.env, OMB_TREG_URL: stub.url,
    ...(plan ? { OMB_CLOUD_X_URL: `${stub.url}${RELAY_PATH}`, OMB_CLOUD_X_TOKEN: PLAN_TOKEN } : {}) });
  const ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__x.html", title: "Isolated X card",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: true, mode: "managed", source: "curated",
          cards: [["gmail", "Gmail", "gmail.com"], ["slack", "Slack", "slack.com"], ["twitter", "X (Twitter)", "x.com"]].map(([slug, label, domain]) => ({ slug, label, blurb: "Connect your account", logo: null, domain })) }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
    ],
  });
  opened.push({ fixture, ui });
  const pairing = await fixtureApi(fixture.info.url)("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, cookie: true, label: "X card fixture" }) })).status, pairing.code), 200);
  await page.reload();
  const card = page.locator('[data-app-tile="x"]');
  await card.waitFor();
  return { page, card, errors };
}

const shot = async (page: any, card: any, name: string) => {
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, `${name}.png`) });
  await card.screenshot({ path: join(output, `${name}-card.png`) });
};
const state = (card: any, value: string) => card.locator(`xpath=self::*[@data-x-state="${value}"]`).waitFor();

try {
  // Neither a key nor a plan: add a treg key.
  const own = await open(false);
  await state(own.card, "none");
  assert.equal(await own.page.locator('[data-app-tile="twitter"]').count(), 0, "the managed install's dead Twitter tile is gone");
  await own.card.getByText("Add your treg key", { exact: true }).waitFor();
  assert.equal(await own.card.locator('a[href="https://treg.to"]').count(), 1);
  await shot(own.page, own.card, "1-no-key");
  await own.card.getByRole("textbox", { name: "treg key" }).fill(OWN_KEY);
  await own.card.getByRole("button", { name: "Save", exact: true }).click();
  await own.card.getByText("treg is working ✓ Balance: $4.25.", { exact: true }).waitFor();
  await state(own.card, "own");
  await own.card.getByText("Using your treg key", { exact: true }).waitFor();
  await shot(own.page, own.card, "2-own-key");
  await own.card.getByRole("button", { name: "Remove key", exact: true }).click();
  await state(own.card, "none");
  assert.deepEqual(own.errors, []);

  // A Cloud plan: included, with this month's use.
  const plan = await open(true);
  await state(plan.card, "included");
  await plan.card.getByText("Included with your plan", { exact: true }).waitFor();
  await plan.card.getByText("312 of 5,000 X calls this month. They reset on November 1.", { exact: true }).waitFor();
  await shot(plan.page, plan.card, "3-included");
  await plan.card.getByRole("button", { name: "Use my own treg key", exact: true }).click();
  await plan.card.getByRole("textbox", { name: "treg key" }).fill(OWN_KEY);
  await plan.card.getByRole("button", { name: "Save", exact: true }).click();
  await state(plan.card, "own");
  await plan.card.getByText(/Your own treg key is used first/).waitFor();
  await shot(plan.page, plan.card, "4-both-own-first");
  await plan.card.getByRole("button", { name: "Remove key", exact: true }).click();
  await state(plan.card, "included");
  usedUp = true;
  await plan.page.getByRole("button", { name: "Refresh connection status", exact: true }).click();
  await plan.card.getByText(/This month's included X calls are used up/).waitFor();
  assert.equal(await plan.card.getByRole("textbox", { name: "treg key" }).count(), 1);
  await shot(plan.page, plan.card, "5-used-up");
  await plan.page.setViewportSize({ width: 390, height: 844 });
  await plan.card.scrollIntoViewIfNeeded();
  await plan.page.screenshot({ path: join(output, "6-narrow.png") });
  assert.equal(await plan.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(plan.errors, []);
  console.log(JSON.stringify({ passed: true, evidence: output, liveTregTested: false }));
} finally {
  await browser.close();
  for (const { ui, fixture } of opened) { await ui.close(); await fixture.close(); }
  stub.server.close();
}
