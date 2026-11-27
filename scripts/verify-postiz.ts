// Real registry, OAuth, MCP and renderer against two stand-in Postiz backends; no real Postiz account, page or post.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { FAKE_POSTIZ_KEY, startFakePostiz } from "../server/testing/fake-postiz.ts";

const cloud = await startFakePostiz();
const own = await startFakePostiz();
const fixture = await launchVerificationServer({ ...process.env, OMB_POSTIZ_CLOUD_URL: cloud.url });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  let authorizationUrl = "";
  const cards = [
    ["gmail", "Gmail", "Communication"], ["slack", "Slack", "Communication"], ["notion", "Notion", "Productivity"],
    ["googlecalendar", "Google Calendar", "Productivity"], ["twitter", "X (Twitter)", "Social"], ["reddit", "Reddit", "Social"],
  ].map(([slug, label, category]) => ({ slug, label, blurb: "Connect your account", logo: null, domain: null, categories: [category] }));
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__postiz.html", title: "Isolated Postiz integration",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: true, mode: "self-hosted", source: "curated", cards }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
      // The stand-in signs in over loopback http, which the card never opens: the page is shown Postiz Cloud's https
      // consent address, and this fixture visits the stand-in's own on the person's behalf.
      { path: "/api/mcp/servers/postiz/sign-in", method: "POST", handler: async (req, res) => {
        const response = await fetch(`${fixture.info.url}/api/mcp/servers/postiz/sign-in`, { method: "POST", headers: { "content-type": "application/json", cookie: req.headers.cookie ?? "" } });
        const body = await response.json();
        if (response.ok && body.auth?.authorizationUrl) {
          authorizationUrl = body.auth.authorizationUrl;
          body.auth.authorizationUrl = `https://platform.postiz.com/oauth/authorize${new URL(authorizationUrl).search}`;
        }
        res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
      } },
    ],
  });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined, args: ["--use-mock-keychain"] });
  const context = await (browser as any).newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("dialog", (dialog: { accept(): Promise<void> }) => void dialog.accept());
  // The sign-in tab opens as a stand-in, so nothing here reaches the real Postiz site.
  await page.addInitScript(() => { window.open = () => ({ closed: false, opener: null, location: { replace() {} }, close() {} }) as unknown as Window; });
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Postiz fixture" }) })).status, pairing.code), 200);
  await page.reload();
  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-postiz-evidence";
  mkdirSync(output, { recursive: true });
  // Pills and buttons fade between colours: a shot waits for them to settle.
  const shot = async (name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: join(output, `${name}.png`) }); };
  const card = page.locator('[data-app-tile="postiz"]');
  const servers = async () => (await api("GET", "/api/mcp/servers")).servers;

  await card.getByRole("button", { name: "Connect Postiz", exact: true }).waitFor();
  await page.locator('[data-apps-category="Social"]').click();
  await card.waitFor();
  assert.deepEqual(await page.locator("[data-apps-grid] h3").allInnerTexts(), ["Social"]);
  await shot("1-social-category");

  // Sign in with Postiz (the default).
  await card.getByRole("button", { name: "Connect Postiz", exact: true }).click();
  await card.getByText("Finish signing in to Postiz in your browser.", { exact: true }).waitFor();
  await shot("2-sign-in-waiting");
  const back = (await fetch(authorizationUrl, { redirect: "manual" })).headers.get("location")!;
  assert.match(await (await fetch(back)).text(), /Signed in/u);
  await card.getByText(`Connected to ${new URL(cloud.url).host}`, { exact: true }).waitFor();
  await shot("3-connected-sign-in");
  const signedIn = (await servers()).find((server: { name: string }) => server.name === "postiz");
  assert.equal(signedIn.auth, "signed-in");
  assert.equal(signedIn.enabled, true);
  const token = cloud.issued.at(-1)!;
  assert.equal((await page.content()).includes(token), false, "The page never holds the token");
  assert.equal(cloud.calls.length, 0, "Connecting runs no Postiz tool");

  await card.getByRole("button", { name: "Postiz options", exact: true }).click();
  await page.locator('[role="menuitem"][data-menu-key="disconnect"]').click();
  await card.getByRole("button", { name: "Connect Postiz", exact: true }).waitFor();
  assert.equal((await servers()).length, 0);

  // An API key instead, for a person's own Postiz.
  await card.getByRole("button", { name: "Use an API key instead", exact: true }).click();
  await card.getByRole("textbox", { name: "Postiz server address (optional)", exact: true }).fill(own.url);
  await card.getByLabel("Postiz API key", { exact: true }).fill("not-the-key");
  await card.locator('form[data-postiz-key-form] button[type="submit"]').click();
  await card.getByRole("alert").getByText("Postiz didn’t accept this API key. Copy it again from Postiz → Settings → Public API.", { exact: true }).waitFor();
  await shot("4-key-refused");
  assert.equal((await servers()).length, 0, "A refused key saves nothing");
  await card.getByLabel("Postiz API key", { exact: true }).fill(FAKE_POSTIZ_KEY);
  await shot("5-key-form");
  await card.locator('form[data-postiz-key-form] button[type="submit"]').click();
  await card.getByText(`Connected to ${new URL(own.url).host} with an API key`, { exact: true }).waitFor();
  await shot("6-connected-key");
  await page.locator('[data-apps-filter="all"]').click();
  await card.scrollIntoViewIfNeeded();
  await shot("7-all-apps-connected");
  assert.equal((await page.content()).includes(FAKE_POSTIZ_KEY), false, "The page never holds the key");
  assert.equal((await servers()).find((server: { name: string }) => server.name === "postiz").url, `${own.url}/mcp`);

  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, livePostizAccountTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await fixture.close(); await cloud.close(); await own.close();
}
