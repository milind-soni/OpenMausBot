import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { runControlOmb } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(process.env.OMB_UI_E2E === "1" ? it : it.skip)("Run now shows pending, its exact result, and retryable request errors", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let output = "";
  child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += chunk; });
  let fixture: { ui: string; url: string; botId: string };
  await expect.poll(() => {
    try { fixture = JSON.parse(output); return Boolean(fixture.ui); } catch { return false; }
  }, { timeout: 120_000 }).toBe(true);
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<any>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  const response = await fetch(`${fixture!.url}/api/routines`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Feedback fixture", prompt: "Reply with the fixture response.", botId: fixture!.botId, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } }) });
  expect(response.ok).toBe(true);
  const { routine } = await response.json();
  await click("Tools"); await click("Automations"); await click("List");
  await expect.poll(() => evaluate('!!document.querySelector(\'article[aria-label="Feedback fixture"] button\')')).toBe(true);
  await evaluate('document.querySelector(\'article[aria-label="Feedback fixture"] button\').click()');
  // Delay only this fixture's run POST; two queued clicks must still send once.
  await evaluate(`window.fixtureFetch = window.fetch; window.runPosts = 0; window.fetch = async (...args) => { if (String(args[0]).endsWith('/${routine.id}/run')) { window.runPosts++; await new Promise(resolve => window.releaseRun = resolve); } return window.fixtureFetch(...args); }; const button = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Run now'); button.click(); button.click();`);
  const dialog = () => evaluate('document.querySelector("[role=dialog]")?.innerText ?? ""');
  await expect.poll(dialog).toContain("Starting…");
  await expect.poll(() => evaluate('window.runPosts')).toBe(1);
  await evaluate('window.releaseRun()');
  await expect.poll(dialog, { timeout: 30_000 }).toContain("Completed");
  expect(await dialog()).toContain("Open thread");
  const { runs } = await fetch(`${fixture!.url}/api/routines`).then(r => r.json());
  expect(runs.filter((run: any) => run.routineId === routine.id)).toHaveLength(1);
  expect(await dialog()).toContain("hello from fake claude");
  // A newer run of the same routine must not replace the run we started here.
  const changed = await fetch(`${fixture!.url}/api/routines/${routine.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "A different competing run." }) });
  expect(changed.ok).toBe(true);
  const competing = await fetch(`${fixture!.url}/api/routines/${routine.id}/run`, { method: "POST" });
  expect(competing.ok).toBe(true);
  const { run: competingRun } = await competing.json();
  await expect.poll(async () => {
    const snapshot = await fetch(`${fixture!.url}/api/routines`).then(r => r.json());
    return snapshot.runs.find((run: any) => run.id === competingRun.id)?.status;
  }, { timeout: 30_000 }).toBe("completed");
  expect(await dialog()).toContain("Reply with the fixture response.");
  expect(await dialog()).not.toContain("A different competing run.");
  // An unsuccessful new attempt must show its error, not the previous success.
  await evaluate(`window.fetch = (...args) => String(args[0]).endsWith('/${routine.id}/run') ? Promise.resolve(new Response(JSON.stringify({error:'Fixture run rejected'}), {status:409, headers:{'Content-Type':'application/json'}})) : window.fixtureFetch(...args)`);
  await click("Run now");
  await expect.poll(dialog).toContain("Fixture run rejected");
  expect(await dialog()).not.toContain("Completed");
  await evaluate('window.fetch = window.fixtureFetch');
  await click("Run now");
  await expect.poll(dialog, { timeout: 30_000 }).toContain("Completed");
  expect(await dialog()).toContain("A different competing run.");
  if (process.env.OMB_RUN_FEEDBACK_SCREENSHOT) await ui("screenshot", "--out", process.env.OMB_RUN_FEEDBACK_SCREENSHOT);
}, 180_000);
