// The MCP servers a Cloud of the person's own keeps for this computer: each started, or reached, exactly as that Cloud's
// job gives it, only as this computer's lending allows, and kept running between calls. Security: no other address is
// fetched and no other program started, a URL server is sent MCP messages only, and its keys are never written down
// here or put into an error.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { commandPath } from "./shell-path.mjs";

export const LENT_MCP_ACTIONS = new Set(["mcp_tools", "mcp_call"]);
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** A package runner fetches its program the first time it starts. */
const START_MS = 130_000;
const CALL_MS = 300_000;
const IDLE_MS = 10 * 60_000;
/** The server reads a result body of at most 4,000,000 bytes. */
const RESULT_LIMIT = 3_900_000;
const MAX_PAGES = 10;
const PROTOCOL = "2025-03-26";

/** What a lent server inherits from this app: where things live, never a key. */
const INHERITED = ["HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TEMP", "TMP", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "APPDATA", "LOCALAPPDATA", "ProgramData"];
export const inheritedEnvironment = (env = process.env) => Object.fromEntries(INHERITED.filter(key => env[key]).map(key => [key, env[key]]));

const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const secrets = (value, name) => record(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) => name.test(key) && typeof item === "string" && item.length <= 16_384);

/** The server a job names, in the shape the Cloud sends it; anything else is refused before it is looked at again. */
export function validLentMcpServer(server) {
  if (!record(server) || typeof server.name !== "string" || !NAME.test(server.name)) return false;
  const keys = Object.keys(server).sort().join();
  if (keys === "args,command,env,name") {
    return typeof server.command === "string" && server.command.trim().length > 0 && server.command.length <= 1024 &&
      Array.isArray(server.args) && server.args.length <= 64 && server.args.every(arg => typeof arg === "string" && arg.length <= 4096) && secrets(server.env, ENV_NAME);
  }
  return keys === "headers,name,type,url" && typeof server.url === "string" && server.url.length <= 2048 && (server.type === "http" || server.type === "sse") && secrets(server.headers, HEADER_NAME);
}

