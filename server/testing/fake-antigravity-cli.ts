#!/usr/bin/env node
// Offline stand-in for Google's native Antigravity CLI (1.5.x), as measured against 1.5.14, started as `antigravity acp
// --gemini-dir <dir> --app-data-dir antigravity-acp [--login]`, or `--version`. Its sign-in is the file
// <gemini-dir>/antigravity-acp/antigravity-oauth-token, which stands for the OS keyring.
//   - ACP over stdio: `initialize` names "Antigravity ACP Server" and offers `logout` and `session/close`; `authenticate`
//     always fails; `session/new` answers -32000 "Authentication required" until signed in, then offers a mode and the
//     models (one is specific to the account); `session/prompt` streams one reply; `logout` forgets the sign-in.
//   - `acp --login`: prints the sign-in link and the paste prompt on stdout, reads one line from stdin, and exits 0 after
//     writing the sign-in when the line is (or its `code` is) the accepted code, 1 otherwise. It opens no browser.
// Env knobs (all optional):
//   FAKE_AGY_LOG            file each request and login event is appended to, as JSON lines
//   FAKE_AGY_VERSION        what `--version` and initialize say (default 1.5.14)
//   FAKE_AGY_ACCEPT         the authorization code `--login` accepts (default fixture-code)
//   FAKE_AGY_ACCOUNT_MODEL  the model id only a signed-in account is offered (default fixture-account-model)
//   FAKE_AGY_LOGIN          no-link | hold | stay | bad-domain | bad-redirect | state-less: how `--login` misbehaves
//   FAKE_AGY_LOGOUT         refuse | ignore: `logout` fails, or answers and forgets nothing
//   FAKE_AGY_HANG           initialize | session-new: never answers that request; crash: exits on session/new
//   FAKE_AGY_LOGOUT_MS      how long `logout` takes before it answers
//   FAKE_AGY_KEYRING_SHARED with FAKE_AGY_KEYRING: one entry for every --gemini-dir, as the macOS keyring holds in 1.5.14
//   FAKE_AGY_SESSION_ERROR  a message session/new fails with as -32000, signed in or not
//   FAKE_AGY_KEYRING        a folder that stands for the OS keyring: the sign-in is kept there, one entry per --gemini-dir,
//                           and only `logout` removes it; ignored while SSH_CONNECTION is set, as the real CLI ignores the
//                           keyring then
//   FAKE_AGY_TOOL_BUDGET    bytes of tool definitions the model sees before the largest are dropped (default 60000)
//   FAKE_AGY_OPTIONS        JSON array of permission options to offer instead of 1.5.x's allow / deny
//   FAKE_AGY_EXIT_DELAY_MS  how long the process lingers after stdin closes or SIGTERM, as a slow exit
//   FAKE_AGY_SPELLING       dotted: tools are named mcp.<server>.<tool>, as a later release might
// MCP servers and tool calls follow fake-antigravity-mcp.ts. A prompt line `fake-agy: call <server>/<tool> <JSON args>`
// stands for the model calling that tool: a tool the model cannot see is answered with `NOTOOL`, any other asks
// permission as 1.5.14 does (tool_call, then session/request_permission with `allow` / `deny`), runs the tool once
// allowed and answers `RESULT`; a cancelled answer holds the turn until session/cancel, as 1.5.x does.
// `fake-agy: tools` answers the names the model sees.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { DEFAULT_TOOL_BUDGET, ServerNames, SessionTools, type AcpMcpServer } from "./fake-antigravity-mcp.ts";

const argv = process.argv.slice(2);
const version = process.env.FAKE_AGY_VERSION ?? "1.5.14";
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (argv.includes("--version")) {
  console.log(`antigravity ${version}`);
  process.exit(0);
}
if (argv[0] !== "acp") {
  console.error("fake antigravity: only `acp` and `--version` exist");
  process.exit(2);
}

