import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanWorkspaceConfig, profileDir } from "../electron/clean-workspace.mjs";
import { createProfileRegistry } from "../electron/local-profiles.mjs";
import { connectCdp } from "../server/browser-sites.ts";
import { handleToolCall } from "./mcp-server.ts";

const executable = resolve(process.argv[2] ?? "release/linux-unpacked/openmausbot");
assert.ok(existsSync(executable), "Build the packaged desktop first");
const fixture = mkdtempSync(join(tmpdir(), "omb-workspace-windows-"));
const data = join(fixture, "data"), home = join(fixture, "home"), user = join(fixture, "user-data");
const finish = join(fixture, "finish"), personal = profileDir(data, "personal");
for (const dir of [data, home, user]) mkdirSync(dir, { recursive: true, mode: 0o700 });
assert.equal(createProfileRegistry({ dataDir: () => data }).create({ name: "Personal" }).profile.id, "personal");
mkdirSync(personal, { recursive: true, mode: 0o700 });
const cli = fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url));
for (const dir of [data, personal]) writeFileSync(join(dir, "config.json"), JSON.stringify({
  ...cleanWorkspaceConfig("en"), instances: { claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli } } },
}), { mode: 0o600 });
const replies = join(fixture, "chat-replies.json");
writeFileSync(replies, JSON.stringify({
  "Amber window reply": [{ say: "Amber received." }], "Indigo window reply": [{ say: "Indigo received." }],
}));
const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "HYPRLAND_INSTANCE_SIGNATURE"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const platform = display.WAYLAND_DISPLAY ? "wayland" : "x11";
const app = spawn(executable, [`--ozone-platform=${platform}`, "--password-store=basic", `--user-data-dir=${user}`, "--remote-debugging-port=0"], {
  cwd: home, env: { ...display, PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: home,
    OMB_DATA_DIR: data, OMB_COMPOSIO_BROKER_URL: "http://127.0.0.1:1", OMB_WEBHOOK_PORT: "0", FAKE_STREAM_SCRIPT: replies, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finish },
  stdio: "ignore",
});
const ended = new Promise((done, fail) => { app.once("exit", done); app.once("error", fail); });
async function until(read, label) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline && app.exitCode === null && app.signalCode === null) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let cdp;
try {
  const endpoint = await until(() => {
    const path = join(user, "DevToolsActivePort");
    if (!existsSync(path)) return null;
    const [port, browser] = readFileSync(path, "utf8").split("\n");
    return port && browser && `ws://127.0.0.1:${Number(port)}${browser}`;
  }, "fixture browser");
  cdp = await connectCdp(endpoint, 40_000);
  const pages = async () => (await cdp.send("Target.getTargets")).targetInfos.filter(row => row.type === "page");
  async function attach(find, label) {
    const page = await until(async () => (await pages()).find(find), label);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const evaluate = async (expression, userGesture = false) => {
      const result = await cdp.send("Runtime.evaluate", { expression, userGesture, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await until(() => evaluate(`location.href === ${JSON.stringify(page.url)} && document.readyState === "complete"`).catch(() => false), label + " document");
    const control = (name, args) => handleToolCall(name, args, async (route, init) => {
      const [status, body] = await evaluate(`(async () => { const r = await fetch(${JSON.stringify(route)}, { ...${JSON.stringify(init ?? {})}, headers: { "content-type": "application/json" } }); return [r.status, await r.json()]; })()`);
      assert.ok(status < 400, `${route}: ${status} ${JSON.stringify(body)}`);
      return body;
    });
    async function menu(selector) {
      await evaluate('document.querySelector("[data-mausbot-welcome-later]")?.click()', true);
      await until(() => evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`), selector);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`, true);
      await until(() => evaluate('Boolean(document.querySelector("[data-open-window]"))'), "Open in new window");
      await evaluate('document.querySelector("[data-open-window]").click()', true);
    }
    return { ...page, evaluate, control, menu, close: () => cdp.send("Target.closeTarget", { targetId: page.targetId }) };
  }
  const rail = await attach(p => p.url.endsWith("/rail"), "workspace rail");
  const origin = new URL(rail.url).origin;
  const main = await attach(p => p.url === origin + "/", "main workspace");
  await rail.menu('[data-rail-place="profile:personal"]');
  const other = await attach(p => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url) && new URL(p.url).origin !== origin, "Personal workspace");
  const [work, homeBot] = await Promise.all([main.control("create_bot", { name: "Studio Echo" }), other.control("create_bot", { name: "Personal Echo" })].map(p => p.then(r => r.bot)));
  const { task } = await main.control("create_task", { target_type: "bot", target_id: work.id, title: "Studio sketches" });
  const send = (page, bot, text) => page.control("send_bot_message", { bot_id: bot.id, task_id: bot.activeTaskId, text });
  await Promise.all([send(main, work, "Studio fixture note"), send(other, homeBot, "Personal fixture note")]);
  for (const [page, bot, elsewhere] of [[main, work, homeBot], [other, homeBot, work]]) {
    const rows = await until(async () => {
      const bots = await page.evaluate('fetch("/api/bots?messages=0").then(r => r.json()).then(r => r.bots)');
      return bots.find(b => b.id === bot.id)?.tasks.some(t => t.threadId === bot.activeTaskId && t.busy) && bots;
    }, `${bot.name} running`);
    assert.ok(!rows.some(b => b.id === elsewhere.id));
  }
  writeFileSync(finish, "");
  const messages = (page, bot, id) => page.control("get_bot_messages", { bot_id: bot.id, task_id: id });
  for (const [page, bot, prompt] of [[main, work, "Studio fixture note"], [other, homeBot, "Personal fixture note"]]) {
    await until(async () => (await messages(page, bot, bot.activeTaskId)).messages.some(m => m.role === "bot" && m.text?.includes(prompt)), `${bot.name} reply`);
  }
  console.log("Both local workspaces ran a bot concurrently and retained separate conversations.");
  await main.menu(`[data-sidebar-bot-row="${work.id}"]`);
  const isChat = thread => p => new URL(p.url).searchParams.get("chatWindow") === thread;
  const first = await attach(isChat(work.activeTaskId), "first chat window");
  await main.evaluate('localStorage.setItem("omb-advanced-mode","1"); location.reload()');
  const selectBot = `document.querySelector('[data-sidebar-bot-row="${work.id}"]')`;
  await until(() => main.evaluate(`Boolean(${selectBot})`), "advanced sidebar");
  await until(() => main.evaluate(`Boolean(${selectBot}?.parentElement.querySelector("button[aria-expanded]"))`), "thread disclosure");
  await main.evaluate(`${selectBot}.parentElement.querySelector('button[aria-expanded="false"]')?.click()`, true);
  await main.menu(`[data-sidebar-thread-row="${task.taskId}"]`);
  const second = await attach(isChat(task.taskId), "second chat window");
  async function compose(page, text) {
    await until(() => page.evaluate('Boolean(document.querySelector("[data-chat-window] textarea:not([disabled])"))'), "pinned chat composer");
    await page.evaluate(`(() => { const el = document.querySelector("[data-chat-window] textarea"); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,${JSON.stringify(text)}); el.dispatchEvent(new Event("input",{bubbles:true})); })()`);
    await page.evaluate('document.querySelector("[data-chat-window] textarea").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",code:"Enter",bubbles:true,cancelable:true}))', true);
  }
  await Promise.all([compose(first, "Amber window reply"), compose(second, "Indigo window reply")]);
  for (const [page, thread, ours, sibling, reply] of [[first, work.activeTaskId, "Amber window reply", "Indigo window reply", "Amber received."], [second, task.taskId, "Indigo window reply", "Amber window reply", "Indigo received."]]) {
    const history = await until(async () => {
      const { messages: rows } = await messages(page, work, thread);
      return rows.some(m => m.role === "bot" && m.text === reply) && rows;
    }, `a reply to ${ours}`);
    assert.equal(history.filter(m => m.role === "user" && m.text === ours).length, 1);
    assert.ok(!history.some(m => m.role === "user" && m.text === sibling));
    await until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(reply)})`), "visible transcript");
    assert.ok(!(await page.evaluate("document.body.innerText")).includes(sibling));
  }
  assert.equal(await main.evaluate(`window.ogb.workspaces.openThread(${JSON.stringify(work.id)},${JSON.stringify(task.taskId)})`, true), true);
  assert.equal((await pages()).filter(isChat(task.taskId)).length, 1);
  await other.menu(`[data-sidebar-bot-row="${homeBot.id}"]`);
  const personalChat = await attach(isChat(homeBot.activeTaskId), "chat belonging to Personal");
  assert.equal(new URL(personalChat.url).origin, new URL(other.url).origin);
  await other.close();
  await until(() => personalChat.evaluate('document.body.innerText.includes("Personal fixture note")'), "Personal chat after workspace window closed");
  await personalChat.close();
  await until(() => !existsSync(join(personal, "openmausbot-server.lease")), "last Personal window to release its server");
  await first.close();
  assert.ok((await second.evaluate("document.body.innerText")).includes("Indigo window reply"));
  await rail.menu('[data-rail-place="profile:personal"]');
  const reopened = await attach(p => p.url.endsWith("/") && new URL(p.url).origin !== origin, "reopened Personal");
  assert.ok((await messages(reopened, homeBot, homeBot.activeTaskId)).messages.some(m => m.text?.includes("Personal fixture note")));
  console.log("Two chats of one bot sent and received independently. Reopening reused a window, and closing and reopening Personal preserved its history.");
} finally {
  cdp?.close();
  app.kill("SIGTERM");
  const timer = setTimeout(() => app.kill("SIGKILL"), 15_000);
  try { await ended; } finally { clearTimeout(timer); rmSync(fixture, { recursive: true, force: true }); }
}