export function isLoopbackAddress(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && LOOPBACK.test(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch { return false; }
}

/** Why this computer won't run `server` for this grant, or null. A command server starts a program here, which only a
 * lent terminal allows; a URL server must be at this computer's own loopback address. */
export function lentMcpRefusal(grant, server) {
  if (!grant?.cloud) return "MCP servers run here only for the person's own Clouds";
  if ("command" in server) return grant.terminal === true ? null : "Running commands is not enabled for this server";
  if (!isLoopbackAddress(server.url)) return "Only an MCP server at this computer's own address (127.0.0.1, localhost or ::1) can be reached";
  if (server.type === "sse") return "This MCP server uses the older SSE transport, which lending doesn't carry yet";
  return null;
}

/** This computer's own OpenMausBot installs, by the environment id each keeps in its data folder. */
export function ownEnvironmentIds(dataDirs) {
  const ids = new Set();
  for (const dir of dataDirs) {
    if (typeof dir !== "string" || !dir) continue;
    try {
      const id = fs.readFileSync(path.join(dir, "environment-id"), "utf8").trim();
      if (UUID.test(id)) ids.add(id.toLowerCase());
    } catch {}
  }
  return [...ids].slice(0, 8);
}

const hash = server => createHash("sha256").update(JSON.stringify(server)).digest("hex");
const failure = message => new Error(message);
/** The server answered the request with an error: it is still running. */
const refusal = message => Object.assign(new Error(message), { answered: true });

/** How Windows starts `command`: a program directly, found on PATH with PATHEXT as Windows finds it, and a .cmd or .bat
 * shim (npx.cmd, uvx.cmd) through cmd.exe, which alone runs one, each word quoted for it. Null when it isn't there. */
export function windowsLaunch(command, args, env, exists = fs.existsSync) {
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => extension.toLowerCase());
  const names = path.win32.extname(command) ? [command] : extensions.map(extension => `${command}${extension}`);
  const dirs = /[\\/]/.test(command) ? [""] : (env.PATH || env.Path || "").split(";").filter(Boolean);
  const file = dirs.flatMap(dir => names.map(name => (dir ? path.win32.join(dir, name) : name))).find(candidate => exists(candidate));
  if (!file) return null;
  if (!/\.(?:cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  const line = [file, ...args].map(word => `"${word.replace(/"/g, '""')}"`).join(" ");
  return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

const notHere = server => failure(`${server.name} could not start: ${path.basename(server.command)} is not on this computer`);

function stdioClient(server, { environment, home }) {
  const windows = process.platform === "win32";
  const env = { ...environment, ...server.env };
  const launch = windows ? windowsLaunch(server.command, server.args, { ...env, ComSpec: env.ComSpec || process.env.ComSpec }) : { file: server.command, args: server.args, verbatim: false };
  if (!launch) throw notHere(server);
  const child = spawn(launch.file, launch.args, {
    cwd: home, detached: !windows, windowsHide: true, windowsVerbatimArguments: launch.verbatim, stdio: ["pipe", "pipe", "ignore"], env,
  });
  let sequence = 0; let closed = null; let bytes = 0;
  const pending = new Map();
  const end = error => {
    if (closed) return;
    closed = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear(); killTree(child);
  };
  child.on("error", error => end(error.code === "ENOENT" ? notHere(server) : failure(`${server.name} could not start`)));
  child.stdin.on("error", () => end(failure(`${server.name} stopped`)));
  child.on("exit", () => end(failure(`${server.name} stopped`)));
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > RESULT_LIMIT) end(failure(`${server.name} answered with more than ${RESULT_LIMIT} bytes`)); });
  const lines = readline.createInterface({ input: child.stdout });
  const write = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!record(message)) return;
    // A server's own request (roots, sampling) is one this client does not offer.
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) return void write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not offered by OpenMausBot" } });
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); bytes = 0;
    if (message.error) waiting.reject(refusal(String(message.error.message ?? `${server.name} refused the request`))); else waiting.resolve(message.result);
  });
  return {
    request(method, params, signal, ms) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(closed);
        const id = ++sequence;
        const stop = () => { cleanup(); pending.delete(id); reject(failure(`${server.name} did not answer in time`)); end(failure(`${server.name} stopped`)); };
        const timer = setTimeout(stop, ms);
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
        signal.addEventListener("abort", stop, { once: true });
        pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method) { if (!closed) write({ jsonrpc: "2.0", method }); },
    close() {
      lines.close();
      const exited = child.exitCode !== null || child.signalCode !== null || !child.pid ? Promise.resolve()
        : new Promise(resolve => { const timer = setTimeout(resolve, 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      end(failure(`${server.name} stopped`));
      return exited;
    },
  };
}

/** One JSON-RPC answer out of a Streamable HTTP reply: a JSON body, or the event in an event stream that carries it. */
async function answerOf(response, id, name) {
  const reader = response.body?.getReader();
  if (!reader) throw failure(`${name} sent an empty answer`);
  const stream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const decoder = new TextDecoder();
  let text = ""; let size = 0;
  const matching = value => [value].flat().find(message => record(message) && message.id === id);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) { size += value.byteLength; if (size > RESULT_LIMIT) throw failure(`${name} answered with more than ${RESULT_LIMIT} bytes`); text += decoder.decode(value, { stream: true }); }
      if (stream) {
        const events = text.split(/\r?\n\r?\n/);
        text = done ? "" : events.pop() ?? "";
        for (const event of events) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          let message; try { message = JSON.parse(data); } catch { continue; }
          const found = matching(message);
          if (found) return found;
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (stream) throw failure(`${name} ended its answer without a reply`);
  let parsed; try { parsed = JSON.parse(text); } catch { throw failure(`${name} sent an answer that is not JSON`); }
  const found = matching(parsed);
  if (!found) throw failure(`${name} sent no reply to the request`);
  return found;
}

function httpClient(server, { fetch: fetchImpl }) {
  let session = null; let protocol = null; let sequence = 0;
  const target = new URL(server.url);
  const send = async (message, signal, ms) => {
    let response;
    try {
      response = await fetchImpl(server.url, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...(protocol ? { "mcp-protocol-version": protocol } : {}) },
        body: JSON.stringify(message),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw failure(`${server.name} did not answer in time`);
      if (signal.aborted) throw failure("The requesting turn ended");
      throw failure(`${server.name} is not answering at ${target.host} on this computer`);
    }
    const id = response.headers.get("mcp-session-id");
    if (id) session = id;
    if (!Object.hasOwn(message, "id")) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404 && session) { session = null; protocol = null; throw Object.assign(failure(`${server.name} forgot its session`), { expired: true }); }
      throw failure(response.status === 401 || response.status === 403 ? `${server.name} refused its saved keys (HTTP ${response.status})` : `${server.name} answered HTTP ${response.status}`);
    }
    const answer = await answerOf(response, message.id, server.name);
    if (answer.error) throw refusal(String(answer.error.message ?? `${server.name} refused the request`));
    return answer.result;
  };
  return {
    request: (method, params, signal, ms) => send({ jsonrpc: "2.0", id: ++sequence, method, params }, signal, ms),
    notify(method) { void send({ jsonrpc: "2.0", method }, new AbortController().signal, 10_000).catch(() => {}); },
    started(version) { protocol = typeof version === "string" ? version : PROTOCOL; },
    close() { session = null; return Promise.resolve(); },
  };
}

