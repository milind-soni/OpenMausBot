// Real ComputerPanel in an isolated fake-engine workspace; only the desktop
// transport is simulated. No host Docker or user profile is accessed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview } from "./testing/preview-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-omb-ui.ts";

const fixture = await launchVerificationServer();
const home = mkdtempSync(join(tmpdir(), "omb-resume-browser-"));
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let browser: { binary: string; env: NodeJS.ProcessEnv } | undefined;
try {
  console.log(JSON.stringify(fixture.info));
  await runControlOmb(["new-bot", "--name", "Resume test", "--url", fixture.info.url]);
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/cloud-preview.tsx", route: "/__vm-resume.html", title: "Local VM resume verification", logLevel: "silent",
  });
  const { binary, chrome } = await ensureUiBrowser(process.env);
  const env = sessionEnv({ home, session: `vm-resume-${process.pid}`, chrome });
  browser = { binary, env };
  const command = (...args: string[]) => agentBrowser(binary, env, args);
  const evaluate = async <T = unknown>(js: string) => (await command("eval", js)).result as T;
  const wait = (condition: string) => { console.log("Waiting:", condition); return command("wait", "--fn", condition); };
  await command("open", preview.previewUrl);
  await wait(`document.querySelector('select[aria-label="Conversation surface"]') !== null`);
  await wait(`Array.from(document.querySelectorAll('img')).some(img => img.src === window.cloudPreviewFixture.screenshot && img.complete)`);
  await evaluate(`(() => { const s = document.querySelector('select[aria-label="Conversation surface"]'); s.value='vm-stopped'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await wait(`document.body.textContent.includes('The Local VM is stopped')`);
  assert.equal(await evaluate(`document.body.textContent.includes('Stopped after inactivity')`), true);
  assert.equal(await evaluate(`document.body.textContent.includes("isn't available for this bot")`), false);
  await command("screenshot", join(dirname(fixture.info.logPath), `vm-stopped-${process.pid}.png`));
  await command("find", "role", "button", "click", "--name", "Start Local VM", "--exact");
  await wait(`window.cloudPreviewFixture.vmStarts === 1`);
  await wait(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Starting Local VM') && b.disabled && b.getAttribute('aria-busy') === 'true')`);
  // The POST has returned but Cua is still warming up: the button must keep
  // spinning rather than become clickable or claim the desktop is ready.
  await evaluate(`new Promise(resolve => setTimeout(resolve, 1500))`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Starting Local VM') && b.disabled)`), true);
  await command("screenshot", join(dirname(fixture.info.logPath), `vm-starting-${process.pid}.png`));
  await command("find", "role", "button", "click", "--name", "Finish VM startup", "--exact");
  await wait(`Array.from(document.querySelectorAll('img')).some(img => img.src === window.cloudPreviewFixture.vmScreenshot && img.complete && img.naturalWidth > 1)`);
  assert.equal(await evaluate(`window.cloudPreviewFixture.vmStarts`), 1);
  assert.equal(await evaluate(`window.cloudPreviewFixture.paths.some(p => p.endsWith('/local-computer/remove') || p.endsWith('/local-computer/run'))`), false);
  await evaluate(`window.cloudPreviewFixture.resetVm(); const s = document.querySelector('select[aria-label="Panel"]'); s.value='settings'; s.dispatchEvent(new Event('change', {bubbles:true}));`);
  await wait(`document.body.textContent.includes('Stopped after inactivity')`);
  assert.equal(await evaluate(`document.body.textContent.includes('Delete and recreate')`), false);
  await command("find", "role", "button", "click", "--name", "Start Local VM", "--exact");
  await wait(`document.body.textContent.includes('Waiting for the desktop')`);
  await command("find", "role", "button", "click", "--name", "Finish VM startup", "--exact");
  await wait(`Array.from(document.querySelectorAll('[aria-live]')).some(el => el.textContent.trim() === 'Ready')`);
  console.log("PASS: stopped explanation → one start → pending through warmup → live preview; Settings also resumes without replacement");
} catch (error) {
  if (browser) console.error(JSON.stringify(await agentBrowser(browser.binary, browser.env, ["snapshot"]).catch(() => ({}))));
  throw error;
} finally {
  if (browser) await agentBrowser(browser.binary, browser.env, ["close"]).catch(() => {});
  await preview?.close();
  await fixture.close();
  rmSync(home, { recursive: true, force: true });
}
