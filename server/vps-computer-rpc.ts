// A VPS computer's proxy process, kept on the host: a boxed engine cannot reach the VPS itself (its network namespace
// has no routes and the egress gate is public-only), so the engine gets the cloud computer's mount instead — the
// harness MCP proxy it starts dials the harness gate, and POST /api/internal/computer/mcp serves this proxy's tools
// for a turn whose capability names no Boat. The child speaks the same stdio MCP the engine would have spawned.
import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";

import { controlRefusal, type ControlState } from "./control-client.ts";
import { COMPUTER_PROXY_TIMEOUT_MS } from "./harness-budget.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";
import { augmentedPath } from "./env-path.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

/** An idle child is dropped (its SSH master stays cached); the next call starts a new one. */
const CHILD_IDLE_MS = 10 * 60_000;
/** A child that has not finished its MCP handshake in this long is dead enough (SSH down, container gone). */
const CHILD_START_MS = 30_000;
const CONNECTION_LOST = "The VPS computer's connection was interrupted. Take a fresh screenshot before repeating anything whose result is uncertain.";

interface VpsTarget { sshAlias?: string; container: string; command?: string; args?: readonly string[] }

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

interface Child {
  proc: ChildProcess;
  /** The child's MCP initialize handshake; answered before the first call is sent. */
  ready: Promise<void>;
  /** One MCP request, serialized after the child's earlier ones (one desktop: calls act in order). */
  rpc(method: string, params: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  sshAlias?: string;
  container: string;
}

const targets = new Map<string, VpsTarget>();
const children = new Map<string, Child>();
/** Per bot: the desktop's calls in arrival order; one entry each, replaced by the next call. */
const queues = new Map<string, Promise<unknown>>();

/** Test seam: forget every target and child. */
export function forgetVpsComputers(): void {
  for (const botId of children.keys()) dropChild(botId);
  targets.clear();
}

/** The turn's bot serves its VPS computer's tools from here: remembers the target and drops a child that points at
 * another one (a re-provisioned container). Returns the mount a boxed engine starts instead of the stdio proxy. */
export function vpsComputerTools(
  botId: string,
  control: { token: string },
  harnessUrl: string,
  target: VpsTarget,
): { command: string; args: string[]; env: Record<string, string>; platform: "linux" } {
  targets.set(botId, target);
  const child = children.get(botId);
  if (child && (child.container !== target.container || child.sshAlias !== target.sshAlias)) dropChild(botId);
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.harnessMcp, "computer"],
    env: { ...AGENTS_NODE_FLAG, OMB_HARNESS_URL: harnessUrl, [harnessMcpTokenEnv("computer")]: control.token },
    platform: "linux",
  };
}

const failedResult = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const failure = (error: unknown) => failedResult(error instanceof Error ? error.message : String(error));
/** Why a request the child never answered ended: the desktop may still be running it. */
const unanswered = (text: string) => Object.assign(new Error(text), { unanswered: true });

/** Serves the internal computer calls of a turn that names no Boat from the bot's VPS proxy, and always ends the
 * response: 403 when that bot has none mounted. A tools/call passes `gate` when its turn comes in the bot's queue, as
 * the engine-spawned proxy's control client would. */
export async function vpsComputerTurn(turn: {
  body: { method?: unknown; params?: unknown };
  res: ServerResponse;
  json(res: ServerResponse, status: number, payload: unknown): void;
  botId: string;
  assertActive(): void;
  /** The desktop's take count now. */
  takeSequence(): number;
  /** The control gate, asked about the takes since a count. */
  gate(since: number): Promise<ControlState>;
  signal?: AbortSignal;
}): Promise<void> {
  const method = turn.body.method;
  if ((method !== "tools/list" && method !== "tools/call") || !targets.has(turn.botId)) {
    turn.json(turn.res, 403, { error: "this turn has no cloud computer" });
    return;
  }
  turn.assertActive();
  const arrivedAt = turn.takeSequence();
  // One desktop: a call waits for the bot's earlier ones, in arrival order, and passes the gate when its turn comes, so
  // a desktop a person took while it waited is never acted on.
  const previous = queues.get(turn.botId) ?? Promise.resolve();
  const queued = previous.then(async (): Promise<Record<string, unknown>> => {
    const child = await childFor(turn.botId, targets.get(turn.botId)!);
    if (method === "tools/call") {
      const state = await turn.gate(arrivedAt);
      if (state.held) return failedResult(controlRefusal(state));
      turn.assertActive();
    }
    try {
      return await child.rpc(method, turn.body.params ?? {}, turn.signal);
    } catch (error) {
      if (method === "tools/list") throw error;
      // A call the desktop never answered may still be running there: the next one starts a new child, never this one.
      if ((error as { unanswered?: true }).unanswered && children.get(turn.botId) === child) dropChild(turn.botId);
      return failure(error);
    }
  });
  queues.set(turn.botId, queued.then(() => undefined, () => undefined));
  try {
    turn.json(turn.res, 200, { result: await queued });
  } catch (error) {
    if (method === "tools/list") throw error;
    turn.json(turn.res, 200, { result: failure(error) });
  }
}

