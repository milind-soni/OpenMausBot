// Apps on the hosting the Cloud plan includes, on the Published apps page of the real renderer against a launched
// server. A loopback stand-in is the Admin's relay and serves what is published; a second one is Netlify, for a site on
// the person's own account beside them. The bot publishes folders of its own through its tool's route; the page shows
// the plan's count, each card's source, the preview beside the chat, an app MausBot took down, and Delete through the
// relay. Nothing here reaches the real Admin or Netlify. Needs the pinned agent-browser binary: runs when one resolves
// (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { SITE_FILE } from "../../server/host/netlify-sites.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { startFakeAppHosting } from "../../server/testing/fake-app-hosting.ts";
import { startFakeNetlify } from "../../server/testing/fake-netlify.ts";
// @ts-expect-error the skill's helper is plain JavaScript with no types
import { publish } from "../../skills/publish-to-netlify/deploy.mjs";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping included hosting ui e2e: no agent-browser binary resolves; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;
const HOSTING_TOKEN = "omb_host_included_hosting_ui_token_0123456789abcdef";
const NETLIFY_TOKEN = "nfp_included_hosting_ui_token_0123456789abcdef";
const CAPABILITY_KEY = "included-hosting-ui-capability-key";

const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
afterAll(async () => { if (!process.env.OMB_UI_EVIDENCE_DIR) await removeTempDir(evidenceDir); });

