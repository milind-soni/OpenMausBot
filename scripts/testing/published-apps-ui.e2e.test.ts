// The Published apps page and the preview beside the chat, in the real renderer against a launched server. A bot's
// folder gets two sites from the real publish helper, on a loopback stand-in for Netlify that also serves them. The
// page lists them, the preview frames one beside the chat (from its card and from a link in the bot's message), the
// framed site reports what it could reach of the app (nothing), and Delete removes the site on the stand-in and its
// record. Needs the pinned agent-browser binary: runs when one resolves (tools directory, OMB_AGENT_BROWSER_PATH or
// PATH) or OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { NETLIFY_TOKEN_LABEL, SITE_FILE } from "../../server/host/netlify-sites.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { startFakeNetlify } from "../../server/testing/fake-netlify.ts";
// @ts-expect-error the skill's helper is plain JavaScript with no types
import { publish } from "../../skills/publish-to-netlify/deploy.mjs";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping published apps ui e2e: no agent-browser binary resolves; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;
const TOKEN = "nfp_published_apps_ui_token_0123456789abcdef";

const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
afterAll(async () => { if (!process.env.OMB_UI_EVIDENCE_DIR) await removeTempDir(evidenceDir); });

/** What a hostile site would try first, written into the page so the frame's own text says how each attempt went. */
const SITE = (name: string, color: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:${color};color:#1c1917}
header{padding:28px 32px;font-size:30px;font-weight:700}main{padding:0 32px}li{margin:4px 0}
</style></head><body><header>${name}</header><main><p>Order before noon for same-day pickup.</p><ul id="probe"></ul></main><script>
const tries = {
  bridge: () => typeof window.ogb,
  parentBridge: () => typeof parent.ogb,
  mausbot: () => typeof window.mausbot,
  parentDocument: () => parent.document.title,
  parentStorage: () => parent.localStorage.length,
  topAddress: () => top.location.href,
  navigateTop: () => { top.location = "https://example.com/"; return "navigated"; },
  ownStorage: () => { localStorage.setItem("probe", "1"); return localStorage.getItem("probe") === "1" ? "works" : "broken"; },
  referrer: () => document.referrer || "none",
};
for (const [name, attempt] of Object.entries(tries)) {
  let outcome;
  try { outcome = String(attempt()); } catch (error) { outcome = "blocked"; }
  const line = document.createElement("li");
  line.textContent = "probe " + name + ": " + outcome;
  document.getElementById("probe").append(line);
}
</script></body></html>`;

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

(enabled ? it : it.skip)("lists what a bot published, previews it beside the chat in a sandbox that reaches nothing, and deletes it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-published-apps-"));
  const replyFile = join(scratch, "reply.txt"), tokenFile = join(scratch, "netlify-token");
  writeFileSync(tokenFile, TOKEN);
  const fake = await startFakeNetlify(TOKEN);
  const { child, info } = await launch({ ...process.env, OMB_NETLIFY_API_URL: fake.url, FAKE_CLAUDE_REPLY_FILE: replyFile });
  try {
    const api = fixtureApi(info.url, { headers: { origin: info.url } });
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const viewport = (width: number, height: number) => agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), String(height)]);
    /** The accessibility tree reaches into the frames: what a framed site shows is readable here. */
    const shows = async (text: string) => JSON.stringify(await ui("snapshot")).includes(JSON.stringify(text).slice(1, -1));
    const shot = async (name: string) => { await new Promise((done) => setTimeout(done, 500)); await ui("screenshot", "--out", join(evidenceDir, `${name}.png`)); };
    const press = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    const openPage = async () => {
      if (!await press('[data-sidebar-nav="published-apps"]')) throw new Error("the Tools section has no Published apps entry");
      await until(() => evaluate(`Boolean(document.querySelector('[data-published-apps]:not([data-published-apps="loading"])'))`), "the Published apps page to load");
    };
    const cards = () => evaluate(`[...document.querySelectorAll('[data-published-app]')].map((card) => card.querySelector('h2').textContent)`) as Promise<string[]>;
    mkdirSync(evidenceDir, { recursive: true });
    await viewport(1280, 860);
    // Advanced mode keeps the Tools section in the sidebar; Simple mode has the same entry in the account menu.
    await evaluate(`localStorage.setItem("omb-advanced-mode", "1"); window.dispatchEvent(new StorageEvent("storage", { key: "omb-advanced-mode" })); true`);

    // Nothing published yet: the page says what it is and how to get the first app.
    await until(() => evaluate(`Boolean(document.querySelector('[data-sidebar-nav="published-apps"]'))`), "the Tools section's Published apps entry");
    await shot("tools-menu-desktop");
    await openPage();
    expect(await cards()).toEqual([]);
    expect(await evaluate(`document.querySelector('main[aria-label="Published apps"]').textContent`)).toContain("Ask a bot to build a site or app and publish it.");
    await shot("empty-desktop");

    // The bot publishes two sites from its own folder with the real helper; the second one asks for a Netlify login.
    const workspace = join(info.dataDir, "workspaces", info.botId);
    const deploy = async (folder: string, title: string, color: string, extra: string[] = []) => {
      const project = join(workspace, folder);
      mkdirSync(join(project, "dist"), { recursive: true });
      writeFileSync(join(project, "dist", "index.html"), SITE(title, color));
      const env = { OMB_NETLIFY_API_URL: fake.url, OMB_BOT_ID: info.botId };
      const result = await publish(["--dir", join(project, "dist"), "--project", project, "--token-file", tokenFile, "--title", title, "--bot-name", "Pepper", ...extra], env, { pollMs: 50, privateAfterMs: 200 });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "ready" });
      return { project, env, siteId: result.siteId as string, url: result.url as string };
    };
    const bakery = await deploy("bakery", "Bakery order page", "#fde68a");
    const rota = await deploy("rota", "Staff rota", "#bfdbfe");
    fake.sites.get(rota.siteId)!.teamLogin = true;
    expect(await publish(["--check", "--project", rota.project, "--token-file", tokenFile], rota.env, { pollMs: 50, privateAfterMs: 200, linkWaitMs: 2_000 })).toMatchObject({ access: "private" });
    expect(JSON.parse(readFileSync(join(rota.project, SITE_FILE), "utf8"))).toMatchObject({ access: "private", botId: info.botId });

    const listed = await until(async () => { const { apps } = await api("GET", "/api/published-apps"); return apps.length === 2 ? apps as Array<Record<string, any>> : null; }, "both sites to be listed");
    expect(listed.map((app) => [app.title, app.source, app.bot.name, app.access, app.url, app.canDelete]).sort()).toEqual([
      ["Bakery order page", "netlify", "Pepper", "public", bakery.url, true],
      ["Staff rota", "netlify", "Pepper", "netlify-team", rota.url, true],
    ]);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);

    // The page: one card each, the public one drawn live and small, the login-only one as a plain tile.
    await press('button[aria-label="Back"]');
    await openPage();
    expect((await cards()).sort()).toEqual(["Bakery order page", "Staff rota"]);
    const card = (id: string) => `[data-published-app="netlify-${info.botId}-${id}"]`;
    await until(() => evaluate(`document.querySelector('${card(bakery.siteId)} [data-app-thumb]').getAttribute("data-app-thumb") === "live"`), "the bakery card's live picture");
    expect(await evaluate(`document.querySelector('${card(rota.siteId)} [data-app-thumb]').getAttribute("data-app-thumb")`)).toBe("tile");
    expect(await evaluate(`[...document.querySelectorAll('${card(bakery.siteId)} iframe')].map((frame) => [frame.getAttribute("sandbox"), frame.getAttribute("tabindex"), getComputedStyle(frame).pointerEvents])`))
      .toEqual([["allow-scripts allow-same-origin", "-1", "none"]]);
    expect(await evaluate(`[document.querySelector('${card(bakery.siteId)} [data-app-access]').textContent, document.querySelector('${card(rota.siteId)} [data-app-access]').textContent]`))
      .toEqual(["Public", "Only your Netlify team"]);
    await shot("page-desktop");

    // The same page chrome as Automations and its calendar: the sidebar stays, and the header is the one they share.
    const chrome = () => evaluate(`(() => { const header = document.querySelector("main > header"), title = header.querySelector("h1"), back = header.querySelector("button"), style = getComputedStyle(title);
      const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.height)]; };
      return { header: box(header), back: box(back), title: box(title).slice(0, 2), font: [style.fontSize, style.fontWeight], sidebar: Boolean(document.querySelector('[data-sidebar-nav="automations"]')),
        main: getComputedStyle(header.parentElement).backgroundColor }; })()`);
    const appsChrome = await chrome();
    await press('[data-sidebar-nav="automations"]');
    await until(() => evaluate(`document.querySelector("main > header h1")?.textContent === "Automations"`), "the Automations page");
    await shot("automations-desktop");
    expect(appsChrome).toEqual(await chrome());
    expect(appsChrome.sidebar).toBe(true);
    await openPage();

    // Preview: the bot's chat on the left, the site on the right, in the sandbox.
    await press(`${card(bakery.siteId)} button[aria-label="Preview Bakery order page"]`);
    await until(() => evaluate(`Boolean(document.querySelector('aside[data-app-preview] iframe[data-app-preview-frame]') && document.querySelector('textarea[aria-label="Message Pepper"]'))`), "the preview beside Pepper's chat");
    expect(await evaluate(`(() => { const frame = document.querySelector('aside[data-app-preview] iframe'); return [frame.getAttribute("src"), frame.getAttribute("sandbox"), frame.getAttribute("referrerpolicy")]; })()`))
      .toEqual([bakery.url, "allow-scripts allow-same-origin allow-forms allow-popups", "no-referrer"]);
    await until(() => shows("probe referrer: none"), "the framed site to report its probes");
    const probes = [...new Set(JSON.stringify(await ui("snapshot")).match(/probe \w+: [\w ]+/g))].sort();
    expect(probes).toEqual(["probe bridge: undefined", "probe mausbot: undefined", "probe navigateTop: blocked", "probe ownStorage: works", "probe parentBridge: blocked", "probe parentDocument: blocked",
      "probe parentStorage: blocked", "probe referrer: none", "probe topAddress: blocked"]);
    expect(await evaluate("location.href")).toContain("127.0.0.1");
    await shot("preview-desktop");

    // Reload gives a new frame of the same site; Close gives the side back.
    await evaluate(`window.__firstFrame = document.querySelector('aside[data-app-preview] iframe'); true`);
    await press('aside[data-app-preview] button[aria-label="Reload"]');
    await until(() => evaluate(`document.querySelector('aside[data-app-preview] iframe') !== window.__firstFrame`), "a reloaded frame");
    await press('aside[data-app-preview] button[aria-label="Close preview"]');
    await until(() => evaluate(`!document.querySelector('aside[data-app-preview]')`), "the preview to close");

    // A published link in the bot's message opens the same preview.
    writeFileSync(replyFile, `Published your bakery page: ${bakery.url} The link is public.`);
    await ui("type", "--name", "Message Pepper", "--text", "publish the bakery page");
    await ui("press", "--keys", "Enter");
    const link = `a[href="${bakery.url}"]`;
    await until(() => evaluate(`Boolean(document.querySelector('${link}'))`), "the bot's message with the link", 60_000);
    await ui("wait-settle", "--timeout", "60");
    await press(link);
    await until(() => evaluate(`document.querySelector('aside[data-app-preview] iframe')?.getAttribute("src") === ${JSON.stringify(bakery.url)}`), "the link to open the preview");
    expect(await evaluate(`document.querySelector('aside[data-app-preview] h2').textContent`)).toBe("Bakery order page");
    await shot("preview-from-link-desktop");
    await press('aside[data-app-preview] button[aria-label="Close preview"]');

    // With OMB_PUBLISHED_APPS_REAL_SITES (addresses separated by spaces) the same link click frames real public sites,
    // read-only: nothing is deployed and Netlify's API is never called.
    for (const [index, site] of (process.env.OMB_PUBLISHED_APPS_REAL_SITES ?? "").split(/\s+/).filter(Boolean).entries()) {
      writeFileSync(replyFile, `Here it is: ${site}`);
      await ui("type", "--name", "Message Pepper", "--text", `show me site ${index + 1}`);
      await ui("press", "--keys", "Enter");
      await until(() => evaluate(`Boolean(document.querySelector('a[href="${site}"]'))`), `the message linking ${site}`, 60_000);
      await ui("wait-settle", "--timeout", "60");
      await press(`a[href="${site}"]`);
      await until(() => evaluate(`document.querySelector('aside[data-app-preview] iframe')?.getAttribute("src") === ${JSON.stringify(site)}`), `${site} in the preview`);
      await new Promise((done) => setTimeout(done, 5_000));
      await shot(`real-site-${index + 1}-desktop`);
      await press('aside[data-app-preview] button[aria-label="Close preview"]');
    }

    // A site that asks for a login is not framed: a plain line and Open in browser.
    await openPage();
    await press(`${card(rota.siteId)} button[aria-label="Preview Staff rota"]`);
    await until(() => evaluate(`Boolean(document.querySelector('aside[data-app-preview] [data-app-preview-fallback]'))`), "the fallback for a login-only site");
    expect(await evaluate(`[Boolean(document.querySelector('aside[data-app-preview] iframe')), document.querySelector('aside[data-app-preview] [data-app-preview-fallback]').textContent]`))
      .toEqual([false, expect.stringContaining("This site asks for a Netlify login.")]);
    await shot("preview-fallback-desktop");
    await press('aside[data-app-preview] button[aria-label="Close preview"]');

    // Phone width: the page, and the preview over the chat.
    await viewport(390, 844);
    // The fixture's own offer card sits over the corner at this width.
    await evaluate(`[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Not now")?.click(); true`);
    await evaluate(`(document.querySelector('[data-sidebar-nav="published-apps"]') ?? document.querySelector('button[aria-label="Tools"], [data-sidebar-phone-bar] button'))?.click(); true`);
    if (!await evaluate(`Boolean(document.querySelector('[data-published-apps]'))`)) {
      await shot("tools-menu-phone");
      await evaluate(`[...document.querySelectorAll('[role="menuitem"], button')].find((item) => item.textContent.trim() === "Published apps")?.click(); true`);
    }
    await until(() => evaluate(`Boolean(document.querySelector('[data-published-apps]:not([data-published-apps="loading"])'))`), "the page at phone width");
    await shot("page-phone");
    const phoneChrome = await chrome();
    await evaluate(`document.querySelector('[data-sidebar-phone-bar] button')?.click(); true`);
    await evaluate(`[...document.querySelectorAll('[role="menuitem"], button')].find((item) => item.textContent.trim() === "Automations")?.click(); true`);
    await until(() => evaluate(`document.querySelector("main > header h1")?.textContent === "Automations"`), "the Automations page at phone width");
    await shot("automations-phone");
    // Automations' own controls wrap under its title at this width, so only its header is taller.
    expect({ ...phoneChrome, sidebar: null, header: null }).toEqual({ ...await chrome(), sidebar: null, header: null });
    await evaluate(`document.querySelector('[data-sidebar-phone-bar] button')?.click(); true`);
    await evaluate(`[...document.querySelectorAll('[role="menuitem"], button')].find((item) => item.textContent.trim() === "Published apps")?.click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-published-apps]:not([data-published-apps="loading"])'))`), "the page at phone width again");
    await press(`${card(bakery.siteId)} button[aria-label="Preview Bakery order page"]`);
    await until(() => evaluate(`Boolean(document.querySelector('aside[data-app-preview] iframe'))`), "the preview at phone width");
    await until(() => evaluate(`(() => { const box = document.querySelector('aside[data-app-preview]').getBoundingClientRect(); return Math.round(box.left) === 0 && Math.round(box.width) === 390; })()`), "the preview to cover the phone's screen");
    await shot("preview-phone");
    await press('aside[data-app-preview] button[aria-label="Close preview"]');
    await viewport(1280, 860);

    // Delete: refused with a plain line while no token is saved, then done with the Vault's token.
    await openPage();
    const confirmDelete = async (id: string, title: string) => {
      await press(`${card(id)} button[aria-label="Delete ${title}"]`);
      await until(() => evaluate(`Boolean(document.querySelector('[role="alertdialog"]'))`), "the delete confirmation");
    };
    await confirmDelete(rota.siteId, "Staff rota");
    expect(await evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).toContain("Delete “Staff rota”?Its link will stop working for everyone. This can't be undone.");
    await shot("delete-confirm-desktop");
    await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Delete").click(); true`);
    await until(() => evaluate(`document.querySelector('${card(rota.siteId)} [role="alert"]')?.textContent`), "why it could not be deleted");
    expect(await evaluate(`document.querySelector('${card(rota.siteId)} [role="alert"]').textContent`)).toContain("there is no saved Netlify token to use. Delete it on Netlify instead. Manage on Netlify");
    expect(fake.sites.has(rota.siteId)).toBe(true);
    expect(fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
    await shot("delete-no-token-desktop");

    await api("POST", "/api/vault/secrets", { name: NETLIFY_TOKEN_LABEL, value: TOKEN, bots: "all" });
    await confirmDelete(rota.siteId, "Staff rota");
    await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Delete").click(); true`);
    await until(async () => (await cards()).length === 1, "the deleted card to go");
    expect(await cards()).toEqual(["Bakery order page"]);
    expect(fake.sites.has(rota.siteId)).toBe(false);
    expect(fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /api/v1/sites/${rota.siteId}`]);
    expect(fake.refused).toEqual([]);
    expect(existsSync(join(rota.project, SITE_FILE))).toBe(false);
    expect(existsSync(join(bakery.project, SITE_FILE))).toBe(true);
    expect(((await api("GET", "/api/published-apps")).apps as unknown[]).length).toBe(1);

    // The token went to the stand-in and nowhere else: not into an answer, the page or the server's log.
    const answer = await fetch(`${info.url}/api/published-apps/delete`, { method: "POST", headers: { "content-type": "application/json", origin: info.url }, body: JSON.stringify({ id: `netlify-${info.botId}-${rota.siteId}` }) });
    expect({ status: answer.status, body: await answer.json() }).toEqual({ status: 404, body: { error: "No such published app.", code: "gone" } });
    expect(await evaluate("document.documentElement.outerHTML.includes(" + JSON.stringify(TOKEN) + ")")).toBe(false);
    expect(readFileSync(info.logPath, "utf8")).not.toContain(TOKEN);
    const logs = await ui("console");
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error" && !message.text.includes("401"))).toEqual([]);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await fake.stop();
    expect(existsSync(info.dataDir)).toBe(false);
    await removeTempDir(scratch);
  }
}, LAUNCH_TIMEOUT_MS + 300_000);
