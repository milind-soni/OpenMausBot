// Real registry, renderer and tools check behind the four bot contact cards; a loopback fake stands in for Vapi, so no
// real Vapi account, key or call is used.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

const VAPI = "https://mcp.vapi.ai/mcp";
const fixture = await launchVerificationServer();
const mcp = await startFakeHttpMcp({ acceptBearer: (authorization) => authorization === "Bearer good-key",
  tools: [{ name: "create_call", inputSchema: { type: "object", properties: {} } }] });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__contact-cards.html", title: "Isolated bot contact cards",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: false, mode: "self-hosted", source: "curated", cards: [] }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
      { path: /^\/api\/mcp\/servers(?:\/.*)?$/, handler: async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        // Only the fixture substitutes transport: production always saves the official URL.
        if (raw) { const body = JSON.parse(raw); if (body.url === VAPI) body.url = mcp.url; raw = JSON.stringify(body); }
        const response = await fetch(`${fixture.info.url}${req.url}`, { method: req.method,
          headers: { "content-type": "application/json", cookie: req.headers.cookie ?? "", "x-forwarded-for": "192.0.2.10" },
          ...(raw ? { body: raw } : {}),
        });
        const body = await response.json();
        for (const server of body.servers ?? []) if (server.url === mcp.url) server.url = VAPI;
        res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
      } },
    ],
  });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
  const context = await (browser as any).newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Contact cards fixture" }) })).status, pairing.code), 200);
  await page.reload();
  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-contact-cards-evidence";
  mkdirSync(output, { recursive: true });
  const status = async () => (await api("GET", "/api/mcp/servers")).servers as Array<Record<string, unknown>>;
  const vapi = page.locator('[data-app-tile="vapi"]');

  for (const id of ["agentmail", "agentphone", "vapi", "telnyx"]) await page.locator(`[data-app-tile="${id}"]`).waitFor();
  assert.equal(await page.locator('[data-app-tile="agentmail"] input').count(), 0, "AgentMail signs in with the browser, no key field");
  assert.equal(await page.locator('[data-app-tile="telnyx"]').getByLabel("Telnyx API key", { exact: true }).count(), 1);
  assert.equal(await vapi.getByRole("button", { name: "Connect Vapi", exact: true }).isDisabled(), true, "no key, no Connect");
  await vapi.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "cards.png"), fullPage: true });

  await vapi.getByLabel("Vapi API key", { exact: true }).fill("wrong-key");
  await vapi.getByRole("button", { name: "Connect Vapi", exact: true }).click();
  await vapi.getByRole("alert").getByText("Vapi didn’t accept that key. Check it and connect again.", { exact: true }).waitFor();
  const refused = (await status()).find((server) => server.name === "vapi")!;
  assert.equal(refused.enabled, false, "a refused key leaves the server off");
  assert.deepEqual(refused.headerKeys, ["Authorization"]);
  assert.equal(refused.url, mcp.url, "the key rides in a header; the saved address is the endpoint alone");
  assert.doesNotMatch(JSON.stringify(await status()), /wrong-key/);
  await page.screenshot({ path: join(output, "refused.png"), fullPage: true });

  await vapi.getByLabel("Vapi API key", { exact: true }).fill("good-key");
  await vapi.getByRole("button", { name: "Connect Vapi", exact: true }).click();
  await vapi.getByLabel("Connected", { exact: true }).waitFor();
  const servers = await status();
  assert.equal(servers.filter((server) => server.url === mcp.url).length, 1, "the same server took the new key");
  assert.equal(servers.find((server) => server.name === "vapi")!.enabled, true);
  assert.doesNotMatch(JSON.stringify(servers), /good-key/);
  assert.equal(await page.locator('[data-apps-filter="connected"]').innerText(), "1 connected");
  await page.screenshot({ path: join(output, "connected.png"), fullPage: true });

  await vapi.getByRole("button", { name: "Disconnect Vapi", exact: true }).click();
  await vapi.getByLabel("Vapi API key", { exact: true }).waitFor();
  assert.equal((await status()).some((server) => server.name === "vapi"), false, "Disconnect deletes the server and its key");
  await page.screenshot({ path: join(output, "disconnected.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, liveVapiAccountTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await mcp.close(); await fixture.close();
}
