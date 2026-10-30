import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

(enabled ? it : it.skip)("opens and answers a teammate question from the Simple sidebar after a composer mention", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "omb-direct-ui-plan-"));
  const planPath = join(temporary, "plan.json");
  writeFileSync(planPath, "{}");
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch"], {
    cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_ROOM_PLAN: planPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  child.on("error", caught => { error += caught.message; });
  let info: { ui: string; url: string; botId: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(error);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(info.url + path, body === undefined ? {} : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const click = async (name: string, role = "button") => {
      const refs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
      const match = Object.entries(refs).find(([, entry]) => entry.role === role && entry.name.endsWith(name));
      expect(match, JSON.stringify(refs)).toBeDefined();
      return ui("click", "--ref", "@" + match![0]);
    };
    await ui("eval", "--js", "localStorage.setItem('omb-advanced-mode', '0'); window.dispatchEvent(new StorageEvent('storage', { key: 'omb-advanced-mode' })); true");
    const ledger = (await api("/api/bots", { name: "Ledger" })).bot;
    writeFileSync(planPath, JSON.stringify({
      [info.botId]: { steps: [{ arguments: { bot_ids: [ledger.id], message: "Check the footer" } }], reply: "Assigned", resumeReply: "Ledger checked the footer" },
      [ledger.id]: { script: [{ key: "greeting", match: ["Hello Ledger."], reply: "Hello from Ledger" }, { key: "ask", match: ["Check the footer"], steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which footer should I use?", choices: ["Short footer", "Long footer"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "I used {{answer}}" }] },
    }));
    await runControlOmb(["send", "--bot", ledger.id, "--text", "Hello Ledger."], { env: { OPENMAUSBOT_URL: info.url } });
    await runControlOmb(["wait", "--bot", ledger.id, "--timeout", "30"], { env: { OPENMAUSBOT_URL: info.url } });
    await ui("type", "--name", "Message Pepper", "--text", "@Ledger Please check the footer.");
    await ui("press", "--keys", "Enter");
    const waitingBot = async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === ledger.id);
    await expect.poll(async () => (await waitingBot()).tasks.some((task: any) => task.activity === "waiting-on-you"), { timeout: 30_000 }).toBe(true);
    const waiting = await waitingBot();
    const work = waiting.tasks.find((task: any) => task.activity === "waiting-on-you").threadId;
    expect(waiting.mainThreadId).toBe(ledger.threadId);
    expect(work).not.toBe(waiting.mainThreadId);
    await ui("eval", "--js", "localStorage.setItem('omb-advanced-mode', '1'); window.dispatchEvent(new StorageEvent('storage', { key: 'omb-advanced-mode' })); true");
    await ui("eval", "--js", `document.querySelector('[data-sidebar-activity-row="${work}"]').click(); true`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Which footer should I use?");
    const advanced = await snapshot();
    await ui("eval", "--js", `document.querySelector('[data-sidebar-bot-row="${info.botId}"]').click(); true`);
    await ui("eval", "--js", "localStorage.setItem('omb-advanced-mode', '0'); window.dispatchEvent(new StorageEvent('storage', { key: 'omb-advanced-mode' })); true");
    await ui("eval", "--js", `document.querySelector('[data-sidebar-bot-row="${ledger.id}"]').click(); true`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Which footer should I use?");
    await click("Short footer", "radio");
    await expect.poll(snapshot, { timeout: 30_000 }).toContain("I used Short footer");
    const messages = (await api(`/api/threads/${work}/messages`)).messages;
    expect(messages.find((message: any) => message.card?.requestType === "question").card).toMatchObject({ answered: "answer", answeredText: "Short footer" });
    writeFileSync(info.logPath + ".simple-question.json", JSON.stringify({ sourceMention: "@Ledger Please check the footer.", waiting, work, advanced, messages, final: await snapshot() }, null, 2));
    console.log("Simple question UI evidence:", info.logPath + ".simple-question.json");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temporary);
  }
}, 240_000);
