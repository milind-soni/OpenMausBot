// The shared stdio bridge for the host computer, Local VM, and BYO VPS.
//
// It is almost transparent — bytes in, bytes out — with three deliberate
// near-side exceptions:
//
//   1. `ping`. The bundled cua-driver (through at least v0.22.1) does not
//      implement this MCP method and would answer with -32601. Answering it
//      here keeps the handshake alive without reaching the driver.
//   2. The who-is-driving `gate` (opt-in via `gate`). While the person holds
//      control of this computer, a `tools/call` from the agent is answered
//      with a refusal here and never forwarded.
//   3. `tools/list` schemas. Every engine passes a tool's inputSchema to its
//      model provider, and strict providers refuse a root that is not a plain
//      object — failing the whole turn. The answer to a tools/list is
//      rewritten to a provider-safe root (see mcp-tool-schema.ts); the far
//      end still validates each call against its own schema.
//
// Both behaviors live here so neither entry point can drift:
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
import { createDecisionChooser } from "./decision-chooser.ts";
import { createDecisionModelClient, decisionModelProvider } from "./decision-model.ts";
import { augmentedPath } from "./env-path.ts";
import { createToolListNormalizer } from "./mcp-tool-schema.ts";

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
}

/** Run the liveness command; alive means "exited 0 within the timeout". A
 * separate bounded command checks the transport without waiting for an
 * answer on the possibly wedged MCP stream. */
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
  /** Explicit child environment; absent preserves the existing PATH setup. */
  env?: NodeJS.ProcessEnv;
  /** Names the far end in stderr messages, e.g. "Cua Driver". */
  label: string;
  /** Enables the dead-transport watchdog. Omitted for the Local VM, whose
   * runtime CLI talks to a local daemon and fails fast on its own. */
  liveness?: BridgeLiveness;
  /** Enables the who-is-driving gate: the harness's loopback control
   * endpoint plus its per-boot token. Absent → fully transparent bridge. */
  gate?: { url: string; token: string };
  /** Enables the opt-in decision-model chooser (#1630) on eligible
   * computer-use steps. Only honored together with `gate`, whose control
   * endpoint carries the turn goal and receives the outcome reports. */
  decision?: {
    provider: string;
    url: string;
    apiKey?: string;
    model: string;
    threshold: number;
    flow: string;
  };
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
  getRefusalReason?: () => string | undefined;
}): (line: string) => Promise<void> {
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
      const held = await options.isHeld().catch(() => true);
      if (!held) {
        options.forward(line);
        return;
      }
      options.refuse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: { content: [{ type: "text", text: options.getRefusalReason?.() ?? refusalText }], isError: true },
        }),
      );
    });
    return queue;
  };
}

/** The chooser's slice of the same queue discipline as the gate: an
 * eligible `tools/call` is answered near-side only after the decision
 * model resolves; everything else passes through untouched. The chooser's
 * own invariant lives in its implementation — any failure forwards the
 * original call, so this layer only ever adds a decision, never an error. */
export function createChooserInterceptor(options: {
  intercept: (call: { id: number | string; name: string; arguments: unknown }) => Promise<{ handled: boolean; text?: string }>;
  answer: (line: string) => void;
  forward: (line: string) => void;
}): (line: string) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    queue = queue.then(async () => {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        // not a frame this layer understands — forward untouched
      }
      if (!frame || frame.method !== "tools/call" || frame.id === undefined || typeof frame.params?.name !== "string") {
        options.forward(line);
        return;
      }
      let decision: { handled: boolean; text?: string };
      try {
        decision = await options.intercept({ id: frame.id, name: frame.params.name, arguments: frame.params.arguments });
      } catch {
        // A chooser failure must never break a run.
        decision = { handled: false };
      }
      if (decision.handled) {
        options.answer(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: { content: [{ type: "text", text: decision.text ?? "" }] },
          }),
        );
        return;
      }
      options.forward(line);
    });
    return queue;
  };
}

export interface McpBridgeInterceptorOptions {
  /** Writes a JSON-RPC response line to the agent's stdout. */
  answer: (line: string) => void;
  /** Forwards a line to the far-end child. */
  forward: (line: string) => void;
  /** Optional who-is-driving gate; when set, `tools/call` may be refused. */
  gate?: {
    isHeld: () => Promise<boolean>;
    refusalText?: string;
    getRefusalReason?: () => string | undefined;
  };
  /** Optional decision-model chooser (#1630); when set, an eligible
   * `tools/call` may be answered here instead of forwarded. */
  chooser?: {
    intercept: (call: { id: number | string; name: string; arguments: unknown }) => Promise<{ handled: boolean; text?: string }>;
  };
}

/** The near-side MCP method filter. `ping` is answered here so the bundled
 * cua-driver is never invoked for it; everything else is delegated to the
 * gate (if configured) or forwarded untouched. */