function dropChild(botId: string): void {
  const child = children.get(botId);
  if (!child) return;
  children.delete(botId);
  // The close handler still runs: it rejects the child's pending calls and skips the map (already gone).
  child.proc.kill("SIGKILL");
}

function childFor(botId: string, target: VpsTarget): Promise<Child> {
  const known = children.get(botId);
  if (known && known.container === target.container && known.sshAlias === target.sshAlias) return Promise.resolve(known);
  if (known) dropChild(botId);
  const child = openChild(botId, target);
  children.set(botId, child);
  const start = Promise.race([
    child.ready,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("The VPS computer's proxy did not start. Check the VPS in Settings.")), CHILD_START_MS);
      timer.unref?.();
    }),
  ]);
  return start.then(() => child, (error) => { dropChild(botId); throw error instanceof Error ? error : new Error(String(error)); });
}

function openChild(botId: string, target: VpsTarget): Child {
  const command = target.command ?? process.execPath;
  const args = [...(target.args ?? [SPAWNED_PROXIES.vpsContainerMcp, target.sshAlias ?? "", target.container])];
  const proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath(), ...AGENTS_NODE_FLAG } });
  proc.stdin?.on("error", () => {});
  proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`vps computer: ${chunk}`));
  const pending = new Map<string, Pending>();
  let sequence = 0;
  let idle: NodeJS.Timeout | null = null;
  let handshakeDone = false;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => dropChild(botId), CHILD_IDLE_MS);
    idle.unref?.();
  };
  const stop = () => {
    if (idle) clearTimeout(idle);
    if (children.get(botId) === self) children.delete(botId);
    const text = handshakeDone ? CONNECTION_LOST : "The VPS computer's proxy stopped before it connected. Check the VPS in Settings.";
    for (const wait of pending.values()) wait.reject(handshakeDone ? unanswered(text) : new Error(text));
    pending.clear();
  };
  proc.on("close", stop);
  // A start that fails (EAGAIN, ENOENT) is an event on the process, with no listener of its own elsewhere.
  proc.on("error", stop);
  const takeLine = (line: string) => {
    if (!line.trim()) return;
    let frame: { id?: unknown; result?: unknown; error?: { message?: unknown } } | null = null;
    try { frame = JSON.parse(line); } catch { return; }
    if (typeof frame?.id !== "string" || !pending.has(frame.id)) return;
    const wait = pending.get(frame.id)!;
    pending.delete(frame.id);
    touch();
    if (frame.error) wait.reject(new Error(typeof frame.error.message === "string" ? frame.error.message : CONNECTION_LOST));
    else if (frame.result && typeof frame.result === "object") wait.resolve(frame.result as Record<string, unknown>);
    else wait.reject(new Error(CONNECTION_LOST));
  };
  const outbound = createLineSplitter(takeLine);
  proc.stdout?.on("data", (chunk: Buffer) => outbound.push(chunk));
  proc.stdout?.on("end", () => outbound.flush());
  const send = (method: string, params: unknown, signal: AbortSignal | undefined) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return reject(new Error(CONNECTION_LOST));
    // The abort event is not repeated for a listener added after it, so a turn that ended while this call waited is seen here.
    if (signal?.aborted) return reject(new Error("The turn ended before this call reached the VPS computer, so nothing was run."));
    const id = `omb-vps-${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(unanswered("The VPS computer did not answer in time. It may still have run; check its state before repeating anything."));
    }, COMPUTER_PROXY_TIMEOUT_MS - 5_000);
    timer.unref?.();
    const onAbort = () => {
      pending.delete(id);
      clearTimeout(timer);
      reject(unanswered("The turn ended while the VPS computer was working, so the result was not confirmed."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (value) => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", onAbort); touch(); resolve(value); },
      reject: (error) => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const rpc = (method: string, params: unknown, signal?: AbortSignal) => {
    touch();
    return send(method, params, signal);
  };
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openmausbot-vps-computer", version: "1" } })
    .then(() => {
      handshakeDone = true;
      try { proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); } catch {}
    });
  const self: Child = { proc, ready, rpc, sshAlias: target.sshAlias, container: target.container };
  return self;
}