/** The servers one lent Cloud keeps here, each started once and kept between calls; a change to one starts it anew, and
 * one unused for ten minutes is stopped. */
export function createLentMcp({ environment = async () => ({ ...inheritedEnvironment(), PATH: await commandPath() }), home = os.homedir(), fetch: fetchImpl = globalThis.fetch } = {}) {
  const running = new Map();
  const stop = name => {
    const live = running.get(name);
    if (!live) return Promise.resolve();
    clearTimeout(live.idle); running.delete(name);
    return live.client.close();
  };
  const ready = async (server, signal) => {
    const key = hash(server);
    const known = running.get(server.name);
    if (known?.key === key && !known.failed) return known;
    stop(server.name);
    const client = "command" in server ? stdioClient(server, { environment: await environment(), home }) : httpClient(server, { fetch: fetchImpl });
    const live = { key, client, idle: null, failed: false, started: null };
    running.set(server.name, live);
    live.started = client.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "openmausbot-lent", version: "1" } }, signal, START_MS).then(result => {
      client.started?.(result?.protocolVersion);
      client.notify("notifications/initialized");
    });
    live.started.catch(() => {});
    return live;
  };
  const use = async (server, signal, work) => {
    for (let attempt = 0; ; attempt++) {
      const live = await ready(server, signal);
      clearTimeout(live.idle);
      try { await live.started; } catch (error) { live.failed = true; stop(server.name); throw error; }
      try {
        const result = await work(live.client);
        live.idle = setTimeout(() => stop(server.name), IDLE_MS);
        live.idle.unref?.();
        return result;
      } catch (error) {
        if (error?.answered) { live.idle = setTimeout(() => stop(server.name), IDLE_MS); live.idle.unref?.(); throw error; }
        live.failed = true; stop(server.name);
        if (!error?.expired || attempt > 0) throw error;
      }
    }
  };
  return {
    async call(operation, signal) {
      const { server } = operation;
      if (operation.action === "mcp_tools") {
        return use(server, signal, async client => {
          const tools = [];
          let cursor;
          for (let page = 0; page < MAX_PAGES; page++) {
            const listed = await client.request("tools/list", cursor ? { cursor } : {}, signal, START_MS);
            if (Array.isArray(listed?.tools)) tools.push(...listed.tools);
            cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
            if (!cursor) break;
          }
          return { tools };
        });
      }
      if (typeof operation.tool_name !== "string" || !operation.tool_name) throw failure("Name the tool to call");
      return use(server, signal, client => client.request("tools/call", { name: operation.tool_name, arguments: operation.arguments ?? {} }, signal, CALL_MS));
    },
    /** Resolves once every server it started has exited, or after five seconds. */
    close: () => Promise.all([...running.keys()].map(stop)).then(() => {}),
  };
}
