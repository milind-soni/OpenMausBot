import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const evidence = resolve(process.env.OMB_UI_EVIDENCE_DIR ?? ".omb-scratch/live-team/evidence");
const exec = promisify(execFile);
let fixture: VerificationServer | undefined;
let preview: MountedPreview | undefined;
let handle: UiHandle | undefined;
let socket: Socket | undefined;
const extraSockets: Socket[] = [];
let recording = false;
const browser = async (...args: string[]) => {
  if (!handle) throw Error("No fixture browser");
  const { stdout } = await exec(handle.binary, [...args, "--json"], { env: sessionEnv(handle), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).catch((error) => { throw new Error(error.stdout || error.message); });
  const output = JSON.parse(stdout);
  if (output.success === false || output.ok === false) throw Error(JSON.stringify(output));
  return output.data ?? output;
};
const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", join(fixture!.info.dataDir, "ui.json"), ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture!.info.url }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};
const studio = () => api("GET", "/api/team-map/studio?room=Launch");
const screenshot = async (name: string) => ui("screenshot", "--out", join(evidence, name + ".png"));
const waitText = async (text: string) => expect.poll(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), { timeout: 20_000 }).toBe(true);

afterAll(async () => {
  if (handle) {
    await screenshot("last-render").catch(() => {});
    writeFileSync(join(evidence, "last-snapshot.json"), JSON.stringify(await ui("snapshot").catch(() => null), null, 2));
    writeFileSync(join(evidence, "drag-events.json"), JSON.stringify(await evaluate("window.__studioDragEvents ?? []").catch(() => null), null, 2));
  }
  socket?.destroy();
  for (const connection of extraSockets) connection.destroy();
  if (handle) {
    if (recording) await browser("record", "stop").catch(() => {});
    await closeBrowserSession(handle.binary, sessionEnv(handle));
  }
  await preview?.close();
  await fixture?.close();
}, 45_000);

