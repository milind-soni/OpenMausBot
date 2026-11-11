// @everyone on the Team map, in a real page on the fake engine: the line goes to the Chief alone, a stop goes to every bot as
// its own words, and with no Chief it goes to every bot as before. Screenshots go to OMB_EVERYONE_SHOTS when it is set.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = Boolean(binary) || process.env.OMB_UI_E2E === "1";
if (!enabled) console.log("skipping Team map @everyone UI: set OMB_UI_E2E=1 to install the pinned browser");

type Bot = { id: string; name: string; threadId: string; chiefOfStaff?: boolean; hidden?: boolean };

(enabled ? it : it.skip)("sends @everyone to the Chief, a stop to every bot, and to everyone when there is no Chief", async () => {
  let child: ChildProcess | undefined;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${info.url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      expect(response.ok, `${method} ${path}`).toBe(true);
      return await response.json() as any;
    };
    const bots = async () => ((await call("GET", "/api/bots?messages=0")).bots as Bot[]).filter((bot) => !bot.hidden);
    const linesTo = async (bot: Bot) => ((await call("GET", `/api/threads/${bot.threadId}/messages`)).messages as Array<{ role: string; text?: string }>)
      .filter((message) => message.role === "user").map((message) => message.text ?? "");
    const shot = async (name: string) => { if (process.env.OMB_EVERYONE_SHOTS) await ui("screenshot", "--out", join(process.env.OMB_EVERYONE_SHOTS, `${name}.png`)); };
    const press = (label: string) => evaluate(`(() => { const target = [...document.querySelectorAll('button, a, [role=menuitem]')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)}); target?.click(); return Boolean(target); })()`);
    const pageText = () => evaluate("document.body.innerText") as Promise<string>;

    for (const name of ["Mail", "Books", "Calendar"]) await call("POST", "/api/bots", { name });
    let chief = (await bots()).find((bot) => bot.chiefOfStaff);
    if (!chief) {
      const first = (await bots())[0]!;
      await call("PATCH", `/api/bots/${first.id}`, { chiefOfStaff: true, acknowledgePeerScope: true });
      chief = { ...first, chiefOfStaff: true };
    }
    await evaluate("location.reload(); true");
    await expect.poll(pageText, { timeout: 20_000 }).toContain("Calendar");
    if (!await press("Team map")) await press("Tools");
    await expect.poll(() => press("Team map").then(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message bots on the map\"]'))")), { timeout: 20_000 }).toBe(true);
    const before = new Map(await Promise.all((await bots()).map(async (bot) => [bot.id, (await linesTo(bot)).length] as const)));
    const say = async (text: string) => {
      await ui("type", "--name", "Message bots on the map", "--text", text);
      await ui("press", "--keys", "Escape");
    };
    const send = () => ui("press", "--keys", "Enter");

    // An ordinary line: the Chief gets it and says it passes it on; no other bot gets a line, so none takes a turn.
    await say("@everyone we need to fetch and send mail today");
    await expect.poll(pageText).toContain(`Goes to ${chief.name}, who passes it on to the bots it concerns`);
    await shot("everyone-before-send");
    await send();
    await expect.poll(pageText).toContain(`Sent to ${chief.name}, who passes it on`);
    await shot("everyone-sent-to-chief");
    await expect.poll(() => linesTo(chief!)).toContain("@everyone we need to fetch and send mail today");
    for (const bot of (await bots()).filter((one) => one.id !== chief!.id)) expect(await linesTo(bot), bot.name).toHaveLength(before.get(bot.id) ?? 0);

    // A stop reaches every bot at once, as its own words, so each bot's own send path stops it.
    await say("@everyone stop");
    await send();
    for (const bot of await bots()) await expect.poll(() => linesTo(bot), { message: bot.name }).toContain("stop");
    await shot("everyone-stop");

    // No Chief: everyone gets the line, as before.
    await call("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    await evaluate("location.reload(); true");
    await expect.poll(() => press("Team map").then(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message bots on the map\"]'))")), { timeout: 20_000 }).toBe(true);
    await say("@everyone hello all");
    await expect.poll(pageText).not.toContain("who passes it on");
    await send();
    for (const bot of await bots()) await expect.poll(() => linesTo(bot), { message: bot.name }).toContain("@everyone hello all");
  } finally { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); }
}, 720_000);
