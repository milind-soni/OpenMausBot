import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { runControlOmb } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

const TOOL_CALLS = [
  { name: "mcp__composio__GMAIL_FETCH_EMAILS", input: { query: "is:unread newer_than:1d" }, ok: true },
  { name: "mcp__composio__GMAIL_CREATE_EMAIL_DRAFT", input: { to: "sam@example.test", subject: "Your refund" }, ok: true },
  { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", input: { tools: [
    { tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#orders", text: "Refund for order 1042 is on its way." } },
    { tool_slug: "HUBSPOT_CREATE_CONTACT", arguments: { email: "sam@example.test" } },
  ] }, ok: true },
  { name: "mcp__composio__GMAIL_SEND_EMAIL", input: { to: "sam@example.test", subject: "Your refund" }, ok: true },
  { name: "Bash", input: { command: "echo done" }, ok: true },
];

(process.env.OMB_UI_E2E === "1" ? it : it.skip)("Today shows one next step on a new install, then what the bot did, its routine and the time it saved", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let output = "";
  child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch", "--tool-calls", JSON.stringify(TOOL_CALLS)], {
    cwd: root, env: { ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["Replied to Sam about the refund and logged the order in HubSpot.", "Morning briefing is in your inbox: 3 orders need a reply."]) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => { output += chunk; });
  let fixture: { ui: string; url: string; botId: string };
  await expect.poll(() => {
    try { fixture = JSON.parse(output); return Boolean(fixture.ui); } catch { return false; }
  }, { timeout: 180_000 }).toBe(true);
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<any>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const page = () => evaluate("document.querySelector('[data-testid=today-page]')?.innerText ?? ''");

  await ui("click", "--name", "Today");
  await expect.poll(page, { timeout: 30_000 }).toContain("Nothing finished yet today");
  expect(await page()).toContain("Set up your first routine");

  await runControlOmb(["send", "--bot", fixture!.botId, "--text", "Reply to Sam about the refund for order 1042.", "--url", fixture!.url]);
  await runControlOmb(["wait", "--bot", fixture!.botId, "--timeout", "90", "--url", fixture!.url]);
  const created = await fetch(`${fixture!.url}/api/routines`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Morning briefing", prompt: "Summarize the inbox.", botId: fixture!.botId, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } }) });
  expect(created.ok).toBe(true);
  const { routine } = await created.json();
  expect((await fetch(`${fixture!.url}/api/routines/${routine.id}/run`, { method: "POST" })).ok).toBe(true);
  await expect.poll(async () => {
    const { runs } = await fetch(`${fixture!.url}/api/routines`).then((r) => r.json());
    return runs.find((run: { routineId: string }) => run.routineId === routine.id)?.status;
  }, { timeout: 90_000 }).toBe("completed");

  await evaluate("window.dispatchEvent(new Event('focus'))");
  await expect.poll(() => evaluate("[...document.querySelectorAll('[data-today-tile]')].map((tile) => tile.getAttribute('data-today-tile')).join(',')"), { timeout: 30_000 })
    .toBe("emailRead,draft,emailSent,message,report,lead,routines");
  const text = await page();
  expect(text).toContain("Time saved");
  expect(text).toMatch(/≈ \d+ m/);
  expect(text).toContain("1 OK");
  expect(text).toContain("Morning briefing");
  expect(text).toContain("Replied to Sam about the refund and logged the order in HubSpot.");
  expect(await evaluate("document.querySelector('[data-today-tile=emailRead]').innerText")).toContain("2");
  expect(await evaluate("document.querySelector('[data-testid=today-time-saved]').getAttribute('title')")).toContain("An estimate, not a measurement.");
  if (process.env.OMB_TODAY_SCREENSHOT) await ui("screenshot", "--out", process.env.OMB_TODAY_SCREENSHOT);

  await evaluate("[...document.querySelectorAll('[data-today-line] button')].find((button) => button.innerText.includes('Replied to Sam')).click()");
  await expect.poll(() => evaluate("!!document.querySelector('textarea[aria-label=\"Message Pepper\"]')"), { timeout: 30_000 }).toBe(true);

  // Simple mode keeps Today at the top of its own sidebar.
  await evaluate("localStorage.setItem('omb-advanced-mode', '0'); location.reload()");
  await expect.poll(() => evaluate("!!document.querySelector('[data-sidebar-nav=today]')"), { timeout: 30_000 }).toBe(true);
  await evaluate("document.querySelector('[data-sidebar-nav=today]').click()");
  await expect.poll(page, { timeout: 30_000 }).toContain("Morning briefing");
  if (process.env.OMB_TODAY_SCREENSHOT) await ui("screenshot", "--out", process.env.OMB_TODAY_SCREENSHOT.replace(/\.png$/, "-simple.png"));
}, 300_000);