const SITE = (name: string, color: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:${color};color:#1c1917}
header{padding:28px 32px;font-size:30px;font-weight:700}main{padding:0 32px}
</style></head><body><header>${name}</header><main><p>Order before noon for same-day pickup.</p></main></body></html>`;

async function launch(env: NodeJS.ProcessEnv): Promise<{ child: ReturnType<typeof spawn>; info: { ui: string; url: string; botId: string; dataDir: string; logPath: string } }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "control-omb.ts"), "ui", "launch"], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`ui launch exited ${child.exitCode}: ${stderr}`);
    const start = stdout.indexOf("{");
    if (start !== -1) {
      try { return { child, info: JSON.parse(stdout.slice(start)) }; } catch { /* not all of it yet */ }
    }
    if (Date.now() > deadline) throw new Error(`ui launch printed no handle: ${stderr}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function until<T>(probe: () => Promise<T> | T, what: string, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

(enabled ? it : it.skip)("shows the plan's included apps with their count and source, previews one, marks a taken-down one and deletes through the relay", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-included-hosting-"));
  const tokenFile = join(scratch, "netlify-token");
  writeFileSync(tokenFile, NETLIFY_TOKEN);
  const hosting = await startFakeAppHosting(HOSTING_TOKEN, { apps: 3 }), netlify = await startFakeNetlify(NETLIFY_TOKEN);
  const { child, info } = await launch({ ...process.env, OMB_CLOUD_HOSTING_URL: hosting.url, OMB_CLOUD_HOSTING_TOKEN: HOSTING_TOKEN, OMB_NETLIFY_API_URL: netlify.url,
    OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY });
  try {
    const api = fixtureApi(info.url, { headers: { origin: info.url } });
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const viewport = (width: number, height: number) => agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), String(height)]);
    const shows = async (text: string) => JSON.stringify(await ui("snapshot")).includes(JSON.stringify(text).slice(1, -1));
    const shot = async (name: string) => { await new Promise((done) => setTimeout(done, 500)); await ui("screenshot", "--out", join(evidenceDir, `${name}.png`)); };
    const press = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    const openPage = async () => {
      if (!await press('[data-sidebar-nav="published-apps"]')) throw new Error("the Tools section has no Published apps entry");
      await until(() => evaluate(`Boolean(document.querySelector('[data-published-apps]:not([data-published-apps="loading"])'))`), "the Published apps page to load");
    };
    const reopen = async () => { await press('button[aria-label="Back"]'); await openPage(); };
    const cards = () => evaluate(`[...document.querySelectorAll('[data-published-app]')].map((card) => card.querySelector('h2').textContent)`) as Promise<string[]>;
    const count = () => evaluate(`document.querySelector('[data-included-apps]')?.textContent ?? null`) as Promise<string | null>;
    const buttons = (card: string) => evaluate(`[...document.querySelectorAll('${card} button')].map((one) => one.getAttribute("aria-label") ?? one.textContent.trim())`) as Promise<string[]>;
    mkdirSync(evidenceDir, { recursive: true });
    await viewport(1280, 860);
    await evaluate(`localStorage.setItem("omb-advanced-mode", "1"); window.dispatchEvent(new StorageEvent("storage", { key: "omb-advanced-mode" })); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-sidebar-nav="published-apps"]'))`), "the Tools section's Published apps entry");

    // Nothing published yet: the page already says what the plan includes.
    await openPage();
    expect(await cards()).toEqual([]);
    expect(await count()).toBe("0 of 3 apps included in your plan");
    await shot("empty-desktop");

    // The bot publishes two folders of its own through its tool's route: the server reads them and asks the relay.
    const bot = ((await api("GET", "/api/bots")).bots as Array<{ id: string; threadId: string }>).find((one) => one.id === info.botId)!;
    const { token: capability } = await fetch(`${info.url}/api/testing/internal-capability`, { method: "POST",
      headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY }, body: JSON.stringify({ botId: bot.id, threadId: bot.threadId }) }).then((answer) => answer.json()) as { token: string };
    const workspace = join(info.dataDir, "workspaces", info.botId);
    const tool = async (input: Record<string, unknown>) => {
      const answer = await fetch(`${info.url}/api/internal/apps/publish`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability}` }, body: JSON.stringify(input) });
      return { status: answer.status, body: await answer.json() as Record<string, any> };
    };
    const build = (folder: string, title: string, color: string) => {
      mkdirSync(join(workspace, folder, "dist"), { recursive: true });
      writeFileSync(join(workspace, folder, "dist", "index.html"), SITE(title, color));
    };
    build("bakery", "Bakery order page", "#fde68a");
    build("flash-sale", "Flash sale", "#fecaca");
    build("rota", "Staff rota", "#bfdbfe");
    expect((await tool({ action: "status" })).body).toMatchObject({ ok: true, apps: "0 of 3" });
    const bakery = await tool({ path: "bakery/dist", project: "bakery", title: "Bakery order page" });
    expect(bakery, JSON.stringify(bakery)).toMatchObject({ status: 200, body: { ok: true, live: true, apps: "1 of 3" } });
    const sale = await tool({ path: "flash-sale/dist", project: "flash-sale", title: "Flash sale" });
    expect(sale.body).toMatchObject({ ok: true, live: true, apps: "2 of 3" });
    const bakeryKey = JSON.parse(readFileSync(join(workspace, "bakery", SITE_FILE), "utf8")).appKey as string;
    const saleKey = JSON.parse(readFileSync(join(workspace, "flash-sale", SITE_FILE), "utf8")).appKey as string;

    // One more site on the person's own Netlify account, published with the skill's helper.
    const rota = await publish(["--dir", join(workspace, "rota", "dist"), "--project", join(workspace, "rota"), "--token-file", tokenFile, "--title", "Staff rota", "--bot-name", "Pepper"],
      { OMB_NETLIFY_API_URL: netlify.url, OMB_BOT_ID: info.botId }, { pollMs: 50, privateAfterMs: 200 });
    expect(rota, JSON.stringify(rota)).toMatchObject({ ok: true, state: "ready" });

    const listed = await until(async () => { const list = await api("GET", "/api/published-apps"); return list.apps.length === 3 ? list : null; }, "the three apps to be listed");
    expect(listed.included).toEqual({ used: 2, max: 3 });
    expect((listed.apps as Array<Record<string, any>>).map((app) => [app.title, app.source, app.bot.name, app.access, app.canDelete]).sort()).toEqual([
      ["Bakery order page", "included", "Pepper", "public", true], ["Flash sale", "included", "Pepper", "public", true], ["Staff rota", "netlify", "Pepper", "public", true],
    ]);

    // The page: the count in one quiet line, and each card saying where it is hosted.
    await reopen();
    expect((await cards()).sort()).toEqual(["Bakery order page", "Flash sale", "Staff rota"]);
    expect(await count()).toBe("2 of 3 apps included in your plan");
    const card = (key: string) => `[data-published-app="included-${key}"]`;
    const ownCard = `[data-published-app="netlify-${info.botId}-${rota.siteId}"]`;
    expect(await evaluate(`[${JSON.stringify(card(bakeryKey))}, ${JSON.stringify(card(saleKey))}, ${JSON.stringify(ownCard)}].map((one) => document.querySelector(one + ' [data-app-source]').textContent)`))
      .toEqual(["Included hosting", "Included hosting", "Your Netlify"]);
    expect(await buttons(card(bakeryKey))).toEqual(["Preview Bakery order page", "Preview", "Open", "Copy link", "Ask Pepper to change it", "Delete Bakery order page"]);
    expect(await buttons(ownCard)).toContain("Manage on Netlify");
    await until(() => evaluate(`document.querySelector('${card(bakeryKey)} [data-app-thumb]').getAttribute("data-app-thumb") === "live"`), "the bakery card's live picture");
    await shot("page-desktop");

    // Preview: the bot's chat on the left, the included app on the right, in the same sandbox as any published site.
    await press(`${card(bakeryKey)} button[aria-label="Preview Bakery order page"]`);
    await until(() => evaluate(`Boolean(document.querySelector('aside[data-app-preview] iframe[data-app-preview-frame]') && document.querySelector('textarea[aria-label="Message Pepper"]'))`), "the preview beside Pepper's chat");
    expect(await evaluate(`(() => { const frame = document.querySelector('aside[data-app-preview] iframe'); return [frame.getAttribute("src"), frame.getAttribute("sandbox")]; })()`))
      .toEqual([bakery.body.url, "allow-scripts allow-same-origin allow-forms allow-popups"]);
    await until(() => shows("Order before noon for same-day pickup."), "the framed app's own text");
    await shot("preview-desktop");
    await press('aside[data-app-preview] button[aria-label="Close preview"]');

    // MausBot takes one down: it stays on the page, marked, with nothing to open, and still counts until it is deleted.
    hosting.takeDown(saleKey);
    await new Promise((done) => setTimeout(done, 2_100));
    await openPage();
    await until(() => evaluate(`document.querySelector('${card(saleKey)} [data-app-status]')?.textContent === "Taken down"`), "the taken-down mark");
    expect(await buttons(card(saleKey))).toEqual(["Ask Pepper to change it", "Delete Flash sale"]);
    expect(await evaluate(`Boolean(document.querySelector('${card(saleKey)} iframe'))`)).toBe(false);
    expect(await count()).toBe("2 of 3 apps included in your plan");
    await shot("taken-down-desktop");

    // Phone width.
    await viewport(390, 844);
    await evaluate(`[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Not now")?.click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-published-apps]:not([data-published-apps="loading"])'))`), "the page at phone width");
    expect(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
    await shot("page-phone");
    await viewport(1280, 860);

    // Delete: the relay deletes the app, its record goes, its place in the plan is free; the bot's files stay.
    await press(`${card(saleKey)} button[aria-label="Delete Flash sale"]`);
    await until(() => evaluate(`Boolean(document.querySelector('[role="alertdialog"]'))`), "the delete confirmation");
    expect(await evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).toContain("Delete “Flash sale”?Its link will stop working for everyone. This can't be undone.");
    await shot("delete-confirm-desktop");
    await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Delete").click(); true`);
    await until(async () => (await cards()).length === 2, "the deleted card to go");
    await until(async () => await count() === "1 of 3 apps included in your plan", "the count to drop");
    expect(hosting.requests).toContain(`DELETE /apps/${saleKey}`);
    expect([...hosting.apps.keys()]).toEqual([bakeryKey]);
    expect(existsSync(join(workspace, "flash-sale", SITE_FILE))).toBe(false);
    expect(existsSync(join(workspace, "flash-sale", "dist", "index.html"))).toBe(true);
    expect(netlify.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
    await shot("after-delete-desktop");

    // The relay's token went to the stand-in and nowhere else: not into an answer, the page, a record or the server's log.
    expect(hosting.refused).toEqual([]);
    expect(netlify.refused).toEqual([]);
    expect(JSON.stringify([bakery, sale, await api("GET", "/api/published-apps"), await api("GET", "/api/config")])).not.toContain(HOSTING_TOKEN);
    expect(readFileSync(join(workspace, "bakery", SITE_FILE), "utf8")).not.toContain(HOSTING_TOKEN);
    expect(await evaluate("document.documentElement.outerHTML.includes(" + JSON.stringify(HOSTING_TOKEN) + ")")).toBe(false);
    expect(readFileSync(info.logPath, "utf8")).not.toContain(HOSTING_TOKEN);
    const logs = await ui("console");
    expect(JSON.stringify(logs)).not.toContain(HOSTING_TOKEN);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await hosting.stop();
    await netlify.stop();
    expect(existsSync(info.dataDir)).toBe(false);
    await removeTempDir(scratch);
  }
}, LAUNCH_TIMEOUT_MS + 300_000);
