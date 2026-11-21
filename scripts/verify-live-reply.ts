#!/usr/bin/env -S node --experimental-strip-types
// Streams every scripted reply case through the real renderer in an isolated fixture, once per engine, and checks each
// frame: no message's words twice, none glued to another message, none vanishing once shown, no thinking shown as reply
// text, no streamed row left once the turn ends, the transcript's words equal to the saved messages, and no console
// errors. Prints a pass/fail table and writes it, with each case's evidence, to --out.
//
//   node --experimental-strip-types scripts/verify-live-reply.ts [--engines claude,codex,acp,cline,copilot]
//     [--cases short,long,...] [--skip-room] [--out DIR] [--cadence 4:30]
//
// Needs the pinned test browser (OMB_AGENT_BROWSER_PATH / AGENT_BROWSER_EXECUTABLE_PATH, as control-omb ui launch).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { caseTokens, LIVE_REPLY_CASES, liveReplyScripts, type LiveReplyCase } from "../server/testing/live-reply-cases.ts";
import { runControlOmbUi } from "./testing/control-omb-ui.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The instance each engine's fixture adds, and the model Pepper is moved to. */
const ENGINES: Record<string, { flag?: string; instanceId: string; model: string }> = {
  claude: { instanceId: "claude", model: "claude-sonnet-5" },
  codex: { flag: "codex", instanceId: "codex", model: "gpt-fake-default" },
  acp: { flag: "acp", instanceId: "myAgent", model: "fixture-fast" },
  cline: { flag: "cline", instanceId: "cline", model: "cline-default" },
  copilot: { flag: "copilot", instanceId: "githubCopilot", model: "claude-haiku-4.5" },
  // A real OpenCode at OMB_VERIFY_OPENCODE_CLI, on a free model it offers with no key: real prompts, not scripts.
  opencode: { flag: "opencode", instanceId: "opencode", model: "" },
};
/** Prompts for a real engine: each asks for its own token, so the checks can find the reply's words. */
const REAL_CASES: Array<LiveReplyCase & { prompt: string; tokens: string[] }> = [
  { name: "real-short", marker: "", steps: [], prompt: "Reply with one short sentence that begins with the word R1M1.", tokens: ["R1M1"] },
  { name: "real-markdown", marker: "", steps: [], prompt: "Begin your reply with the word R2M1, then give a markdown heading, a bulleted list of three fruits and a two-row table of their colours.", tokens: ["R2M1"] },
  { name: "real-code", marker: "", steps: [], prompt: "Begin your reply with the word R3M1, then show a three-line Python code block that prints hello, then one closing sentence.", tokens: ["R3M1"] },
  { name: "real-long", marker: "", steps: [], prompt: "Begin your reply with the word R4M1, then write four short paragraphs about why tea is popular. Do not use any tools.", tokens: ["R4M1"] },
];
const STEERS = new Set(["claude"]);

interface Handle { ui: string; url: string; botId: string }
interface Verdict { engine: string; name: string; ok: boolean; problems: string[] }

const { values } = parseArgs({ options: {
  engines: { type: "string", default: Object.keys(ENGINES).join(",") },
  cases: { type: "string" },
  "skip-room": { type: "boolean", default: false },
  out: { type: "string" },
  cadence: { type: "string", default: "4:30" },
} });
const out = values.out ?? mkdtempSync(join(tmpdir(), "omb-live-reply-verify-"));
mkdirSync(out, { recursive: true });
const scripts = join(out, "scripts.json");
writeFileSync(scripts, JSON.stringify(liveReplyScripts()));
const wanted = values.cases?.split(",") ?? null;
const cases = LIVE_REPLY_CASES.filter((entry) => !wanted || wanted.includes(entry.name));

