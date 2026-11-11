import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
import { launchChrome } from "../server/browser/chrome/launch.ts";
import { CdpBrowser } from "../server/browser/cdp/browser.ts";

const fixture = await launchVerificationServer();
const out = resolve(process.env.OMB_UI_EVIDENCE_DIR ?? ".omb-scratch/features");
mkdirSync(out, { recursive: true });
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let browser: CdpBrowser | undefined;
let failSave = false;
let member = false;
let libraryReads = 0;
try {
  const api = fixtureApi(fixture.info.url);
  const botId = (await api("GET", "/api/bots?messages=0")).bots[0].id as string;
  await api("PATCH", "/api/config", { language: "en", features: { skillsLibrary: false } });
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/features-preview.tsx", route: "/__features.html", title: "Isolated feature settings", logLevel: "warn",
    extraRoutes: [
      { path: "/api/config", method: "PATCH", handler: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (failSave) { failSave = false; res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "Fixture save failed" })); return; }
        const response = await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: Buffer.concat(chunks) });
        res.statusCode = response.status; res.setHeader("content-type", "application/json"); res.end(await response.text());
      } },
      { path: "/api/skills-library", method: "GET", handler: async (_req, res) => {
        libraryReads++;
        const response = await fetch(`${fixture.info.url}/api/skills-library`);
        res.statusCode = response.status; res.setHeader("content-type", "application/json"); res.end(await response.text());
      } },
      { path: "/api/auth/session", method: "GET", handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(member ? { kind: "session", id: "fixture-member", label: "Member", scopes: ["read"], expiresAt: Date.now() + 60_000 } : { kind: "loopback" }));
      } },
    ],
  });
  chrome = await launchChrome({ executablePath: process.env.OMB_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", userDataDir: join(fixture.info.dataDir, "feature-browser"), mode: "headless", host: "desktop", sandbox: true });
  browser = await CdpBrowser.connect(chrome.transport, { viewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const evaluate = (expression: string) => page.evaluate(expression, { world: "page", awaitPromise: true });
  const wait = async (expression: string) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise((done) => setTimeout(done, 100)); }
    throw new Error(`Timed out: ${expression}`);
  };
  const click = async (selector: string) => { assert.equal(await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`), true, selector); };
  const screenshot = async (name: string) => writeFileSync(join(out, `${name}.png`), (await page.screenshot()).data);
  const search = async (term: string, key: string, anchor: string) => {
    await evaluate(`(() => { const field = [...document.querySelectorAll('[data-settings-search]')].find(el => el.checkVisibility()); field.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(term)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(`Boolean([...document.querySelectorAll('[data-settings-feature-result="${key}"]')].find(el => el.checkVisibility()))`);
    await evaluate(`[...document.querySelectorAll('[data-settings-feature-result="${key}"]')].find(el => el.checkVisibility()).click()`);
    await wait(`document.activeElement?.getAttribute('data-settings-block') === ${JSON.stringify(anchor)}`);
  };
  for (const advanced of [false, true]) {
    await page.navigate(`${preview.previewUrl}${advanced ? "?advanced=1" : ""}`, { readiness: "domcontentloaded", timeoutMs: 120_000 });
    await wait(`Boolean(document.querySelector('[aria-label="Skills library"][role="switch"]:not(:disabled)'))`);
    const readsBefore = libraryReads;
    failSave = true;
    await click('[aria-label="Skills library"][role="switch"]');
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Fixture save failed')`);
    await screenshot(`${advanced ? "advanced" : "simple"}-skills-disabled`);
    assert.equal(libraryReads, readsBefore);
    assert.equal((await api("GET", "/api/config")).features.skillsLibrary, false);
    await click('[aria-label="Skills library"][role="switch"]');
    await wait(`document.querySelector('[aria-label="Skills library"][role="switch"]')?.getAttribute('aria-checked') === 'true'`);
    await wait(`Boolean(document.querySelector('[data-settings-sheet]')?.textContent.includes('Import'))`);
    await screenshot(`${advanced ? "advanced" : "simple"}-skills-enabled`);
    assert.ok(libraryReads > readsBefore);
    if (!advanced) {
      await api("POST", "/api/skills-library", { text: "---\nname: fixture-skill\ndescription: Synthetic feature verification\n---\nUse this fixture skill." });
      await api("PUT", `/api/bots/${botId}/skills-library`, { skills: ["fixture-skill"] });
    }
    await click('[aria-label="Skills library"][role="switch"]');
    await wait(`document.querySelector('[aria-label="Skills library"][role="switch"]')?.getAttribute('aria-checked') === 'false'`);
    const readsDisabled = libraryReads;
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(libraryReads, readsDisabled);
    for (const [term, key, anchor] of [["tool calls", "showToolCalls", "control-showToolCalls"], ["recall", "autoRecall", "feature-autoRecall"], ["guard", "loopGuard", "feature-loopGuard"], ["tool bridge", "agentsToolBridge", "feature-agentsToolBridge"]]) await search(term, key, anchor);
    await screenshot(`${advanced ? "advanced" : "simple"}-desktop`);
    await page.emulateSize({ width: 390, height: 844 });
    assert.equal(await evaluate("innerWidth"), 390);
    await search("skillsLibrary", "skillsLibrary", "feature-skillsLibrary");
    assert.equal(await evaluate("document.scrollingElement.scrollWidth <= innerWidth"), true);
    await screenshot(`${advanced ? "advanced" : "simple"}-mobile`);
    await page.emulateSize(null);
    await browser.setViewport({ width: 1280, height: 900 });
  }
  await api("PATCH", "/api/config", { features: { skillsLibrary: true } });
  const skill = (await api("GET", "/api/skills-library")).skills.find((item: { name: string }) => item.name === "fixture-skill");
  assert.ok(skill);
  assert.ok(skill.assignedBots.some((bot: { id: string }) => bot.id === botId));
  member = true;
  await page.navigate(preview.previewUrl, { readiness: "domcontentloaded", timeoutMs: 120_000 });
  await wait("Boolean(document.querySelector('[data-admin-only]'))");
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Skills library\"][role=\"switch\"]').length"), 0);
  const evidence = { ...fixture.info, checks: ["simple and advanced desktop/mobile", "Skills failed-save and enable/disable request lifecycle", "retained library skill", "direct search anchors for tool calls, recall, guard, tool bridge", "member has no library switch", "no horizontal page overflow at 390px"], libraryReads, out };
  writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await chrome?.close();
  await preview?.close();
  await fixture.close();
}