export function createMcpBridgeInterceptor(
  options: McpBridgeInterceptorOptions,
): (line: string) => void | Promise<void> {
  // The chooser runs downstream of the gate — a held computer never
  // reaches it. Its queue keeps answers ordered behind the gate's, and the
  // returned promise now covers both layers so a closing stdin still
  // waits for an in-flight decision.
  let chooserBusy = Promise.resolve();
  const chooserLayer = options.chooser
    ? createChooserInterceptor({
        intercept: options.chooser.intercept,
        answer: options.answer,
        forward: options.forward,
      })
    : null;
  const throughChooser = (line: string) => {
    if (!chooserLayer) {
      options.forward(line);
      return;
    }
    const completion = chooserLayer(line);
    chooserBusy = chooserBusy.then(
      () => completion,
      () => completion,
    );
  };
  const afterPing = options.gate
    ? createGateInterceptor({
        isHeld: options.gate.isHeld,
        forward: throughChooser,
        refuse: options.answer,
        refusalText: options.gate.refusalText,
        getRefusalReason: options.gate.getRefusalReason,
      })
    : (line: string) => { throughChooser(line); };
  return (line: string) => {
    let frame: any = null;
    try {
      frame = JSON.parse(line);
    } catch {
      // not a frame this bridge understands — forward untouched
    }
    if (frame && frame.method === "ping") {
      // Notifications have no `id` and require no response.
      if (frame.id !== undefined) {
        options.answer(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
      }
      return;
    }
    const completion = afterPing(line);
    return chooserLayer ? Promise.resolve(completion).then(() => chooserBusy) : completion;
  };
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

  const client = options.gate
    ? createControlClient({ url: options.gate.url, token: options.gate.token })
    : null;
  let refusalReason: string | undefined;
  // One ownership source for both layers: the gate refuses a held computer
  // up front, and the chooser re-checks the same state immediately before
  // acting on a decision — a hold acquired mid-decision still wins.
  const isHeldByHuman = async () => {
    refusalReason = undefined;
    const state = await client!.state(true);
    refusalReason = state.blockedReason;
    return state.held;
  };

  // The chooser's driver calls (get_window_state, click) ride the same
  // child under correlated string ids; their responses are routed back to
  // the chooser instead of the agent's stdout. JSON-RPC allows string ids,
  // and the prefix keeps them from colliding with the agent's own frames.
  const chooserCalls = new Map<string, (line: string) => void>();
  let chooserSeq = 0;
  const callDriver = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      chooserSeq += 1;
      const id = `omb-chooser-${chooserSeq}`;
      const timer = setTimeout(() => {
        chooserCalls.delete(id);
        reject(new Error("driver call timed out"));
      }, 15_000);
      timer.unref?.();
      chooserCalls.set(id, (line) => {
        clearTimeout(timer);
        chooserCalls.delete(id);
        let frame: any = null;
        try {
          frame = JSON.parse(line);
        } catch {
          // not a frame — the chooser sees a failed driver call
        }
        const result = frame?.result;
        if (result && typeof result === "object" && !Array.isArray(result) && result.isError === true) {
          reject(new Error("driver call failed"));
          return;
        }
        resolve(result ?? null);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  const decision = options.decision;
  const decisionProvider = decision ? decisionModelProvider(decision.provider) : null;
  const decisionClient =
    decision && decisionProvider && options.gate
      ? createDecisionModelClient({
          provider: decisionProvider,
          url: decision.url,
          ...(decision.apiKey ? { apiKey: decision.apiKey } : {}),
          model: decision.model,
          threshold: decision.threshold,
        })
      : null;
  const chooser =
    decisionClient && decision
      ? createDecisionChooser({
          client: decisionClient.client,
          threshold: decision.threshold,
          goal: () => client!.decisionContext().then((context) => context?.goal ?? null),
          report: (report) => {
            void client!.reportDecision({ ...report, flow: decision.flow });
          },
          callDriver,
          isHeld: isHeldByHuman,
        })
      : null;

  const answer = (line: string) => process.stdout.write(line + "\n");
  const forward = (line: string) => child.stdin.write(line + "\n");
  const intercept = createMcpBridgeInterceptor({
    answer,
    forward,
    ...(options.gate
      ? {
          gate: {
            isHeld: isHeldByHuman,
            getRefusalReason: () => refusalReason,
          },
        }
      : {}),
    ...(chooser ? { chooser: { intercept: chooser.intercept } } : {}),
  });
  const toolLists = createToolListNormalizer();
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
    // A final tools/call can still be awaiting the control endpoint. Do not
    // close the far end before the serialized gate has forwarded it.
    void pendingInput.finally(() => child.stdin.end());
  });

  // Injected responses and refusals must never land inside one of the
  // child's half-written frames, so the child's stdout is re-emitted at
  // line granularity as well.
  const outbound = createLineSplitter((line) => {
    // Internal chooser driver calls never join the agent's protocol stream —
    // including a late answer that arrives after its 15s timeout already
    // gave up: the id is gone from the map, but the prefix still marks it.
    if (line.includes("omb-chooser-")) {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = null;
      }
      if (frame && typeof frame.id === "string" && frame.id.startsWith("omb-chooser-")) {
        chooserCalls.get(frame.id)?.(line);
        return;
      }
    }
    process.stdout.write(toolLists.rewriteResponse(line) + "\n");
  });
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