/** How often a token appears: `T2M1` is not counted inside `T2M1z` (a row's time can follow a token directly). */
const occurrences = (text: string, token: string) => (text.match(new RegExp(`${token}(?!z)`, "g")) ?? []).length;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ui = (handle: Handle, ...args: string[]) => runControlOmbUi([args[0]!, "--ui", handle.ui, ...args.slice(1)]) as Promise<any>;
const evaluate = async (handle: Handle, js: string): Promise<any> => {
  const result = await ui(handle, "eval", "--js", js);
  return result.result ?? result.data?.result;
};
const api = async (handle: Handle, method: string, path: string, body?: unknown): Promise<any> => {
  const response = await fetch(`${handle.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result;
};

/** Starts a fixture and resolves with its handle once it has printed it. */
function launch(engine: string): Promise<{ child: ChildProcess; handle: Handle }> {
  const flag = ENGINES[engine]!.flag;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "control-omb.ts"), "ui", "launch", ...(flag ? ["--engine", flag] : [])], {
    cwd: ROOT, env: { ...process.env, FAKE_STREAM_SCRIPT: scripts, FAKE_STREAM_CADENCE: values.cadence }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout!.on("data", (chunk) => {
      text += chunk;
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end < start) return;
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        resolve({ child, handle: { ui: parsed.ui, url: parsed.url, botId: parsed.botId } });
      } catch {}
    });
    child.once("exit", (code) => reject(new Error(`ui launch exited ${code}: ${text.slice(-500)}`)));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
}

/** Samples every animation frame: which tokens the open chat shows and how often, which ones each streamed row holds. */
const SAMPLER = (tokens: string[], chat: string) => `(() => {
  const tokens = ${JSON.stringify(tokens)};
  const frames = [];
  window.__liveReply = frames;
  const count = (text, token) => (text.match(new RegExp(token + '(?!z)', 'g')) || []).length;
  const sample = () => {
    const log = document.querySelector('[role="log"]');
    const label = log ? log.getAttribute('aria-label') || '' : '';
    // The person's own lines are left out: a steer quotes a token the reply then says.
    const bot = log ? log.cloneNode(true) : null;
    bot?.querySelectorAll('[data-message-row].items-end').forEach((row) => row.remove());
    const text = bot ? bot.textContent : '';
    const rows = [...document.querySelectorAll('[data-mid^="live:"]')].map((row) => tokens.filter((token) => count(row.textContent, token) > 0));
    frames.push({ chat: label.includes(${JSON.stringify(chat)}), counts: tokens.map((token) => count(text, token)), rows, think: /THINK\\d/.test(text) });
  };
  // A headless page with nothing moving may draw no frames; the checks take one more sample of the page as it is.
  window.__liveReplySample = sample;
  const tick = () => {
    sample();
    if (frames.length < 30000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'sampling';
})()`;

const CONSOLE_ERRORS = async (handle: Handle): Promise<number> => {
  const result = await ui(handle, "console");
  const entries = Object.values(result).find((value) => Array.isArray(value)) as Array<Record<string, unknown>> | undefined
    ?? Object.values(result.data ?? {}).find((value) => Array.isArray(value)) as Array<Record<string, unknown>> | undefined ?? [];
  return entries.filter((entry) => (entry.type ?? entry.level) === "error").length;
};

async function runCase(handle: Handle, engine: string, entry: LiveReplyCase & { prompt?: string; tokens?: string[] }, context: { threadId: string; otherBotRow: string; botRow: string; composer: string; chat: string }): Promise<Verdict> {
  const tokens = entry.tokens ?? caseTokens(entry);
  const problems: string[] = [];
  if (entry.action === "steer" && !STEERS.has(engine)) return { engine, name: entry.name, ok: true, problems: ["skipped: this engine does not steer in its fake"] };
  const errorsBefore = await CONSOLE_ERRORS(handle);
  const savedBefore = new Set(((await api(handle, "GET", `/api/threads/${context.threadId}/messages`)).messages as Array<{ id: string }>).map((message) => message.id));
  await evaluate(handle, SAMPLER([...tokens, ...(entry.action === "steer" ? ["T13STEER"] : [])], context.chat));
  await ui(handle, "type", "--name", context.composer, "--text", entry.prompt ?? `Please answer ${entry.marker}`);
  await ui(handle, "press", "--keys", "Enter");
  if (entry.action) {
    await pause(2_500);
    if (entry.action === "stop") await evaluate(handle, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Stop' || /^Stop\b/.test(x.getAttribute('aria-label') || '')); b?.click(); return Boolean(b); })()`);
    if (entry.action === "steer") {
      await ui(handle, "type", "--name", context.composer, "--text", "also mention T13STEER");
      await ui(handle, "press", "--keys", "Enter");
    }
    if (entry.action === "reconnect") await evaluate(handle, "window.dispatchEvent(new Event('omb:retry-live-events')); 'retried'");
    if (entry.action === "switch") {
      await evaluate(handle, `document.querySelector(${JSON.stringify(context.otherBotRow)})?.click(); 'away'`);
      await pause(1_500);
      await evaluate(handle, `document.querySelector(${JSON.stringify(context.botRow)})?.click(); 'back'`);
    }
  }
  const settled = await ui(handle, "wait-settle", "--timeout", "120").catch((error: unknown) => ({ ok: false, error: String(error) }));
  if (settled?.ok === false) problems.push(`did not settle: ${JSON.stringify(settled).slice(0, 200)}`);
  await pause(600);
  const frames: Array<{ chat: boolean; counts: number[]; rows: string[][]; think: boolean }> = (await evaluate(handle, "(window.__liveReplySample(), JSON.stringify(window.__liveReply))").then((raw: string) => JSON.parse(raw)));
  const all = [...tokens, ...(entry.action === "steer" ? ["T13STEER"] : [])];
  const saved = ((await api(handle, "GET", `/api/threads/${context.threadId}/messages`)).messages as Array<{ id: string; role: string; kind: string; text?: string }>)
    .filter((message) => !savedBefore.has(message.id) && message.role === "bot" && message.kind === "text");
  const savedText = saved.map((message) => message.text ?? "").join("\n");
  const inChat = frames.filter((frame) => frame.chat);
  // A token said again in a message saved again (an automatic retry) is not a double.
  const allowed = all.map((token) => Math.max(1, saved.filter((message) => occurrences(message.text ?? "", token) > 0).length));
  const doubled = inChat.filter((frame) => frame.counts.some((count, index) => count > allowed[index]!)).length;
  if (doubled) problems.push(`${doubled} frames show a message's words twice`);
  // Glued: one streamed row holding words the server saved as two messages.
  const owner = (token: string) => saved.findIndex((message) => occurrences(message.text ?? "", token) > 0);
  const glued = inChat.filter((frame) => frame.rows.some((row) => new Set(row.map(owner).filter((index) => index >= 0)).size > 1)).length;
  if (glued) problems.push(`${glued} frames glue two saved messages in one streamed row`);
  if (inChat.some((frame) => frame.think)) problems.push("thinking shown as reply text");
  all.forEach((token, index) => {
    const kept = occurrences(savedText, token) > 0;
    const first = inChat.findIndex((frame) => frame.counts[index]! > 0);
    if (first < 0) {
      if (kept) problems.push(`${token} saved but never shown`);
      return;
    }
    const gone = inChat.slice(first).filter((frame) => frame.counts[index] === 0).length;
    if (gone && kept) problems.push(`${token} vanished in ${gone} frames`);
  });
  const last = inChat.at(-1);
  if (!last) problems.push("no frame of the chat was sampled");
  else {
    if (last.rows.length) problems.push(`${last.rows.length} streamed rows left after the turn`);
    all.forEach((token, index) => {
      const want = occurrences(savedText, token);
      if (last.counts[index] !== want) problems.push(`${token}: the transcript shows ${last.counts[index]}, the saved messages ${want}`);
    });
  }
  if (!entry.action && !["error"].includes(entry.name)) for (const token of tokens) if (!occurrences(savedText, token) > 0) problems.push(`${token} not saved`);
  const errors = (await CONSOLE_ERRORS(handle)) - errorsBefore;
  if (errors > 0) problems.push(`${errors} console errors`);
  const streamedFrames = inChat.filter((frame) => frame.rows.length > 0).length;
  writeFileSync(join(out, `${engine}-${entry.name}.json`), JSON.stringify({ problems, frames: frames.length, streamedFrames, lastFrame: inChat.at(-1), tokens: all, saved }, null, 2));
  await ui(handle, "screenshot", "--out", join(out, `${engine}-${entry.name}.png`)).catch(() => {});
  return { engine, name: entry.name, ok: problems.length === 0, problems };
}

async function runRoom(handle: Handle, engine: string): Promise<Verdict> {
  const problems: string[] = [];
  const spec = ENGINES[engine]!;
  const basil = (await api(handle, "POST", "/api/bots", { name: "Basil", modelSelection: { instanceId: spec.instanceId, model: spec.model } })).bot;
  const room = (await api(handle, "POST", "/api/groups", { memberIds: [handle.botId, basil.id], name: "Launch room",
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: handle.botId } } })).group;
  const row = `[data-sidebar-group-row="${room.id}"]`;
  for (let tries = 0; tries < 40 && !(await evaluate(handle, `Boolean(document.querySelector('${row}'))`)); tries++) await pause(250);
  await evaluate(handle, `document.querySelector('${row}')?.click(); 'opened'`);
  for (let tries = 0; tries < 40 && !(await evaluate(handle, `Boolean(document.querySelector('textarea[aria-label="Message Launch room"]'))`)); tries++) await pause(250);
  const entry = LIVE_REPLY_CASES.find((candidate) => candidate.name === "two-messages")!;
  const tokens = caseTokens(entry);
  await evaluate(handle, SAMPLER(tokens, "Launch room"));
  const errorsBefore = await CONSOLE_ERRORS(handle);
  for (const name of ["Pepper", "Basil"]) {
    await ui(handle, "type", "--name", "Message Launch room", "--text", `@${name} please answer ${entry.marker}`);
    await ui(handle, "press", "--keys", "Enter");
    await ui(handle, "wait-settle", "--timeout", "120").catch((error: unknown) => problems.push(`did not settle: ${String(error).slice(0, 120)}`));
  }
  await pause(600);
  const frames: Array<{ chat: boolean; counts: number[]; rows: string[][] }> = JSON.parse(await evaluate(handle, "(window.__liveReplySample(), JSON.stringify(window.__liveReply))"));
  const saved = ((await api(handle, "GET", `/api/threads/${room.threadId}/messages`)).messages as Array<{ role: string; kind: string; text?: string; from?: { name: string } }>)
    .filter((message) => message.role === "bot" && message.kind === "text" && tokens.some((token) => occurrences(message.text ?? "", token) > 0));
  const speakers = new Set(saved.map((message) => message.from?.name));
  if (speakers.size < 2) problems.push(`only ${[...speakers].join(", ") || "nobody"} replied`);
  const inChat = frames.filter((frame) => frame.chat);
  const most = tokens.map((_, index) => Math.max(...inChat.map((frame) => frame.counts[index]!)));
  tokens.forEach((token, index) => {
    const want = saved.filter((message) => occurrences(message.text ?? "", token) > 0).length;
    if (most[index]! > want) problems.push(`${token} shown ${most[index]} times, saved ${want}`);
  });
  const owner = (token: string) => saved.findIndex((message) => occurrences(message.text ?? "", token) > 0);
  if (inChat.some((frame) => frame.rows.some((row) => new Set(row.map(owner).filter((index) => index >= 0)).size > 1))) problems.push("two saved messages glued in one streamed row");
  if (inChat.at(-1)?.rows.length) problems.push("streamed rows left after the turns");
  const errors = (await CONSOLE_ERRORS(handle)) - errorsBefore;
  if (errors > 0) problems.push(`${errors} console errors`);
  await ui(handle, "screenshot", "--out", join(out, `${engine}-room.png`)).catch(() => {});
  return { engine, name: "room, two bots", ok: problems.length === 0, problems };
}