const flag = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const geminiDir = resolve(flag("--gemini-dir") ?? ".");
const stateDir = join(geminiDir, flag("--app-data-dir") ?? "antigravity-acp");
// As 1.5.14 and 1.5.15 do: over SSH (SSH_CONNECTION set, as the app always starts it) the profile's file, never the keyring.
const credentialFile = process.env.FAKE_AGY_KEYRING && !process.env.SSH_CONNECTION
  ? join(process.env.FAKE_AGY_KEYRING, process.env.FAKE_AGY_KEYRING_SHARED ? "shared" : createHash("sha256").update(geminiDir).digest("hex"))
  : join(stateDir, "antigravity-oauth-token");
const accountModel = process.env.FAKE_AGY_ACCOUNT_MODEL ?? "fixture-account-model";
const signedIn = () => existsSync(credentialFile);

function signIn(): void {
  mkdirSync(join(credentialFile, ".."), { recursive: true });
  writeFileSync(credentialFile, `${JSON.stringify({ fixture: "offline, not a credential" })}\n`, { mode: 0o600 });
}

if (argv.includes("--login")) {
  const mode = process.env.FAKE_AGY_LOGIN ?? "";
  log({ event: "login-start" });
  if (mode === "no-link") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const host = mode === "bad-domain" ? "https://accounts.example.test" : "https://accounts.google.com";
  const redirect = encodeURIComponent(mode === "bad-redirect" ? "http://127.0.0.1:1/" : "https://antigravity.google/oauth-callback");
  const state = mode === "state-less" ? "" : "&state=fixture-state";
  process.stdout.write([
    "Open this link in a browser to log in with Google:",
    "",
    `  ${host}/o/oauth2/auth?client_id=fixture&redirect_uri=${redirect}&response_type=code&scope=openid${state}`,
    "Then paste the authorization code, or the full URL of the page you land on, and press Enter:",
    "",
  ].join("\n"));
  if (mode === "hold") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  const line = await new Promise<string>((done) => {
    const reader = createInterface({ input: process.stdin });
    reader.once("line", (text) => { done(text.trim()); reader.close(); });
    process.stdin.once("end", () => done(""));
  });
  let code = line;
  if (/^https?:\/\//u.test(line)) code = new URL(line).searchParams.get("code") ?? "";
  const accepted = code === (process.env.FAKE_AGY_ACCEPT ?? "fixture-code");
  log({ event: "login-code", accepted, asAddress: /^https?:\/\//u.test(line) });
  if (!accepted) {
    process.stderr.write("fake antigravity: the authorization code was not accepted\n");
    process.exit(1);
  }
  signIn();
  if (mode === "stay") {
    process.stdout.write("Signed in.\n");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}

const out = (message: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(message as object) })}\n`);
const result = (id: unknown, value: unknown) => out({ id, result: value });
const failure = (id: unknown, code: number, message: string) => out({ id, error: { code, message } });
let mode = "default";
let model = "fixture-base-model";
let sessions = 0;

const configOptions = () => [
  { id: "mode", name: "Mode", type: "select", currentValue: mode, options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  {
    id: "model", name: "Model", type: "select", currentValue: model,
    options: [{ value: "fixture-base-model", name: "Fixture base" }, { value: accountModel, name: "Fixture account model" }],
  },
];

log({ event: "started" });
const serverNames = new ServerNames();
const sessionTools = new Map<string, SessionTools>();
const sessionsDir = join(stateDir, "fake-sessions");
const budget = Number(process.env.FAKE_AGY_TOOL_BUDGET ?? DEFAULT_TOOL_BUDGET);
const clientAnswers = new Map<string, (message: { result?: unknown; error?: unknown }) => void>();
const cancels = new Map<string, () => void>();
/** Sessions whose session/cancel came before the turn began waiting for it. */
const cancelledEarly = new Set<string>();
let clientRequests = 0;
let toolCalls = 0;

type Params = { sessionId?: string; configId?: string; value?: string; cwd?: string; mcpServers?: AcpMcpServer[]; prompt?: Array<{ type?: string; text?: string }> };

function askClient(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const id = String(++clientRequests);
  return new Promise((resolveAnswer) => {
    clientAnswers.set(id, resolveAnswer);
    out({ id, method, params });
  });
}

async function mountTools(sessionId: string, params: Params): Promise<void> {
  sessionTools.get(sessionId)?.close();
  const mounted = await SessionTools.mount(params.mcpServers ?? [], { names: serverNames, cwd: params.cwd ?? process.cwd(), stateDir, budget, version });
  sessionTools.set(sessionId, mounted);
  log({ event: "tools", sessionId, transports: mounted.transports(), bytes: mounted.bytes(), visible: mounted.visible(), hidden: mounted.hidden() });
}

const update = (sessionId: string, value: Record<string, unknown>) => out({ method: "session/update", params: { sessionId, update: value } });
const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** Runs one `fake-agy: call` line; false when the turn was cancelled. */
async function callTool(sessionId: string, target: string, argsText: string): Promise<boolean> {
  const [serverName, toolName] = target.split("/");
  const found = sessionTools.get(sessionId)?.find(serverName ?? "", toolName ?? "");
  if (!found) {
    say(sessionId, `NOTOOL ${target}\n`);
    return true;
  }
  let args: Record<string, unknown> = {};
  try { args = argsText.trim() ? JSON.parse(argsText) as Record<string, unknown> : {}; } catch { args = {}; }
  const shown = { ...args, toolSummary: `Run ${toolName}` };
  const call = { toolCallId: `call_${process.pid}${++toolCalls}`, name: found.nativeName, args: shown, kind: "other", title: `Run ${found.nativeName}`, rawInput: shown };
  update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
  update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "pending" });
  const options = process.env.FAKE_AGY_OPTIONS ? JSON.parse(process.env.FAKE_AGY_OPTIONS) : [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  const answer = await askClient("session/request_permission", { sessionId, toolCall: { sessionUpdate: "tool_call", ...call, status: "pending" }, options });
  const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  log({ event: "permission", sessionId, tool: found.nativeName, outcome });
  if (outcome?.outcome !== "selected") {
    log({ event: "awaiting-cancel", sessionId });
    if (!cancelledEarly.delete(sessionId)) await new Promise<void>((resolveCancel) => cancels.set(sessionId, resolveCancel));
    return false;
  }
  const chosen = (options as Array<{ optionId: string; kind: string }>).find((option) => option.optionId === outcome.optionId);
  if (!chosen?.kind.startsWith("allow")) {
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "failed" });
    say(sessionId, `DENIED ${target}\n`);
    return true;
  }
  update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "in_progress" });
  const called = await found.connection.request("tools/call", { name: toolName, arguments: args, _meta: { "antigravity.google/conversation_id": sessionId } });
  log({ event: "tools/call", sessionId, server: found.connection.name, tool: toolName, pid: process.pid });
  const content = ((called.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? []);
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const failed = called.error !== undefined || (called.result as { isError?: unknown } | undefined)?.isError === true;
  update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text } }] });
  say(sessionId, `RESULT ${target}${failed ? " (error)" : ""}: ${text || JSON.stringify(called.error ?? null)}\n`);
  return true;
}

async function prompt(id: unknown, params: Params): Promise<void> {
  const sessionId = params.sessionId ?? "";
  const text = (params.prompt ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  const lines = [...text.matchAll(/^fake-agy:[ \t]*(\S+)[ \t]*(\S*)[ \t]*(.*)$/gmu)];
  if (lines.length === 0) {
    say(sessionId, "fixture reply");
    result(id, { stopReason: "end_turn" });
    return;
  }
  for (const [, verb, target, rest] of lines) {
    if (verb === "tools") say(sessionId, `TOOLS ${(sessionTools.get(sessionId)?.visible() ?? []).join(" ")}\n`);
    else if (verb === "call" && !(await callTool(sessionId, target ?? "", rest ?? ""))) {
      result(id, { stopReason: "cancelled" });
      return;
    }
  }
  result(id, { stopReason: "end_turn" });
}

function exitSoon(code: number): void {
  const delay = Number(process.env.FAKE_AGY_EXIT_DELAY_MS ?? 0);
  log({ event: "exiting", delayMs: delay });
  setTimeout(() => {
    for (const tools of sessionTools.values()) tools.close();
    log({ event: "exited" });
    process.exit(code);
  }, delay);
}
process.on("SIGTERM", () => exitSoon(0));

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message: { id?: unknown; method?: string; params?: Params; result?: unknown; error?: unknown };
  try { message = JSON.parse(line); } catch { return; }
  if (!message.method) {
    const answer = clientAnswers.get(String(message.id));
    clientAnswers.delete(String(message.id));
    answer?.(message);
    return;
  }
  log({ method: message.method, signedIn: signedIn() });
  switch (message.method) {
    case "initialize":
      if (process.env.FAKE_AGY_HANG === "initialize") return;
      result(message.id, {
        protocolVersion: 1,
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: { name: "Antigravity ACP Server", version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, close: {} },
          auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
      });
      break;
    case "authenticate":
      failure(message.id, -32603, "fake antigravity does not sign in through authenticate; use acp --login");
      break;
    case "logout":
      log({ event: "logout-start" });
      if (process.env.FAKE_AGY_LOGOUT_MS) await new Promise((resolveWait) => setTimeout(resolveWait, Number(process.env.FAKE_AGY_LOGOUT_MS)));
      if (process.env.FAKE_AGY_LOGOUT === "refuse") failure(message.id, -32603, "logout refused");
      else {
        if (process.env.FAKE_AGY_LOGOUT !== "ignore") rmSync(credentialFile, { force: true });
        result(message.id, {});
      }
      break;
    case "session/new": {
      if (process.env.FAKE_AGY_HANG === "session-new") return;
      if (process.env.FAKE_AGY_HANG === "crash") process.exit(3);
      if (process.env.FAKE_AGY_SESSION_ERROR) return failure(message.id, -32000, process.env.FAKE_AGY_SESSION_ERROR);
      if (!signedIn()) return failure(message.id, -32000, "Authentication required");
      sessions += 1;
      const sessionId = `fixture-session-${process.pid}-${sessions}`;
      try { await mountTools(sessionId, message.params ?? {}); } catch (error) { return failure(message.id, -32603, `MCP setup failed: ${String(error)}`); }
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, sessionId), "");
      result(message.id, { sessionId, configOptions: configOptions() });
      break;
    }
    case "session/resume":
    case "session/load": {
      const sessionId = message.params?.sessionId ?? "";
      if (!signedIn()) return failure(message.id, -32000, "Authentication required");
      if (!sessionId || !existsSync(join(sessionsDir, sessionId))) return failure(message.id, -32000, "Session not found");
      try { await mountTools(sessionId, message.params ?? {}); } catch (error) { return failure(message.id, -32603, `MCP setup failed: ${String(error)}`); }
      result(message.id, { configOptions: configOptions() });
      break;
    }
    case "session/cancel": {
      const cancelled = message.params?.sessionId ?? "";
      const waiting = cancels.get(cancelled);
      cancels.delete(cancelled);
      if (waiting) waiting();
      else cancelledEarly.add(cancelled);
      break;
    }
    case "session/set_config_option":
      if (message.params?.configId === "mode") mode = String(message.params.value);
      if (message.params?.configId === "model") model = String(message.params.value);
      result(message.id, { configOptions: configOptions() });
      break;
    case "session/prompt":
      void prompt(message.id, message.params ?? {});
      break;
    default:
      if (message.id !== undefined) result(message.id, {});
  }
}).on("close", () => exitSoon(0));
