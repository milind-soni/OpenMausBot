// agent-browser's daemon (0.36/0.37, stream_http.rs) serves HTTP on 127.0.0.1 and relays `POST /api/command` over its
// session socket. It runs one command per session at a time, so a read waits behind the bot's own command and a timed-out
// read stays queued after the HTTP request is gone. A command outside its launch-free list relaunches a dead Chrome, so
// every pass starts with `stream_status` and reads only when Chrome is connected.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserDaemonFile, inRunningBrowser } from "./browser-engine.ts";
import { processAlive } from "./browser-processes.ts";
import { browserRuntimeEnv, type BrowserSpawnSpec } from "./browser-runtime.ts";

export interface RelayTarget { session: string; binaryPath: string; env: NodeJS.ProcessEnv }

export interface RelayAnswer {
  success: boolean;
  data: Record<string, unknown> | null;
  error?: string;
  launched: boolean;
}

/** The relay did not answer in time; the command may still be queued in the daemon. */
export class RelayTimeout extends Error {}

const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
export const PROBE_MS = 250;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Resolves with the daemon's answer, success or not; rejects on a timeout, a closed port or an oversized answer. */
export async function relay(port: number, command: Record<string, unknown>, options: { timeoutMs: number; maxBytes?: number }): Promise<RelayAnswer> {
  const origin = `http://127.0.0.1:${port}`;
  const maxBytes = options.maxBytes ?? MAX_ANSWER_BYTES;
  let response: Response;
  const signal = AbortSignal.timeout(Math.max(1, options.timeoutMs));
  try {
    response = await fetch(`${origin}/api/command`, {
      method: "POST", redirect: "error", signal,
      // The relay accepts only a same-origin request (stream_http.rs).
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(command),
    });
  } catch (error) {
    if (signal.aborted) throw new RelayTimeout("The browser did not answer in time.");
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error("The browser's answer was too large.");
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (signal.aborted) throw new RelayTimeout("The browser did not answer in time.");
    throw error;
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch {}
  if (!parsed) return { success: false, data: null, error: `The browser relay answered HTTP ${response.status}.`, launched: false };
  const data = record(parsed.data);
  const lifecycle = record(data?.lifecycle);
  return {
    success: parsed.success === true && response.ok,
    data,
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    launched: lifecycle?.launched === true,
  };
}

type Known = { port: number; daemonPid: number | null };

export class RelayPorts {
  private known = new Map<string, Known>();
  private tripped = new Set<string>();
  private started = new Set<string>();
  private readFile: (path: string) => string | null;
  private alive: (pid: number) => boolean;

  constructor(options: { readFile?: (path: string) => string | null; alive?: (pid: number) => boolean } = {}) {
    this.readFile = options.readFile ?? ((path) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
    this.alive = options.alive ?? ((pid) => processAlive(pid));
  }

  /** From the `.stream` file the daemon writes and deletes on exit, confirmed by `session_info` once per daemon: a port a
   * dead daemon left behind may already belong to another bot's browser. A daemon too busy to confirm trips the session. */
  async port(target: RelayTarget): Promise<number | null> {
    const text = this.readFile(browserDaemonFile(target.env, ".stream"))?.trim() ?? "";
    const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
    if (port < 1 || port > 65_535) { this.known.delete(target.session); return null; }
    const known = this.known.get(target.session);
    if (known?.port === port && (known.daemonPid === null || this.alive(known.daemonPid))) return port;
    this.known.delete(target.session);
    try {
      const info = await relay(port, { action: "session_info" }, { timeoutMs: PROBE_MS * 4, maxBytes: 65_536 });
      if (!info.success || info.data?.session !== target.session) return null;
      const daemonPid = typeof info.data.backgroundPid === "number" ? info.data.backgroundPid : null;
      this.known.set(target.session, { port, daemonPid });
      return port;
    } catch (error) {
      if (error instanceof RelayTimeout) this.trip(target.session);
      return null;
    }
  }

  daemonPid(session: string): number | null { return this.known.get(session)?.daemonPid ?? null; }

  /** After a relay timeout: no more relay work for this session until a probe answers. */
  trip(session: string): void { this.tripped.add(session); }

  /** Null when there is nothing to read: no daemon, no answer in the probe budget, or a tripped session whose probe still fails. */
  async probe(target: RelayTarget): Promise<{ port: number; connected: boolean } | null> {
    const port = await this.port(target);
    if (port === null) return null;
    try {
      const status = await relay(port, { action: "stream_status" }, { timeoutMs: PROBE_MS, maxBytes: 65_536 });
      this.tripped.delete(target.session);
      return { port, connected: status.success && status.data?.connected === true };
    } catch (error) {
      if (error instanceof RelayTimeout) this.trip(target.session);
      else this.known.delete(target.session);
      return null;
    }
  }

  isTripped(session: string): boolean { return this.tripped.has(session); }

  /** The engine restarted Chrome: its page is blank and unsized until the bot's next call sizes it. */
  noteStarted(session: string): void { this.started.add(session); }
  takeStarted(session: string): boolean { return this.started.delete(session); }

  forget(session: string): void {
    this.known.delete(session);
    this.tripped.delete(session);
    this.started.delete(session);
  }
}

/** Real input into the focused field; the text travels only in this request's body, never on a command line, and only into a running browser. */
async function openPort(ports: RelayPorts, target: RelayTarget): Promise<number> {
  const port = await ports.port(target);
  if (port !== null) return port;
  let status = await inRunningBrowser(target.binaryPath, target.env, ["stream", "status"]);
  if (status && status.enabled !== true) status = await inRunningBrowser(target.binaryPath, target.env, ["stream", "enable"]);
  const value = status?.port;
  if (status?.enabled !== true || typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("The browser did not open its local input channel. Restart the browser and try again.");
  }
  return value;
}

export async function typeText(ports: RelayPorts, target: RelayTarget, text: string): Promise<void> {
  const port = await openPort(ports, target);
  let answer: RelayAnswer | null = null;
  try { answer = await relay(port, { action: "keyboard", subaction: "insertText", text }, { timeoutMs: 30_000, maxBytes: 65_536 }); }
  catch {}
  if (answer?.success !== true) throw new Error("The browser did not take the typing.");
}

export async function runCommand(ports: RelayPorts, target: RelayTarget, command: Record<string, unknown>, timeoutMs: number): Promise<RelayAnswer> {
  const port = await openPort(ports, target);
  try { return await relay(port, command, { timeoutMs, maxBytes: 65_536 }); }
  catch (error) {
    if (error instanceof RelayTimeout) ports.trip(target.session);
    throw error;
  }
}

/** A photo-heavy page was ~400 KB as PNG and ~110 KB as JPEG at quality 80, in 30-70 ms, with text still legible. */
const FRAME_JPEG_QUALITY = 80;
/** A missing picture beats a stuck fold; headless Chrome on macOS can stall a fresh browser's first capture 10-20 s. */
const FRAME_TIMEOUT_MS = 12_000;

/** Never starts a browser: with no daemon, or Chrome not connected, there is simply no frame. */
export async function captureFrame(ports: RelayPorts, target: RelayTarget): Promise<{ png: string; format: "jpeg" }> {
  const probe = await ports.probe(target);
  if (!probe?.connected) throw new Error("the browser has no open page to picture");
  const file = join(tmpdir(), `openmausbot-browser-${randomUUID()}.jpg`);
  try {
    closeSync(openSync(file, "wx", 0o600));
    let answer: RelayAnswer;
    try { answer = await relay(probe.port, { action: "screenshot", path: file, format: "jpeg", quality: FRAME_JPEG_QUALITY }, { timeoutMs: FRAME_TIMEOUT_MS, maxBytes: 65_536 }); }
    catch (error) {
      if (error instanceof RelayTimeout) ports.trip(target.session);
      throw new Error("the browser did not return a picture in time");
    }
    if (answer.launched) ports.noteStarted(target.session);
    if (!answer.success) throw new Error("the browser could not be pictured");
    const png = readFileSync(file).toString("base64");
    if (!png) throw new Error("the browser reported a picture it did not write");
    return { png, format: "jpeg" };
  } finally {
    rmSync(file, { force: true });
  }
}

export const relayPorts = new RelayPorts();

export function relayTarget(spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string): RelayTarget {
  return { session, binaryPath: spec.command, env: browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }) };
}

export const relayFrame = (spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string) => captureFrame(relayPorts, relayTarget(spec, session));
/** Typing, a key and a click as real input, for filling a login; each throws when the browser did not take it. */
export function relayInput(spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string) {
  const target = relayTarget(spec, session);
  const act = async (command: Record<string, unknown>, refused: string) => {
    let answer: RelayAnswer | null = null;
    try { answer = await runCommand(relayPorts, target, command, 15_000); } catch {}
    if (answer?.success !== true) throw new Error(refused);
  };
  return {
    insertText: (text: string) => typeText(relayPorts, target, text),
    press: (key: string) => act({ action: "press", key }, "The browser did not take the key."),
    click: (selector: string) => act({ action: "click", selector }, "The browser did not take the click."),
  };
}
export const relayCommand = (spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string, command: Record<string, unknown>, timeoutMs: number) =>
  runCommand(relayPorts, relayTarget(spec, session), command, timeoutMs);
