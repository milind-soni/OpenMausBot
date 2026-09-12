// One-off recording script for the three new Live Team desk touches: the
// coffee run on pickup, the drowsy/asleep nap on an empty desk, and the
// manual desk-lamp toggle. Not part of regular coverage — run it directly to
// produce a demo clip:
//   OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/live-team-three-features-demo.e2e.test.ts
// It launches the same isolated fake-engine fixture the other Live Team UI
// test uses, so it never touches a real account or the operator's app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { ensureUiBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
const run = enabled ? it : it.skip;
const evidence = resolve(process.env.OMB_UI_EVIDENCE_DIR ?? ".omb-scratch/live-team/demo-hq");
const exec = promisify(execFile);
let fixture: VerificationServer | undefined;
let preview: MountedPreview | undefined;
let handle: UiHandle | undefined;
let recording = false;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const browser = async (...args: string[]) => {
  if (!handle) throw Error("No fixture browser");
  const { stdout } = await exec(handle.binary, [...args, "--json"], { env: sessionEnv(handle), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).catch((error) => { throw new Error(error.stdout || error.message); });
  const output = JSON.parse(stdout);
  if (output.success === false || output.ok === false) throw Error(JSON.stringify(output));
  return output.data ?? output;
};
const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", join(fixture!.info.dataDir, "ui.json"), ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture!.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};
const screenshot = (name: string) => ui("screenshot", "--out", join(evidence, name + ".png"));
const waitText = (text: string) => expect.poll(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), { timeout: 20_000 }).toBe(true);

afterAll(async () => {
  if (handle) {
    if (recording) await browser("record", "stop").catch(() => {});
    await closeBrowserSession(handle.binary, sessionEnv(handle));
  }
  await preview?.close();
  await fixture?.close();
}, 45_000);

run("shows the coffee run, the idle nap, and the desk-lamp toggle", async () => {
  mkdirSync(evidence, { recursive: true });
  const { binary, chrome } = await ensureUiBrowser();
  fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: binary, executablePath: chrome ?? "" });
  await api("PATCH", "/api/config", { language: "en" });
  const create = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", fixture!.info.url]) as any).bot;
  const milo = await create("Milo");
  const juniper = await create("Juniper");
  for (const bot of [milo, juniper]) await api("PATCH", `/api/bots/${bot.id}`, { section: "Demo Room", computer: "off" });

  // A gated fake CLI: Milo's turn stays "working" until this script releases it,
  // so the coffee-run window on screen is under our control, not a race.
  const wrapper = join(fixture.info.dataDir, "demo-gated.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(join(fixture.info.dataDir, "milo.gate"))};`,
    `await import(${JSON.stringify(pathToFileURL(resolve("server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });

  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__live-team-demo.html", title: "Live Team · feature demo fixture", logLevel: "silent" });
  handle = { ...fixture.info, home: fixture.info.dataDir, previewUrl: preview.previewUrl, session: `omb-demo-${new URL(fixture.info.url).port}`, binary, chrome, botId: milo.id };
  writeFileSync(join(fixture.info.dataDir, "ui.json"), JSON.stringify(handle));
  await browser("open", preview.previewUrl);
  await browser("set", "viewport", "1920", "1080");
  await waitText("Milo");

  // Compress only the long naps (tens of seconds) for the recording; short,
  // already-tuned beats (the coffee cup, the waking spin) play at real speed.
  await evaluate("window.setTimeout = new Proxy(window.setTimeout, { apply: (fn, self, args) => { if (typeof args[1] === 'number' && args[1] >= 10000) args[1] = Math.round(args[1] / 12); return fn.apply(self, args); } });");

  const navigation = await ui("snapshot");
  const toolsRef = Object.entries(navigation.refs).find(([, value]) => (value as any).name === "Tools" && (value as any).role === "button")?.[0];
  expect(toolsRef).toBeTruthy();
  await ui("click", "--ref", `@${toolsRef}`);
  await ui("click", "--name", "Team map");
  await ui("click", "--name", "Live Team");
  await waitText("Hand your team a brief");
  await ui("select", "--name", "Room", "--value", "Demo Room");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(2);
  await evaluate("document.querySelector('.studio-eyebrow').textContent = 'Feature demo · isolated fixture'");
  await screenshot("demo-00-open");

  if (process.env.OMB_UI_VIDEO !== "0") { await browser("record", "start", join(evidence, "three-features.webm"), "--fps", "30"); recording = true; }
  // The recorder's own capture pipeline starts a beat after this call returns;
  // without this pause the coffee-run trigger below races it and gets clipped.
  await sleep(2000);

  // Juniper is never touched: its desk starts its idle clock the moment the
  // room renders, so it dozes off in the background while Milo is assigned.
  await ui("type", "--name", "Hand your team a brief", "--text", "Draft the launch recap.");
  const picker = Object.entries((await ui("snapshot")).refs).find(([, value]) => (value as any).name === "Choose bot" && (value as any).role === "combobox")?.[0];
  await ui("select", "--ref", `@${picker}`, "--value", milo.id);
  await ui("click", "--name", "Send brief");
  await waitText("Brief sent to Milo.");
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate(`document.querySelector('[data-station="${milo.id}"]')?.dataset.state`), { timeout: 10_000 }).toBe("working");
  await screenshot("demo-01-coffee");
  await sleep(2500);

  // Let Juniper's nap run its course in the background while we sit here.
  await expect.poll(() => evaluate(`document.querySelector('[data-station="${juniper.id}"]')?.dataset.nap`), { timeout: 15_000 }).toBe("asleep");
  await screenshot("demo-02-asleep");
  await sleep(1500);

  // Release Milo's turn so its desk settles back down for the lamp scene.
  writeFileSync(join(fixture.info.dataDir, "milo.gate"), "done");
  await expect.poll(() => evaluate(`document.querySelector('[data-station="${milo.id}"]')?.dataset.state`), { timeout: 10_000 }).not.toBe("working");
  await ui("click", "--name", "Refresh studio");
  await sleep(500);

  for (const mode of ["Lights", "Lights", "Lights"]) {
    await ui("click", "--name", mode);
    await sleep(1200);
  }
  await screenshot("demo-03-lamps");
  await sleep(1000);

  if (recording) { await browser("record", "stop"); recording = false; }
}, 120_000);
