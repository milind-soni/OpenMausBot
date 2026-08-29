// The one transparent stdio bridge behind both MCP entry points
// (container-mcp.ts for the Local VM, vps-container-mcp.ts for the BYO VPS).
// It defines no tools and parses no MCP messages: bytes in, bytes out.
//
// There are two exceptions to that transparency, both opt-in.
//
// The who-is-driving gate (`gate`). While the person holds control of this
// computer in the app, a `tools/call` from the agent is answered with a
// refusal HERE, on the near side, and never forwarded — Cua Driver on the far
// side has no concept of a person holding the wheel, so the refusal cannot
// come from anywhere else.
//
// The worker task tools (`task`). A remote worker's CUA session is bounded by
// a capability that only an approved task manifest can activate, so the tools
// that propose, run and read back a task belong on the same MCP server as the
// CUA tools they gate — otherwise a bot would hold a computer it has no way to
// unlock. They are appended to the far end's `tools/list` and answered here
// against the harness's loopback control endpoint, which owns the registry,
// the approval card and the SSH transport. The bridge itself stays thin.
//
// Everything that is not a tools/call still passes through untouched, and with
// neither option configured the bridge remains the byte-for-byte pipe
// described above.
//
// Two behaviors live here so neither entry point can drift:
//   1. Exit without truncation. `process.exit()` in a close/error handler
//      discards whatever is still buffered on stdout — a final MCP result
//      would be cut mid-frame. The bridge sets exitCode and unpipes instead,
//      letting stdio drain before the process ends on its own.
//   2. A dead-transport watchdog (opt-in via `liveness`). docker's ssh
//      connection helper accepts no ConnectTimeout/ServerAlive options, so a
//      VPS dropping mid-turn leaves the exec silently wedged until the OS
//      gives up — the harness sees a hung tool call, not an error.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CONTROL_REFUSAL_PLAIN, createControlClient } from "./control-client.ts";
import { augmentedPath } from "./env-path.ts";
import { createWorkerTaskClient, type WorkerTaskClient, type WorkerTaskOp } from "./worker-task-client.ts";

// 45s of TOTAL silence before the bridge even probes. An MCP session is
// legitimately quiet between tool calls and a slow screenshot can take tens
// of seconds, so silence alone never kills anything — it only triggers a
// liveness probe, and only a probe that FAILS ends the bridge. Any byte on
// stdin/stdout/stderr resets the window.
export const BRIDGE_INACTIVITY_MS = 45_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface BridgeLiveness {
  command: string;
  args: string[];
  /** Optional child environment for a transport with a stricter boundary. */
  env?: NodeJS.ProcessEnv;
}

/** Run the liveness command; alive means "exited 0 within the timeout". The
 * probe is its own short-lived process, so it cannot inherit the wedged
 * connection it is diagnosing. */
export function runLivenessProbe(probe: BridgeLiveness, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probe.command, probe.args, {
      shell: false,
      env: probe.env ?? { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export interface WatchdogHandle {
  /** Any traffic in either direction — resets the inactivity window. */
  touch: () => void;
  stop: () => void;
}

/** Inactivity → probe → (only then) declare dead. Traffic arriving while a
 * probe is in flight vetoes even a failed probe: bytes are better evidence
 * of life than a health command racing a congested link. */
export function createInactivityWatchdog(options: {
  inactivityMs: number;
  probe: () => Promise<boolean>;
  onDead: () => void;
}): WatchdogHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let probing = false;
  let touchedWhileProbing = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(fire, options.inactivityMs);
    timer.unref?.();
  };
  const settleProbe = (alive: boolean) => {
    probing = false;
    if (stopped) return;
    if (alive || touchedWhileProbing) {
      arm();
      return;
    }
    options.onDead();
  };
  const fire = () => {
    probing = true;
    touchedWhileProbing = false;
    void options.probe().then(settleProbe, () => settleProbe(false));
  };

  arm();
  return {
    touch() {
      if (stopped) return;
      if (probing) {
        touchedWhileProbing = true;
        return;
      }
      if (timer) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface BridgeOptions {
  command: string;
  args: string[];
  /** Optional child environment. The default preserves existing local/VPS
   * behavior; a remote worker supplies an allow-listed SSH environment so no
   * API key or loopback control token can reach the ssh child. */
  env?: NodeJS.ProcessEnv;
  /** Names the far end in stderr messages, e.g. "Cua Driver". */
  label: string;
  /** Enables the dead-transport watchdog. Omitted for the Local VM, whose
   * runtime CLI talks to a local daemon and fails fast on its own. */
  liveness?: BridgeLiveness;
  /** Enables the who-is-driving gate: the harness's loopback control
   * endpoint plus its per-boot token. Absent → fully transparent bridge. */
  gate?: { url: string; token: string };
  /** Enables the worker task tools: the harness's loopback task endpoint plus
   * its per-boot token. Absent → the far end's tool list is untouched. */
  task?: { url: string; token: string };
}

/** Collect a byte stream into complete newline-terminated lines. MCP's
 * stdio transport is one JSON-RPC frame per line, so line boundaries are
 * the only safe place to inspect — or inject — anything. */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        onLine(line);
      }
    },
    flush() {
      pending += decoder.end();
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

/** The gate itself, factored free of process wiring so a test can drive it
 * with plain strings. Frames are handled on a serialized queue: the
 * held-check is async, and answering frame N+1 before frame N would
 * reorder the agent's protocol stream. Only a `tools/call` is ever
 * refused; every other frame — handshakes, tools/list, notifications,
 * lines that are not JSON — passes through untouched. */
export function createGateInterceptor(options: {
  isHeld: () => Promise<boolean>;
  forward: (line: string) => void;
  refuse: (line: string) => void;
  refusalText?: string;
}): (line: string) => void {
  const refusalText = options.refusalText ?? CONTROL_REFUSAL_PLAIN;
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    queue = queue.then(async () => {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        // not a frame this gate understands — never stand between the
        // agent and its driver on anything but a recognized tool call
      }
      if (!frame || frame.method !== "tools/call") {
        options.forward(line);
        return;
      }
      const held = await options.isHeld().catch(() => false);
      if (!held) {
        options.forward(line);
        return;
      }
      options.refuse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: { content: [{ type: "text", text: refusalText }], isError: true },
        }),
      );
    });
  };
}