run("assigns tasks, answers questions, follows handoffs and results, and returns from workstations", async () => {
  mkdirSync(evidence, { recursive: true });
  const { binary, chrome } = await ensureUiBrowser();
  fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: binary, executablePath: chrome ?? "" });
  await api("PATCH", "/api/config", { language: "en" });
  const create = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", fixture!.info.url]) as any).bot;
  const coordinator = await create("Coordinator");
  const researcher = await create("Researcher");
  const writer = await create("Writer");
  const designer = await create("Designer");
  const team = [coordinator, researcher, writer, designer];
  for (const bot of team) await api("PATCH", `/api/bots/${bot.id}`, { section: "Launch", computer: "off" });
  const wrapper = join(fixture.info.dataDir, "studio-gated.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync, existsSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
    `process.env.FAKE_CLAUDE_MODE = existsSync(${JSON.stringify(join(fixture.info.dataDir, "fail-next"))}) ? "exit-early" : "slow";`,
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".json");`,
    `await import(${JSON.stringify(pathToFileURL(resolve("server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__live-team.html", title: "Live Team · isolated test fixture", logLevel: "silent" });
  handle = { ...fixture.info, home: fixture.info.dataDir, previewUrl: preview.previewUrl, session: `omb-studio-${new URL(fixture.info.url).port}`, binary, chrome, botId: coordinator.id };
  writeFileSync(join(fixture.info.dataDir, "ui.json"), JSON.stringify(handle));
  await browser("open", preview.previewUrl);
  await browser("set", "viewport", "1440", "1000");
  await waitText("Coordinator");
  const navigation = await ui("snapshot");
  const toolsRef = Object.entries(navigation.refs).find(([, value]) => (value as any).name === "Tools" && (value as any).role === "button")?.[0];
  expect(toolsRef).toBeTruthy();
  await ui("click", "--ref", `@${toolsRef}`);
  await ui("click", "--name", "Team map");
  await screenshot("map-before");
  await ui("click", "--name", "Live Team");
  await waitText("Hand your team a brief");
  await ui("select", "--name", "Room", "--value", "Launch");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(4);
  // The fixture is labeled in the page title and in the recorded room header.
  await evaluate("document.querySelector('.studio-eyebrow').textContent = 'Isolated test fixture'");
  await screenshot("studio-four-dark");
  if (process.env.OMB_UI_VIDEO === "1") { await browser("record", "start", join(evidence, "launch.webm"), "--fps", "10"); recording = true; }
  await ui("type", "--name", "Hand your team a brief", "--text", "Prepare tomorrow's launch. Gather evidence, draft the announcement, and propose a launch graphic.");
  await evaluate("window.__studioDragEvents = []; for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => window.__studioDragEvents.push({type, types: Array.from(event.dataTransfer.types), tag: event.target.tagName, x: event.clientX, y: event.clientY}));");
  await browser("scrollintoview", `[data-station="${coordinator.id}"] .studio-desk-scene`);
  await ui("drag", "--source", ".studio-drag-slip", "--target", `[data-station="${coordinator.id}"] .studio-desk-scene`);
  await expect.poll(() => evaluate("document.querySelector('.studio-send-review')?.textContent"), { timeout: 5000 }).toContain("Coordinator");
  expect((await studio()).results.total).toBe(0);
  await ui("click", "--name", "Send brief");
  await waitText("Brief sent to Coordinator.");
  const initial = await studio();
  const threadId = initial.stations.find((station: any) => station.botId === coordinator.id).threads[0].threadId;
  expect(threadId).not.toBe(coordinator.threadId);
  await expect.poll(() => existsSync(join(fixture!.info.dataDir, threadId + ".json")), { timeout: 20_000 }).toBe(true);
  const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, threadId + ".json"), "utf8"));
  const messages = await api("GET", `/api/threads/${threadId}/messages?limit=50`);
  expect(messages.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
  expect(await evaluate("!!document.querySelector('.live-team')")).toBe(true);
  socket = connect(dump.mcpConfig.mcpServers.ogb.args.at(-1));
  await new Promise<void>((done, fail) => { socket!.once("connect", done); socket!.once("error", fail); });
  let answer = "";
  socket.on("data", (chunk) => { answer += chunk.toString(); });
  socket.write(JSON.stringify({ t: "ask", id: "studio-tone", kind: "question", tool: "ask_user", input: { question: "Which tone should the launch announcement use?", choices: ["Warm", "Direct"] } }) + "\n");
  await expect.poll(async () => (await studio()).attention.total, { timeout: 20_000 }).toBe(1);
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate(`!!document.querySelector('[data-station="${coordinator.id}"] .studio-hand')`)).toBe(true);
  await screenshot("studio-question");
  await ui("click", "--name", "Coordinator needs you");
  await waitText("Which tone should the launch announcement use?");
  await ui("click", "--name", "A Warm");
  await expect.poll(() => answer).toContain("Warm");
  await ui("click", "--name", "Back to studio");
  await expect.poll(() => evaluate(`document.activeElement?.closest('[data-station]')?.getAttribute('data-station')`)).toBe(coordinator.id);
  const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
  const briefs = ["Gather the launch evidence.", "Draft a warm launch announcement.", "Propose a launch graphic."];
  for (const [i, peer] of [researcher, writer, designer].entries()) await api("POST", "/api/internal/delegate-bot", { toBotId: peer.id, message: briefs[i] }, token);
  await expect.poll(async () => (await studio()).handoffs.total).toBe(3);
  await ui("click", "--name", "Refresh studio");
  await screenshot("studio-queued");
  await evaluate("window.__studioAnimations = []; document.addEventListener('animationstart', event => { if (event.animationName === 'studio-desk-transfer') window.__studioAnimations.push({id: event.target.dataset.motion, at: performance.now(), fromX: event.target.style.getPropertyValue('--from-x'), fromY: event.target.style.getPropertyValue('--from-y')}); });");
  writeFileSync(join(fixture.info.dataDir, threadId + ".gate"), "finish source");
  await expect.poll(async () => (await studio()).handoffs.items.some((item: any) => item.state === "running"), { timeout: 20_000 }).toBe(true);
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("window.__studioAnimations.some(item => item.id.startsWith('handoff:'))"), { timeout: 5000 }).toBe(true);
  writeFileSync(join(evidence, "motion.json"), JSON.stringify(await evaluate("window.__studioAnimations"), null, 2));
  await screenshot("studio-working");
  await browser("click", ".studio-handoff:nth-of-type(1)");
  await expect.poll(() => evaluate("document.querySelector('.studio-request-text')?.textContent")).toSatisfy((text: string) => briefs.includes(text));
  await screenshot("handoff-request");
  await ui("click", "--name", "Close");
  writeFileSync(join(fixture.info.dataDir, "probe.gate"), "finish peers");
  await expect.poll(async () => (await studio()).handoffs.items.filter((item: any) => item.state === "completed").length, { timeout: 30_000 }).toBe(3);
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-result]').length"), { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await screenshot("studio-results");
  const last = await studio();
  const result = last.results.items[0];
  await expect.poll(() => evaluate(`!!document.querySelector('[data-result="${result.id}"]')`), { timeout: 20_000 }).toBe(true);
  await browser("scrollintoview", `[data-result="${result.id}"]`);
  await browser("click", `[data-result="${result.id}"]`);
  if (result.messageId) await expect.poll(() => evaluate(`!!document.querySelector('[data-mid="${result.messageId}"]')`)).toBe(true);
  await ui("click", "--name", "Back to studio");
  await ui("click", "--name", "Calm mode");
  expect(await evaluate("document.querySelector('.live-team').dataset.calm")).toBe("true");
  await browser("network", "requests", "--clear");
  await ui("click", "--name", "Open Designer computer");
  await waitText("This workstation opens in watch mode.");
  const network = await browser("network", "requests");
  expect(JSON.stringify(network)).not.toContain("/computer/provision");
  await screenshot("workstation-off");
  await ui("click", "--name", "Back to studio");
  expect(await evaluate("document.querySelector('.studio-toolbar select').value")).toBe("Launch");
  if (recording) { await browser("record", "stop"); recording = false; }
  // Keyboard assignment retains the draft through a rejected send, then retries once.
  await ui("type", "--name", "Hand your team a brief", "--text", "Keyboard follow-up for the launch.");
  const choices = await ui("snapshot");
  const picker = Object.entries(choices.refs).find(([, value]) => (value as any).name === "Choose bot" && (value as any).role === "combobox")?.[0];
  await ui("select", "--ref", `@${picker}`, "--value", coordinator.id);
  await browser("network", "route", `**/api/bots/${coordinator.id}/messages`, "--abort");
  await ui("click", "--name", "Send brief");
  await waitText("The brief was not confirmed.");
  expect(await evaluate("document.querySelector('#studio-brief').value")).toBe("Keyboard follow-up for the launch.");
  await browser("network", "unroute", `**/api/bots/${coordinator.id}/messages`);
  await ui("click", "--name", "Retry send");
  await waitText("Brief sent to Coordinator.");
  const followup = (await studio()).stations.find((station: any) => station.botId === coordinator.id).threads[0];
  writeFileSync(join(fixture.info.dataDir, followup.threadId + ".gate"), "finish keyboard follow-up");
  await expect.poll(async () => (await studio()).stations.find((station: any) => station.botId === coordinator.id).threads.length, { timeout: 20_000 }).toBe(0);

  // A connection failure retains a static last-known room and does not replay on recovery.
  await browser("network", "route", "**/api/team-map/studio*", "--abort");
  await ui("click", "--name", "Refresh studio");
  await waitText("Updates are unavailable.");
  expect(await evaluate("document.querySelector('.live-team').dataset.calm")).toBe("true");
  await browser("network", "unroute", "**/api/team-map/studio*");
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("!!document.querySelector('.studio-connection[data-stale=false]')")).toBe(true);
  expect(await evaluate("document.querySelectorAll('.studio-travel-slip').length")).toBe(0);

  await evaluate("document.documentElement.dataset.skin = 'atelier'");
  for (const width of [375, 768, 1024, 1440]) {
    await browser("set", "viewport", String(width), "1000");
    await browser("wait", "500");
    await evaluate("document.querySelector('.studio-body').scrollTop = 0");
    expect(await evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    expect(await evaluate("document.querySelector('.live-team').scrollWidth <= document.querySelector('.live-team').clientWidth + 1")).toBe(true);
    await screenshot(`studio-light-${width}`);
  }
  await browser("set", "media", "reduced-motion");
  await expect.poll(() => evaluate("document.querySelector('.live-team').dataset.calm")).toBe("true");
  expect(await evaluate("document.querySelectorAll('.studio-travel-slip').length")).toBe(0);
  await screenshot("studio-reduced-motion");

  for (const name of ["Editor", "Producer"]) {
    const bot = await create(name);
    await api("PATCH", `/api/bots/${bot.id}`, { section: "Launch", computer: "off" });
  }
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(6);
  await screenshot("studio-six");
  for (let i = 0; i < 10; i++) {
    const bot = await create(`Teammate ${i + 1}`);
    await api("PATCH", `/api/bots/${bot.id}`, { section: "Launch", computer: "off" });
  }
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(12);
  await screenshot("studio-twelve");
  await browser("click", '.studio-floor button[aria-label="Next page"]');
  expect(await evaluate("document.querySelectorAll('[data-station]').length")).toBe(4);
  await screenshot("studio-second-page");
  await ui("type", "--name", "Find a bot", "--text", "Designer");
  expect(await evaluate("document.querySelectorAll('[data-station]').length")).toBe(1);
  await screenshot("studio-filtered");
  await browser("fill", '.studio-search input', "no such bot");
  await screenshot("studio-no-match");
  expect(await evaluate("document.querySelectorAll('[data-station]').length")).toBe(0);
  await browser("focus", '.studio-search input');
  // Native CDP shortcuts do not implement macOS select-all editing commands.
  // Delete the known fixture text with actual key input.
  for (let i = 0; i < "no such bot".length; i++) await ui("press", "--keys", "Backspace");
  expect(await evaluate("document.querySelector('.studio-search input').value")).toBe("");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(12);

  // Restore standard motion and skin after the accessibility checks.
  await browser("set", "media", "light");
  if (await evaluate("!document.querySelector('.studio-header button[aria-pressed]').disabled")) await ui("click", "--name", "Calm mode");
  await evaluate("document.documentElement.dataset.skin = 'midnight'");
  await screenshot("studio-final");
  writeFileSync(join(evidence, "launch.json"), JSON.stringify({ fixture: { url: fixture.info.url, logPath: fixture.info.logPath }, terminalSnapshot: last, network, platform: process.platform, node: process.version }, null, 2));
  if (process.env.OMB_UI_ELECTRON === "1") {
    const config = join(fixture.info.dataDir, "electron-fixture.json");
    writeFileSync(config, JSON.stringify({ kind: "openmausbot-live-team-fixture", url: preview.previewUrl, workspaceId: last.workspaceId, botId: designer.id, evidence }));
    const electron = createRequire(import.meta.url)("electron");
    const output = await exec(electron, [resolve("scripts/testing/live-team-electron.mjs"), config], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, XDG_CONFIG_HOME: fixture.info.dataDir, TMPDIR: fixture.info.dataDir, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot } }).catch((error) => { writeFileSync(join(evidence, "electron.log"), String(error.stdout ?? "") + String(error.stderr ?? "")); throw error; });
    writeFileSync(join(evidence, "electron.log"), output.stdout + output.stderr);
  }
  // Two real background threads on one bot retain separate questions and results.
  const concurrent: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await api("POST", `/api/bots/${coordinator.id}/tasks`, { title: `Concurrent studio task ${i}`, activate: false });
    concurrent.push(created.task.threadId);
    await api("POST", `/api/bots/${coordinator.id}/messages`, { text: `Concurrent studio task ${i}`, threadId: created.task.threadId, sendId: crypto.randomUUID() });
    await expect.poll(() => existsSync(join(fixture!.info.dataDir, created.task.threadId + ".json")), { timeout: 20_000 }).toBe(true);
    const taskDump = JSON.parse(readFileSync(join(fixture.info.dataDir, created.task.threadId + ".json"), "utf8"));
    const connection = connect(taskDump.mcpConfig.mcpServers.ogb.args.at(-1));
    extraSockets.push(connection);
    await new Promise<void>((done, fail) => { connection.once("connect", done); connection.once("error", fail); });
    connection.write(JSON.stringify({ t: "ask", id: `studio-concurrent-${i}`, kind: "question", tool: "ask_user", input: { question: `Choose direction for task ${i}`, choices: ["Warm", "Direct"] } }) + "\n");
  }
  await expect.poll(async () => (await studio()).attention.total, { timeout: 20_000 }).toBe(2);
  await ui("type", "--name", "Find a bot", "--text", "Coordinator");
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate(`document.querySelector('[data-station="${coordinator.id}"] .studio-task-stack')?.textContent`)).toBe("2");
  await ui("click", "--name", "Coordinator needs you");
  await expect.poll(() => evaluate("document.querySelectorAll('.studio-attention .studio-list-item').length")).toBe(2);
  await expect.poll(() => evaluate("document.querySelector('.studio-announcement').textContent")).toContain("2 requests need your attention");
  await expect.poll(() => evaluate("document.activeElement?.classList.contains('studio-detail')")).toBe(true);
  await screenshot("studio-concurrent-questions");
  const uploaded = await fetch(fixture.info.url + "/api/attachments", { method: "POST", headers: { "content-type": "image/png", origin: fixture.info.url }, body: readFileSync(resolve("build/icon.iconset/icon_128x128.png")) });
  expect(uploaded.status).toBe(201);
  const avatar = await uploaded.json() as { path: string };
  await api("PATCH", `/api/bots/${coordinator.id}`, { avatarUrl: `/api/attachments/${avatar.path.split("/").at(-1)}`, avatarCrop: "circle" });
  await expect.poll(() => evaluate(`document.querySelector('[data-station="${coordinator.id}"] .studio-maus img')?.naturalWidth > 0`)).toBe(true);
  expect(await evaluate(`!!document.querySelector('[data-station="${coordinator.id}"] .studio-hand')`)).toBe(true);
  await screenshot("studio-custom-avatar-question");
  // Fixture-only pseudo-localization stresses real t() output, including memoized desks.
  await evaluate("(async () => { const catalog = await import('/src/locales/index.ts'); const i18n = await import('/src/lib/i18n.ts'); catalog.locales['studio-stress'] = Object.fromEntries(Object.entries(catalog.en).filter(([key]) => key.startsWith('studio.')).map(([key, value]) => [key, '⟦ ' + value + ' · expanded label ⟧'])); i18n.setLocale('studio-stress'); })()");
  await browser("click", '.studio-header button:last-child');
  await browser("set", "viewport", "375", "1000");
  await browser("wait", "500");
  expect(await evaluate("document.querySelector('.live-team').scrollWidth <= document.querySelector('.live-team').clientWidth + 1")).toBe(true);
  await screenshot("studio-long-labels");
  await evaluate("import('/src/lib/i18n.ts').then(module => module.setLocale('en'))");
  await browser("click", '.studio-header button:last-child');
  await browser("set", "viewport", "1440", "1000");
  await browser("wait", "500");

  const pending = (await studio()).attention.items;
  // Simulate answering from a second client while this room remains open.
  for (const question of pending) await api("POST", `/api/threads/${question.threadId}/respond`, { requestId: question.requestId, behavior: "answer", message: "Warm" });
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('.studio-attention .studio-list-item').length")).toBe(0);
  await ui("click", "--name", "Close task details");
  for (const thread of concurrent) await api("POST", `/api/bots/${coordinator.id}/interrupt`, { threadId: thread });
  await expect.poll(async () => (await studio()).results.items.filter((item: any) => concurrent.includes(item.threadId) && item.status === "interrupted").length, { timeout: 20_000 }).toBe(2);
  writeFileSync(join(fixture.info.dataDir, "fail-next"), "fail the next fake-engine turn");
  const failure = await api("POST", `/api/bots/${coordinator.id}/tasks`, { activate: false });
  await api("POST", `/api/bots/${coordinator.id}/messages`, { text: "Exercise a failed turn", threadId: failure.task.threadId, sendId: crypto.randomUUID() });
  await expect.poll(async () => (await studio()).results.items.find((item: any) => item.threadId === failure.task.threadId)?.status, { timeout: 20_000 }).toBe("failed");
  rmSync(join(fixture.info.dataDir, "fail-next"));
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-outcome=failed]').length")).toBe(1);
  await screenshot("studio-terminal-errors");
  writeFileSync(join(evidence, "terminal-errors.json"), JSON.stringify(await studio(), null, 2));

  // An empty workspace has an actionable first-bot state, with no stale result content.
  const allBots = (await api("GET", "/api/bots?messages=0")).bots;
  await browser("focus", '.studio-search input');
  for (let i = 0; i < "Coordinator".length; i++) await ui("press", "--keys", "Backspace");
  for (const bot of allBots) await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
  await ui("click", "--name", "Refresh studio");
  await expect.poll(() => evaluate("document.querySelectorAll('[data-station]').length")).toBe(0);
  await expect.poll(() => evaluate("!!document.querySelector('.studio-empty button')")).toBe(true);
  expect(await evaluate("document.querySelectorAll('[data-result]').length")).toBe(0);
  await screenshot("studio-empty");
  const consoleOutput = await ui("console");
  writeFileSync(join(evidence, "console.json"), JSON.stringify(consoleOutput, null, 2));
  const runtimeErrors = await browser("errors");
  writeFileSync(join(evidence, "runtime-errors.json"), JSON.stringify(runtimeErrors, null, 2));
  expect(runtimeErrors).toMatchObject({ errors: [] });
}, 300_000);
