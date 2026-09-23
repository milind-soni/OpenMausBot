// The Thinking elapsed readout must count from the server's turn-start stamp,
// not from when the conversation was last selected. This is the recipe for
// docs/verification/chat-ui.md's harness, run by a machine against the real
// renderer: a hang-mode fake engine holds a turn in flight, a second thread is
// created through the same POST the sidebar's "New thread" uses, and the
// readout is read from the DOM before the switch and again after switching
// away and back — the pre-fix behaviour restarted it at 0s on every
// re-selection, hiding how long the turn had really been running.
//
// A group gets the same treatment with its own stamp: groups never showed
// the readout at all, so a one-member group is created through the same
// POST the sidebar's group creation dispatches, its speaker's claim is
// stamped on the group, and the readout must appear counting from that
// claim and resume after switching to a 1:1 thread and back.
//
// Needs the pinned agent-browser binary. It runs when one resolves (the tools
// directory, OMB_AGENT_BROWSER_PATH or PATH) or when OMB_UI_E2E=1 asks for the
// verified download; otherwise it is skipped with a printed reason.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-omb.ts");
const forced = process.env.OMB_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) {
  console.log(`skipping thinking-timer ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
// A cold run downloads the binary and Chrome; a warm one launches in seconds.
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

// OMB_UI_EVIDENCE_DIR keeps the screenshot (CI uploads it); otherwise it is temporary.
const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
const ownsEvidenceDir = !process.env.OMB_UI_EVIDENCE_DIR;

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
  stderr: () => string;
}

/** Start `ui launch` as a real foreground process and wait for its handle. */
function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    // Own process group: a timeout must take the launch AND whatever it is
    // running (an `agent-browser install` mid-download) down with it.
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch", ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup("SIGINT");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
      fail(new Error(`ui launch printed no handle within ${LAUNCH_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
      if (settled) return;
      // The handle is the pretty-printed object at the start of a line; any
      // earlier line would be a tool printing on stdout, which the launch
      // is meant to prevent, so a parse from there still recovers.
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {
        // the pretty-printed handle is still arriving
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      fail(new Error(`ui launch exited ${code} before printing a handle\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

/** "42s" / "1m 05s" → seconds, so the readout can be compared to the stamp. */
function elapsedSeconds(text: string): number {
  const minutes = /^(\d+)m (\d{2})s$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const seconds = /^(\d+)s$/.exec(text);
  if (seconds) return Number(seconds[1]);
  return -1;
}

/** Selection can already expand a thread list. Click only its collapsed DOM
 * chevron, avoiding both accidental collapse and transient duplicate AX names. */
async function expandThreads(handle: string, name: string): Promise<void> {
  const collapsed = JSON.stringify(`button[aria-label="Expand ${name} threads"]`);
  const expanded = JSON.stringify(`button[aria-label="Collapse ${name} threads"]`);
  await waitUntil(async () => (await ui("eval", handle, "--js", `(() => {
    if (document.querySelector(${expanded})) return true;
    document.querySelector(${collapsed})?.click();
    return false;
  })()`)).result, 10_000, `${name}'s thread list to expand`);
}

/** Poll a probe until it returns a truthy value; fail with the last result. */
async function waitUntil<T>(probe: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

describe("the thinking timer stays anchored across a thread switch", () => {
  let launched: Launched | undefined;

  afterEach(async () => {
    const current = launched;
    launched = undefined;
    if (!current) return;
    try {
      if (current.child.exitCode === null && current.child.signalCode === null) {
        const api = fixtureApi(current.info.url);
        const state = await api("GET", "/api/bots").catch(error => ({ error: String(error) }));
        const snapshot = await ui("snapshot", current.info.ui).catch(error => ({ error: String(error) }));
        writeFileSync(`${current.info.logPath}.thinking-timer.json`, JSON.stringify({ info: current.info, state, snapshot }, null, 2), { mode: 0o600 });
        console.log("Thinking timer fixture evidence saved.");
      }
    } finally {
      await waitForExit(current.child, { signal: "SIGINT", graceMs: 30_000 });
      expect(existsSync(current.info.dataDir)).toBe(false);
    }
  });

  afterAll(async () => {
    if (ownsEvidenceDir) await removeTempDir(evidenceDir);
  });

  run("counts from the server's turn-start stamp, not from the re-selection", async () => {
    launched = await launch(["--mode", "hang"]); // the turn never settles; the bot stays busy
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const timerText = () => evaluate(`document.querySelector('.turn-presence .tabular-nums')?.textContent ?? null`);
    const selectThread = (threadId: string) => evaluate(`document.querySelector('[data-sidebar-thread-row="${threadId}"]')?.click(); true`);
    const isCurrent = (threadId: string) => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${threadId}"][aria-current="page"]'))`);
    const taskOf = async (threadId: string) =>
      (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).tasks.find((task: any) => task.threadId === threadId);

    // Two threads before the turn: the launcher's, plus one through the same
    // POST the sidebar's "New thread" menu item dispatches.
    const busyThread = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).threadId;
    const otherThread = (await api("POST", `/api/bots/${info.botId}/tasks`, {})).task.threadId;
    // Expand Pepper's thread list if selection has not already opened it.
    await expandThreads(info.ui, "Pepper");
    await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${otherThread}"]'))`), 10_000, "the new thread's sidebar row to appear");
    // Creating a thread selects it on the server. Pin the original thread in
    // the renderer before sending the turn whose stamp this case observes.
    await selectThread(busyThread);
    await waitUntil(() => isCurrent(busyThread), 10_000, "the original thread to become current");

    // The composer sends; the hang-mode engine accepts the turn and holds it.
    await ui("type", info.ui, "--name", "Message Pepper", "--text", "hello");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    // The server stamps the turn's real start on the busy task.
    const busy = await waitUntil(async () => {
      const task = await taskOf(busyThread);
      return task && task.busy && typeof task.turnStartedAt === "number" ? task : null;
    }, 20_000, "the task to go busy with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    // The renderer shows the counting readout, and it counts from the stamp.
    const first = await waitUntil(timerText, 15_000, "the thinking readout to appear");
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));
    const beforeSwitch = await timerText();
    expect(elapsedSeconds(beforeSwitch)).toBeGreaterThanOrEqual(Math.floor((Date.now() - stamp) / 1000) - 2);

    // Switch to the other thread, dwell, and come back.
    await selectThread(otherThread);
    await waitUntil(() => isCurrent(otherThread), 10_000, "the other thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectThread(busyThread);
    await waitUntil(() => isCurrent(busyThread), 10_000, "the busy thread to become current again");

    // The readout resumes from the stamp — a restart would show single
    // digits after a 13+ second turn.
    const resumed = await waitUntil(timerText, 10_000, "the thinking readout to appear again");
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    // The stamp itself never moved.
    expect(await taskOf(busyThread)).toMatchObject({ busy: true, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-anchored.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    // Ctrl-C: browser, preview and fixture close; only the fixture's data goes.
    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);

  run("counts a group's turn from the speaking member's claim, resuming after a switch away", async () => {
    launched = await launch(["--mode", "hang"]); // the group's turn never settles either
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const timerText = () => evaluate(`document.querySelector('.turn-presence .tabular-nums')?.textContent ?? null`);
    const selectThread = (threadId: string) => evaluate(`document.querySelector('[data-sidebar-thread-row="${threadId}"]')?.click(); true`);
    const isCurrent = (threadId: string) => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${threadId}"][aria-current="page"]'))`);
    const botsState = () => api("GET", "/api/bots");
    const groupState = async () => (await botsState()).groups.find((row: any) => row.id === groupId);

    // Pepper's own 1:1 thread is the away destination.
    const soloThread = (await botsState()).bots.find((bot: any) => bot.id === info.botId).threadId;
    // A one-member group with setup completed at creation, so the composer is
    // live at once and plain messages route to Pepper, the default responder,
    // whose engine is the same hang-mode fake.
    const group = (await api("POST", "/api/groups", {
      memberIds: [info.botId],
      name: "Timer group",
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const groupId = group.id;

    // Ensure both lists are open, regardless of the current selection.
    await expandThreads(info.ui, "Pepper");
    await expandThreads(info.ui, "Timer group");
    await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${group.threadId}"]'))`), 10_000, "the group's sidebar thread row to appear");
    await selectThread(group.threadId);
    await waitUntil(() => isCurrent(group.threadId), 10_000, "the group to become current");

    // The group's composer sends; the hang-mode engine holds the member's turn.
    await ui("type", info.ui, "--name", "Message Timer group", "--text", "hello group");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    // The group claims its speaker and stamps the turn's real start.
    const busy = await waitUntil(async () => {
      const claimed = await groupState();
      return claimed && claimed.busyBotId === info.botId && typeof claimed.turnStartedAt === "number" ? claimed : null;
    }, 20_000, "the group to claim Pepper with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    // The group's readout appears and counts from the claim.
    const first = await waitUntil(timerText, 15_000, "the group's thinking readout to appear");
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));
    const beforeSwitch = await timerText();
    expect(elapsedSeconds(beforeSwitch)).toBeGreaterThanOrEqual(Math.floor((Date.now() - stamp) / 1000) - 2);

    // Switch to Pepper's 1:1 thread, dwell, and come back to the group.
    await selectThread(soloThread);
    await waitUntil(() => isCurrent(soloThread), 10_000, "the 1:1 thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectThread(group.threadId);
    await waitUntil(() => isCurrent(group.threadId), 10_000, "the group to become current again");

    // The readout resumes from the claim — a restart would show single
    // digits after a 13+ second turn.
    const resumed = await waitUntil(timerText, 10_000, "the group's thinking readout to appear again");
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    // The claim and the stamp never moved.
    expect(await groupState()).toMatchObject({ busyBotId: info.botId, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-group.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    // Ctrl-C: browser, preview and fixture close; only the fixture's data goes.
    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
