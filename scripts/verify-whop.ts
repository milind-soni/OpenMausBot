// Real registry, OAuth and renderer; no real Whop account or financial calls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeOAuth } from "../server/testing/fake-oauth-server.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

const fixture = await launchVerificationServer();
const oauth = await startFakeOAuth();
const mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge,
  tools: [{ name: "list_products", inputSchema: { type: "object", properties: {} } }] });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  // An unrelated existing name must survive Connect untouched.
  await api("POST", "/api/mcp/servers", { name: "whop", command: "node", args: ["unrelated-fixture.mjs"], enabled: false });
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  let authorizationUrl = "";
  let failCreate = true;
  let failTest = false;
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__whop.html", title: "Isolated Whop integration",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: false, mode: "self-hosted", source: "curated", cards: ["gmail", "slack", "notion"].map((slug) => ({ slug, label: slug === "gmail" ? "Gmail" : slug[0].toUpperCase() + slug.slice(1), blurb: "Connect your account", logo: null, domain: null })) }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
      { path: /^\/api\/mcp\/servers(?:\/.*)?$/, handler: async (req, res) => {
      const path = req.url!;
      if (req.method === "POST" && path === "/api/mcp/servers" && failCreate) {
        failCreate = false;
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"Synthetic save failure"}');
        return;
      }
      if (req.method === "POST" && path.endsWith("/test") && failTest) {
        failTest = false;
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":false,"error":"Synthetic discovery failure"}');
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      // Only the fixture substitutes transport: production always saves the official URL.
      if (raw) { const body = JSON.parse(raw); if (body.url === "https://mcp.whop.com/mcp") body.url = mcp.url; raw = JSON.stringify(body); }
      const response = await fetch(`${fixture.info.url}${path}`, { method: req.method,
        headers: { "content-type": "application/json", cookie: req.headers.cookie ?? "", "x-forwarded-for": "192.0.2.10" },
        ...(raw ? { body: raw } : {}),
      });
      const body = await response.json();
      for (const server of body.servers ?? []) if (server.url === mcp.url) server.url = "https://mcp.whop.com/mcp";
      if (req.method === "POST" && path.endsWith("/sign-in") && response.ok) {
        authorizationUrl = body.auth.authorizationUrl;
        body.auth.authorizationUrl = "https://oauth.example.test/authorize";
      }
      res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
    } }],
  });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
  const context = await (browser as any).newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Whop fixture" }) })).status, pairing.code), 200);
  await page.reload();
  const connect = () => page.getByRole("button", { name: "Connect Whop", exact: true }).click();
  const row = page.locator('[data-app-tile="whop"]');
  assert.equal(await page.locator('[data-apps-grid] [data-app-tile="whop"]').count(), 1);
  assert.equal(await page.getByText("Set up Whop", { exact: true }).count(), 0);
  const status = async () => (await api("GET", "/api/mcp/servers")).servers;
  // This browser is not on the server's machine and the fixture has no https
  // address to come back to, so the paste-back box is shown up front.
  const pasteBack = () => page.getByText("After you approve, your browser shows a page that can't load. Copy that page's full address and paste it here.", { exact: true });
  const complete = async () => {
    await pasteBack().waitFor();
    assert.equal(await page.getByText("Signing in from another computer?", { exact: true }).count(), 0);
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    await page.getByRole("textbox", { name: "Redirect URL", exact: true }).fill(approved.headers.get("location")!);
    await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  };
  await connect();
  await page.getByRole("alert").getByText("Synthetic save failure", { exact: true }).waitFor();
  assert.equal((await status()).length, 1);
  await connect();
  await pasteBack().waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await connect();
  oauth.options.deny = true;
  await complete();
  await row.getByRole("button", { name: "Connect Whop", exact: true }).waitFor();
  assert.equal((await status()).length, 2, "Retry reuses the same entry");
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  oauth.options.deny = false;
  await connect();
  await complete();
  await row.getByText("Connected", { exact: true }).waitFor();
  const connected = (await status()).find((server: any) => server.name === "whop-2");
  assert.equal(connected.auth, "signed-in");
  assert.equal(connected.enabled, true);
  assert.ok(mcp.seenHeaders.some((headers) => oauth.isValid(headers.authorization)));
  const bearer = mcp.seenHeaders.find((headers) => oauth.isValid(headers.authorization))!.authorization!.replace(/^Bearer /, "");
  assert.equal(JSON.stringify(connected).includes(bearer), false, "The browser listing never includes the token");
  assert.equal(mcp.calls.length, 0, "Connecting never executes business tools");
  assert.equal((await status()).find((server: any) => server.name === "whop").command, "node");
  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-whop-evidence";
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "connected.png"), fullPage: true });
  await page.locator('[data-apps-filter="connected"]').click();
  await row.getByText("Connected", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-apps-filter="connected"]').innerText(), "Connected 1");
  assert.equal(await page.locator('[data-app-tile="gmail"]').count(), 0);
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).click();
  await row.waitFor({ state: "hidden" });
  await page.locator('[data-apps-filter="all"]').click();
  await connect(); await complete();
  await row.getByText("Connected", { exact: true }).waitFor();
  await page.reload();
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).waitFor();
  assert.equal(await page.locator("[data-whop-setup]").count(), 0);
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).click();
  await row.getByRole("button", { name: "Connect Whop", exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  assert.ok(oauth.counts.revoke > 0);
  assert.equal(await page.getByText("Whop is connected and enabled. Bot access follows each bot’s MCP server selection.", { exact: true }).count(), 0);
  assert.equal(await row.getByText(/list_products/).count(), 0);
  // A successful login alone must not claim the tool connection is ready.
  failTest = true;
  await connect(); await complete();
  await page.getByText("Signed in, but Whop’s tools could not be loaded. Please connect again to retry.", { exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  await connect(); await complete();
  await row.getByText("Connected", { exact: true }).waitFor();
  const search = page.getByRole("textbox", { name: "Search apps", exact: true });
  await search.fill("whop");
  assert.equal(await row.isVisible(), true);
  assert.equal(await page.locator('[data-app-tile="gmail"]').count(), 0);
  await search.fill("gmail");
  assert.equal(await row.isVisible(), false);
  await search.fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "narrow.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, liveWhopAccountTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await mcp.close(); await oauth.close(); await fixture.close();
}
