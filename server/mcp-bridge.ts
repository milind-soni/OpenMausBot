import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CONTROL_ACT_WITHIN_MS, CONTROL_UNCONFIRMED, CONTROL_WAITED, controlRefusal, createControlClient, type ControlState } from "./control-client.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { textOnlyErrorResultLine } from "./mcp-error-result.ts";
import { createToolListNormalizer } from "./mcp-tool-schema.ts";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.ts";

export const BRIDGE_INACTIVITY_MS = 45_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface BridgeLiveness {
  command: string;
  args: string[];
}

export function runLivenessProbe(probe: BridgeLiveness, timeoutMs = PROBE_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probe.command, probe.args, {
      shell: false,
      env: env ?? { ...process.env, PATH: augmentedPath() },
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
  touch: () => void;
  stop: () => void;
}

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
  env?: NodeJS.ProcessEnv;
  label: string;
  /** docker's ssh connection helper takes no ConnectTimeout/ServerAlive options, so a dropped VPS wedges silently without this. */
  liveness?: BridgeLiveness;
  gate?: { url: string; token: string };
}

/** MCP stdio is one JSON-RPC frame per line, so line boundaries are the only safe place to inspect or inject. */
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

/** Serialized: the check is async, and answering frame N+1 before frame N would reorder the agent's protocol stream. */
export function createGateInterceptor(options: {
  check: () => Promise<ControlState>;
  forward: (line: string) => void;
  refuse: (line: string) => void;
  actWithinMs?: number;
}): (line: string) => Promise<void> {
  const actWithinMs = options.actWithinMs ?? CONTROL_ACT_WITHIN_MS;
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    const arrivedAt = Date.now();
    queue = queue.then(async () => {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
      }
      if (!frame || frame.method !== "tools/call") {
        options.forward(line);
        return;
      }
      const state = await options.check().catch((): ControlState => ({ held: true, helpOpen: false, blockedReason: CONTROL_UNCONFIRMED }));
      if (!state.held && Date.now() - arrivedAt <= actWithinMs) {
        options.forward(line);
        return;
      }
      options.refuse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: { content: [{ type: "text", text: state.held ? controlRefusal(state) : CONTROL_WAITED }], isError: true },
        }),
      );
    });
    return queue;
  };
}

export interface McpBridgeInterceptorOptions {
  answer: (line: string) => void;
  forward: (line: string) => void;
  gate?: { check: () => Promise<ControlState> };
}

/** The bundled cua-driver (through at least v0.22.1) answers MCP `ping` with -32601, so ping is answered here. */
export function createMcpBridgeInterceptor(
  options: McpBridgeInterceptorOptions,
): (line: string) => void | Promise<void> {
  const afterPing = options.gate
    ? createGateInterceptor({ check: options.gate.check, forward: options.forward, refuse: options.answer })
    : (line: string) => { options.forward(line); };
  return (line: string) => {
    let frame: any = null;
    try {
      frame = JSON.parse(line);
    } catch {
    }
    if (frame && frame.method === "ping") {
      // Notifications have no `id` and require no response.
      if (frame.id !== undefined) {
        options.answer(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
      }
      return;
    }
    return afterPing(line);
  };
}

export function runMcpBridge(options: BridgeOptions): void {
  const env = options.env ?? { ...process.env, PATH: augmentedPath() };
  const { command, args } = resolveCliSpawn(options.command, options.args, env);
  const child = spawn(command, args, {
    shell: false,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // docker may exit before it drains stdin; pipe() leaves this error unhandled.
  child.stdin.on("error", () => {});
  child.stderr.pipe(process.stderr);

  const client = options.gate
    ? createControlClient({ url: options.gate.url, token: options.gate.token })
    : null;

  const answer = (line: string) => process.stdout.write(line + "\n");
  const forward = (line: string) => child.stdin.write(line + "\n");
  const intercept = createMcpBridgeInterceptor({
    answer,
    forward,
    ...(client ? { gate: { check: () => client.state(true) } } : {}),
  });
  const toolLists = createToolListNormalizer(toolSchemaProfileFromEnv(), (line) => process.stderr.write(`${options.label}: ${line}\n`));
  let pendingInput = Promise.resolve();
  const inbound = createLineSplitter((line) => {
    toolLists.observeRequest(line);
    const completion = intercept(line);
    if (completion) pendingInput = completion;
  });

  const onStdin = (chunk: Buffer) => inbound.push(chunk);
  process.stdin.on("data", onStdin);
  process.stdin.on("end", () => {
    inbound.flush();
    // A final tools/call may still await the gate: close the far end only after it is forwarded.
    void pendingInput.finally(() => child.stdin.end());
  });

  // Injected responses must never land inside one of the child's half-written frames.
  const outbound = createLineSplitter((line) => process.stdout.write(textOnlyErrorResultLine(toolLists.rewriteResponse(line)) + "\n"));
  child.stdout.on("data", (chunk) => outbound.push(chunk));
  child.stdout.on("end", () => outbound.flush());

  const detach = () => {
    process.stdin.off("data", onStdin);
    process.stdin.pause();
  };

  let watchdog: WatchdogHandle | null = null;
  if (options.liveness) {
    const liveness = options.liveness;
    watchdog = createInactivityWatchdog({
      inactivityMs: BRIDGE_INACTIVITY_MS,
      probe: () => runLivenessProbe(liveness, PROBE_TIMEOUT_MS, options.env),
      onDead: () => {
        process.stderr.write(
          `${options.label} transport went silent and stopped answering liveness probes; ending the bridge\n`,
        );
        process.exitCode = 1;
        detach();
        child.kill("SIGKILL");
        // A docker wedged on a dead ssh link may never deliver close; after 45 quiet seconds nothing is buffered to truncate.
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
    // process.exit() here would discard buffered stdout mid-frame: set exitCode and let stdio drain.
    process.exitCode = process.exitCode ?? code ?? 1;
    watchdog?.stop();
    detach();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