/** The tools a bot needs to unlock and drive a remote worker. They are named
 * for what they authorize, not for what they touch: `propose` is the call that
 * puts a card in front of a person, and nothing else here can run until it has
 * been answered. */
export const WORKER_TASK_TOOLS = [
  {
    name: "worker_task_propose",
    description:
      "Propose a task manifest for this worker and ask the person to approve it. " +
      "The manifest names every file to stage, every command that may run, and the " +
      "browser origins the task may reach. Nothing is staged, activated or run until " +
      "the person approves this exact document, and changing any field requires a new " +
      "approval. Call this before any computer tool: until a task is approved the " +
      "worker holds a capability that grants no tools at all.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: {
          type: "object",
          description: "The worker task manifest, version 1.",
        },
      },
      required: ["manifest"],
    },
  },
  {
    name: "worker_task_status",
    description:
      "Report the approved task on this worker for the current conversation: its id, " +
      "digest, the command ids it may run, and how long the approval has left.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "worker_task_run",
    description:
      "Run one command from the approved manifest by its id, on the worker, inside the " +
      "task's staged directory. The command's program and arguments come from the " +
      "approved document — this call selects one, it cannot describe one.",
    inputSchema: {
      type: "object",
      properties: { commandId: { type: "string", description: "A command id from the approved manifest." } },
      required: ["commandId"],
    },
  },
  {
    name: "worker_task_results",
    description:
      "Read back the task's declared result artefacts from the worker. Only paths the " +
      "approved manifest lists as results are readable.",
    inputSchema: { type: "object", properties: {} },
  },
];

const TASK_TOOL_OPS = {
  worker_task_propose: "propose",
  worker_task_run: "run",
  worker_task_status: "status",
  worker_task_results: "results",
} satisfies Record<string, WorkerTaskOp>;

/** The tool names this bridge answers itself. */
type TaskToolName = keyof typeof TASK_TOOL_OPS;

function taskOpFor(name: string): WorkerTaskOp | null {
  // SAFETY: the assertion is guarded by the own-property check on the very
  // same object, so `name` is one of this literal's keys by construction.
  return Object.hasOwn(TASK_TOOL_OPS, name) ? TASK_TOOL_OPS[name as TaskToolName] : null;
}

/** Injects the worker task tools into the far end's surface.
 *
 * Two halves, both on serialized queues for the reason the gate is: answering
 * frame N+1 before frame N would reorder the agent's protocol stream.
 *
 *   inbound   a `tools/call` for one of ours is answered here and never
 *             forwarded; everything else passes through, and the id of every
 *             `tools/list` is remembered
 *   outbound  the result of a remembered `tools/list` gets our descriptors
 *             appended; every other frame is emitted unchanged
 */
export interface TaskInterceptor {
  /** A line from the agent, heading for the far end. */
  inbound: (line: string) => void;
  /** A line from the far end, heading for the agent. */
  outbound: (line: string) => void;
}

