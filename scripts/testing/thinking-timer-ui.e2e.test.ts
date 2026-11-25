// The Thinking readout counts from the server's turn-start stamp (for a group,
// its speaker's claim), not from when the conversation was last selected.
// Needs the pinned agent-browser binary: runs when one resolves (tools
// directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the
// verified download; otherwise skipped.
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

function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    // Own process group: a timeout must also take down whatever it is running.
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
      // A tool printing on stdout before the handle still parses from the
      // first line that starts the object.
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {
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

/** A bot's conversations are listed in its panel, which the chat header's pill opens; click it only while closed. */
async function openConversations(handle: string, name: string): Promise<void> {
  await waitUntil(async () => (await ui("eval", handle, "--js", `(() => {
    if (document.querySelector('[data-panel-card="conversations"] [data-sidebar-thread-row]')) return true;
    document.querySelector('[data-chathead-pill][aria-expanded="false"]')?.click();
    return false;
  })()`)).result, 10_000, `${name}'s conversations to show`);
}

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
    // Simple mode's working line says how long in its tooltip, worked out each time the line draws.
    const timerText = () => evaluate(`(() => {
      const title = document.querySelector('.turn-presence [title]')?.getAttribute('title');
      return title?.split(' · ').find(part => /^(?:\\d+m )?\\d+s$/.test(part)) ?? null;
    })()`);
    const selectThread = (threadId: string) => evaluate(`document.querySelector('[data-sidebar-thread-row="${threadId}"]')?.click(); true`);
    const isCurrent = (threadId: string) => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${threadId}"][aria-current="page"]'))`);
    const taskOf = async (threadId: string) =>
      (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).tasks.find((task: any) => task.threadId === threadId);

    // The second conversation comes through the same POST the panel's "New conversation" uses.
    const busyThread = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).threadId;
    const otherThread = (await api("POST", `/api/bots/${info.botId}/tasks`, {})).task.threadId;
    await openConversations(info.ui, "Pepper");
    await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${otherThread}"]'))`), 10_000, "the new thread's row to appear");
    // Creating a thread selects it on the server. Pin the original thread in
    // the renderer before sending the turn whose stamp this case observes.
    await selectThread(busyThread);
    await waitUntil(() => isCurrent(busyThread), 10_000, "the original thread to become current");

    await ui("type", info.ui, "--name", "Message Pepper", "--text", "hello");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const task = await taskOf(busyThread);
      return task && task.busy && typeof task.turnStartedAt === "number" ? task : null;
    }, 60_000, "the task to go busy with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await waitUntil(timerText, 15_000, "the thinking readout to appear");
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));

    await selectThread(otherThread);
    await waitUntil(() => isCurrent(otherThread), 10_000, "the other thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectThread(busyThread);
    await waitUntil(() => isCurrent(busyThread), 10_000, "the busy thread to become current again");

    // A restart would show single digits after a 13+ second turn.
    const resumed = await waitUntil(timerText, 10_000, "the thinking readout to appear again");
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    expect(await taskOf(busyThread)).toMatchObject({ busy: true, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-anchored.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

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
    const botsState = () => api("GET", "/api/bots");
    const groupState = async () => (await botsState()).groups.find((row: any) => row.id === groupId);

    // With a single thread there is no thread list: the bot row is that
    // conversation, and the same holds for a one-thread room.
    const selectRow = (selector: string) => evaluate(`document.querySelector('${selector}')?.click(); true`);
    const isCurrentRow = (selector: string) => evaluate(`Boolean(document.querySelector('${selector}[aria-current="page"]'))`);
    const soloRow = `[data-sidebar-bot-row="${info.botId}"]`;
    // Setup completed at creation, so the composer is live at once and plain
    // messages route to Pepper on the same hang-mode fake.
    const group = (await api("POST", "/api/groups", {
      memberIds: [info.botId],
      name: "Timer group",
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const groupId = group.id;

    const groupRow = `[data-sidebar-group-row="${groupId}"]`;
    await waitUntil(() => evaluate(`Boolean(document.querySelector('${groupRow}'))`), 10_000, "the group's sidebar row to appear");
    await selectRow(groupRow);
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current");

    await ui("type", info.ui, "--name", "Message Timer group", "--text", "hello group");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const claimed = await groupState();
      return claimed && claimed.busyBotId === info.botId && typeof claimed.turnStartedAt === "number" ? claimed : null;
    }, 60_000, "the group to claim Pepper with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await waitUntil(timerText, 15_000, "the group's thinking readout to appear");
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));
    const beforeSwitch = await timerText();
    expect(elapsedSeconds(beforeSwitch)).toBeGreaterThanOrEqual(Math.floor((Date.now() - stamp) / 1000) - 2);

    await selectRow(soloRow);
    await waitUntil(() => isCurrentRow(soloRow), 10_000, "the 1:1 thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectRow(groupRow);
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current again");

    // A restart would show single digits after a 13+ second turn.
    const resumed = await waitUntil(timerText, 10_000, "the group's thinking readout to appear again");
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    expect(await groupState()).toMatchObject({ busyBotId: info.botId, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-group.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
