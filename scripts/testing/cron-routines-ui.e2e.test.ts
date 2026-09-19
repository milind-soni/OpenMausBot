// Real renderer and routes in a disposable fake-engine workspace only.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import type { Routine } from "../../src/lib/routines.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(enabled ? it : it.skip)("creates monthly routines, validates cron, preserves arbitrary expressions and excludes calls", async () => {
  let output = "";
  let stderr = "";
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  let fixture: { ui: string; url: string; botId: string; logPath: string };
  await expect.poll(() => {
    if (child!.exitCode !== null) throw new Error(stderr);
    try { fixture = JSON.parse(output); return Boolean(fixture.ui); } catch { return false; }
  }, { timeout: 600_000 }).toBe(true);
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  // The shared harness lacks select/fill verbs. Drive native controls through
  // DOM input/change events; all saves and reads still use the real renderer.
  const fill = (selector: string, value: string) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })); return field.value; })()`);
  const select = (label: string, value: string) => evaluate(`(() => { const field = document.querySelector('select[aria-label=${JSON.stringify(label)}]') ?? [...document.querySelectorAll('label')].find(label => label.firstElementChild?.textContent === ${JSON.stringify(label)})?.control; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); return field.value; })()`);
  const routines = async (): Promise<Routine[]> => (await fetch(`${fixture.url}/api/routines`).then(response => response.json())).routines;
  const repeatOptions = () => evaluate("[...document.querySelector('select[aria-label=Repeat]').options].map(option => option.value)");

  await click("Tools"); await click("Automations");
  await click("Create an automation"); await click("Create a scheduled task");
  await fill('input[placeholder="Add title"]', "Monthly close");
  await fill('textarea[placeholder="What should the bot do?"]', "Summarize this fixture only.");
  await click("More options");
  expect(await evaluate('document.querySelector(\'input[placeholder="Add title"]\').value')).toBe("Monthly close");
  await click("Call");
  const callOptions = await repeatOptions();
  for (const choice of ["monthly", "yearly", "cron"]) expect(callOptions).not.toContain(choice);
  await click("Routine");
  expect(await evaluate("document.body.innerText")).toContain("Bot’s current setup");
  expect(await evaluate("document.body.innerText")).toContain("Box-hosted agent");
  expect(await evaluate("document.body.innerText")).toContain("including a self-hosted VPS");
  expect(await repeatOptions()).toEqual(expect.arrayContaining(["monthly", "yearly", "cron"]));
  await select("Repeat", "monthly");
  await select("Day of month", "L");
  await fill('input[type="time"]', "09:00");
  await fill('input[list="routine-time-zones"]', "UTC");
  await expect.poll(() => evaluate('document.querySelectorAll(\'[aria-label="Next scheduled runs"] time\').length')).toBe(3);
  await evaluate('document.querySelector(\'[aria-label="Next scheduled runs"]\').scrollIntoView({ block: "center" })');
  await ui("screenshot", "--out", `${fixture!.logPath}.cron-monthly.png`);
  await select("Repeat", "cron");
  expect(await evaluate('document.querySelector(\'input[placeholder="0 9 1 * *"]\').value')).toBe("0 9 L * *");
  await fill('input[placeholder="0 9 1 * *"]', "0 9 31 2 *");
  await expect.poll(() => evaluate('document.querySelector("[role=alert]")?.textContent')).toContain("no future runs");
  expect(await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Schedule routine').disabled")).toBe(true);
  await select("Repeat", "monthly");
  await click("Schedule routine");
  await expect.poll(routines).toHaveLength(1);
  const monthly = (await routines())[0];
  expect(monthly).toMatchObject({ name: "Monthly close", prompt: "Summarize this fixture only.", schedule: { type: "cron", expression: "0 9 L * *", timeZone: "UTC" } });
  await click("List");
  await evaluate("document.querySelector('article[aria-label=\"Monthly close\"] button').click()");
  await click("Edit");
  expect(await evaluate("document.querySelector('select[aria-label=Repeat]').value")).toBe("monthly");
  await select("Repeat", "yearly");
  await select("Month", "2"); await select("Day of month", "29");
  await click("Save");
  await expect.poll(async () => (await routines()).find(routine => routine.id === monthly.id)?.schedule).toEqual({ type: "cron", expression: "0 9 29 2 *", timeZone: "UTC" });

  // The API models a bot-created arbitrary schedule. Editing only its title
  // must not collapse its ranges, weekdays, or non-local timezone to a preset.
  const customSchedule = { type: "cron", expression: "15 9-17/2 * * 1-5", timeZone: "America/New_York" };
  const response = await fetch(`${fixture.url}/api/routines`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.url }, body: JSON.stringify({ name: "Business-hours report", prompt: "Use only the fixture.", botId: monthly.botId, enabled: false, runOn: "maus", schedule: customSchedule }) });
  expect(response.status).toBe(201);
  const custom = (await response.json()).routine;
  await click("List");
  await expect.poll(() => evaluate("document.body.textContent")).toContain("Business-hours report");
  await evaluate("[...document.querySelectorAll('article button')].find(button => button.textContent.includes('Business-hours report')).click()");
  expect(await evaluate('document.querySelector(\'[aria-label="Paused schedule preview"]\')?.textContent')).toContain("Paused — schedule preview");
  await click("Edit");
  expect(await evaluate("document.querySelector('select[aria-label=Repeat]').value")).toBe("cron");
  expect(await evaluate('document.querySelector(\'input[list="routine-time-zones"]\').value')).toBe("America/New_York");
  await fill('input[placeholder="Add title"]', "Renamed report");
  await click("Save");
  await expect.poll(async () => (await routines()).find(routine => routine.id === custom.id)?.name).toBe("Renamed report");
  expect((await routines()).find(routine => routine.id === custom.id)?.schedule).toEqual(customSchedule);
  const browserConsole = await ui("console");
  expect((browserConsole.messages as Array<{ type: string }>).filter(message => message.type === "error")).toEqual([]);
  console.log(`Cron UI evidence: ${fixture!.logPath}.cron-monthly.png`);
}, 720_000);