export function createTaskInterceptor(options: {
  client: WorkerTaskClient;
  forward: (line: string) => void;
  emit: (line: string) => void;
}): TaskInterceptor {
  // Bounded so a far end that never answers a tools/list cannot grow this
  // without limit over a long session.
  const listIds = new Set<string>();
  const remember = (id: string) => {
    if (listIds.size > 64) listIds.clear();
    listIds.add(id);
  };
  let queue: Promise<void> = Promise.resolve();

  const inbound = (line: string) => {
    queue = queue.then(async () => {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        // not a frame we understand — never stand between the agent and its
        // driver on anything but a recognized call
      }
      if (!frame) {
        options.forward(line);
        return;
      }
      if (frame.method === "tools/list" && frame.id !== undefined && frame.id !== null) {
        remember(String(frame.id));
        options.forward(line);
        return;
      }
      const op = frame.method === "tools/call" ? taskOpFor(String(frame.params?.name ?? "")) : null;
      if (!op) {
        options.forward(line);
        return;
      }
      const args = frame.params?.arguments;
      const reply = await options.client.call(op, args && args instanceof Object ? { ...args } : {});
      options.emit(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: { content: [{ type: "text", text: reply.text }], isError: reply.isError },
        }),
      );
    });
  };

  const outbound = (line: string) => {
    let frame: any = null;
    try {
      frame = JSON.parse(line);
    } catch {
      options.emit(line);
      return;
    }
    const id = frame?.id === undefined || frame?.id === null ? null : String(frame.id);
    if (!id || !listIds.has(id) || !Array.isArray(frame?.result?.tools)) {
      options.emit(line);
      return;
    }
    listIds.delete(id);
    const existing = new Set(frame.result.tools.map((tool: any) => String(tool?.name ?? "")));
    frame.result.tools = [
      ...frame.result.tools,
      ...WORKER_TASK_TOOLS.filter((tool) => !existing.has(tool.name)),
    ];
    options.emit(JSON.stringify(frame));
  };

  return { inbound, outbound };
}

export function runMcpBridge(options: BridgeOptions): void {
  const child = spawn(options.command, options.args, {
    shell: false,
    env: options.env ?? { ...process.env, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // docker may exit before it drains stdin; pipe() leaves this error unhandled.
  child.stdin.on("error", () => {});
  child.stderr.pipe(process.stderr);

  const emit = (line: string) => process.stdout.write(line + "\n");
  const toChild = (line: string) => child.stdin.write(line + "\n");
  const tasks = options.task
    ? createTaskInterceptor({
        client: createWorkerTaskClient({ url: options.task.url, token: options.task.token }),
        forward: toChild,
        emit,
      })
    : null;

  let detach: () => void;
  if (options.gate || tasks) {
    // The gate runs first when both are configured: while a person holds the
    // wheel, nothing executes — proposing or running a task included.
    const deliver = tasks ? tasks.inbound : toChild;
    let entry = deliver;
    if (options.gate) {
      const client = createControlClient({ url: options.gate.url, token: options.gate.token });
      entry = createGateInterceptor({
        isHeld: async () => (await client.state(true)).held,
        forward: deliver,
        refuse: emit,
      });
    }
    const inbound = createLineSplitter(entry);
    const onStdin = (chunk: Buffer) => inbound.push(chunk);
    process.stdin.on("data", onStdin);
    process.stdin.on("end", () => {
      inbound.flush();
      child.stdin.end();
    });
    // Injected refusals and tool results must never land inside one of the
    // child's half-written frames, so the child's stdout is re-emitted at line
    // granularity as well.
    const outbound = createLineSplitter(tasks ? tasks.outbound : emit);
    child.stdout.on("data", (chunk) => outbound.push(chunk));
    child.stdout.on("end", () => outbound.flush());
    detach = () => {
      process.stdin.off("data", onStdin);
      process.stdin.pause();
    };
  } else {
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    detach = () => {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
    };
  }

  let watchdog: WatchdogHandle | null = null;
  if (options.liveness) {
    const liveness = options.liveness;
    watchdog = createInactivityWatchdog({
      inactivityMs: BRIDGE_INACTIVITY_MS,
      probe: () => runLivenessProbe(liveness),
      onDead: () => {
        process.stderr.write(
          `${options.label} transport went silent and stopped answering liveness probes; ending the bridge\n`,
        );
        process.exitCode = 1;
        detach();
        child.kill("SIGKILL");
        // A docker wedged on a dead ssh connection may never deliver close.
        // Nothing can be buffered on stdout after 45 quiet seconds, so this
        // hard exit — unlike the close-handler one this file exists to avoid —
        // cannot truncate anything.
        const failsafe = setTimeout(() => process.exit(1), 2_000);
        failsafe.unref?.();
      },
    });
    const touch = () => watchdog?.touch();
    process.stdin.on("data", touch);
    child.stdout.on("data", touch);
    child.stderr.on("data", touch);
  }

  child.on("error", (error) => {
    process.stderr.write(`could not connect to ${options.label}: ${error.message}\n`);
    process.exitCode = 1;
    watchdog?.stop();
    detach();
  });
  child.on("close", (code, signal) => {
    if (signal) process.stderr.write(`${options.label} connection ended with ${signal}\n`);
    // Let stdout and stderr drain before the bridge exits.
    process.exitCode = process.exitCode ?? code ?? 1;
    watchdog?.stop();
    detach();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