const verdicts: Verdict[] = [];
for (const engine of values.engines!.split(",")) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`unknown engine ${engine}`);
  const { child, handle } = await launch(engine);
  try {
    let model = spec.model;
    if (engine === "opencode") {
      const instances = (await api(handle, "GET", "/api/instances")).instances as Array<{ instanceId: string; models?: { options?: Array<{ id: string }> } }>;
      const offered = instances.find((instance) => instance.instanceId === spec.instanceId)?.models?.options?.map((option) => option.id) ?? [];
      model = offered.find((id) => /(^|[-_/])free$/i.test(id)) ?? "";
      process.stderr.write(`opencode offers ${offered.length} models; free: ${model || "none"}\n`);
      if (!model) {
        verdicts.push({ engine, name: "real OpenCode", ok: true, problems: ["skipped: no free model offered without a sign-in"] });
        continue;
      }
    }
    await api(handle, "PATCH", `/api/bots/${handle.botId}`, { modelSelection: { instanceId: spec.instanceId, model } });
    const bots = (await api(handle, "GET", "/api/bots")).bots as Array<{ id: string; name: string; threadId: string }>;
    const pepper = bots.find((bot) => bot.id === handle.botId)!;
    const other = bots.find((bot) => bot.id !== handle.botId)!;
    await evaluate(handle, "localStorage.setItem('omb-advanced-mode', 'true'); location.reload(); 'reloaded'");
    await pause(4_000);
    await ui(handle, "flag", "--set", "features.showToolCalls=true");
    const before = await CONSOLE_ERRORS(handle);
    await evaluate(handle, "console.error('verify-live-reply console probe'); 'probed'");
    if ((await CONSOLE_ERRORS(handle)) !== before + 1) throw new Error("the console check cannot see console errors");
    const context = { threadId: pepper.threadId, chat: "Pepper", composer: "Message Pepper",
      botRow: `[data-sidebar-bot-row="${pepper.id}"]`, otherBotRow: `[data-sidebar-bot-row="${other.id}"]` };
    for (const entry of engine === "opencode" ? REAL_CASES : cases) {
      const verdict = await runCase(handle, engine, entry, context).catch((error: unknown) => ({ engine, name: entry.name, ok: false, problems: [String(error).slice(0, 300)] }));
      verdicts.push(verdict);
      process.stderr.write(`${verdict.ok ? "pass" : "FAIL"} ${engine} ${entry.name} ${verdict.problems.join("; ")}\n`);
    }
    if (!values["skip-room"] && engine !== "opencode") {
      const verdict = await runRoom(handle, engine).catch((error: unknown) => ({ engine, name: "room, two bots", ok: false, problems: [String(error).slice(0, 300)] }));
      verdicts.push(verdict);
      process.stderr.write(`${verdict.ok ? "pass" : "FAIL"} ${engine} room ${verdict.problems.join("; ")}\n`);
    }
  } finally {
    await stop(child);
  }
}

const names = [...new Set(verdicts.map((verdict) => verdict.name))];
const engines = [...new Set(verdicts.map((verdict) => verdict.engine))];
const table = [
  `| Case | ${engines.join(" | ")} |`,
  `| --- | ${engines.map(() => "---").join(" | ")} |`,
  ...names.map((name) => `| ${name} | ${engines.map((engine) => {
    const verdict = verdicts.find((candidate) => candidate.engine === engine && candidate.name === name);
    return !verdict ? "" : verdict.ok ? (verdict.problems[0]?.startsWith("skipped") ? "skip" : "pass") : `FAIL: ${verdict.problems.join("; ").replaceAll("|", "/")}`;
  }).join(" | ")} |`),
].join("\n");
writeFileSync(join(out, "results.md"), `${table}\n`);
process.stdout.write(`${table}\n\nevidence: ${out}\n`);
process.exitCode = verdicts.every((verdict) => verdict.ok) ? 0 : 1;
