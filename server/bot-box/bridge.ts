// How a box with its own network reaches the two gates: a loopback port inside is bridged to a unix socket bound in from
// outside. socat does it when the image has it (one small process per bridge); otherwise box-bridge.ts (Node) listens
// on every port and then runs the command.
import type { BoxBridge } from "./plan.ts";
import { inBoxSocket } from "./plan.ts";

export interface BridgeTools {
  /** Path of socat, or null when the image lacks it. */
  socat: string | null;
  /** The bundled box-bridge script, run with `node`. */
  bridgeScript: string;
  node: string;
}

/** The command the box runs: the bridges first, then the engine. `$0` is the engine so its argv passes through unchanged. */
export function bridgedCommand(tools: BridgeTools, bridges: readonly BoxBridge[], command: string, args: readonly string[]): { command: string; args: string[] } {
  if (!bridges.length) return { command, args: [...args] };
  if (tools.socat) {
    // Each bridge keeps none of the engine's stdio: its own messages never reach the driver's stderr, and a bridge that
    // outlives the engine (only without a PID namespace) holds no pipe open.
    const lines = bridges.map((bridge) =>
      `${shellWord(tools.socat!)} TCP4-LISTEN:${bridge.port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${shellWord(inBoxSocket(bridge.name))} </dev/null >/dev/null 2>&1 &`);
    // The first bridge must answer before the engine starts: its MCP proxies connect at once.
    const first = bridges[0]!;
    const wait = `n=0; until ${shellWord(tools.socat!)} -u OPEN:/dev/null TCP4:127.0.0.1:${first.port},connect-timeout=0.2 2>/dev/null || [ "$n" -ge 100 ]; do n=$((n+1)); sleep 0.01; done`;
    const script = [...lines, wait, 'exec "$0" "$@"'].join("\n");
    return { command: "/bin/sh", args: ["-c", script, command, ...args] };
  }
  return { command: tools.node, args: [tools.bridgeScript, ...bridges.map((bridge) => `--bridge=${bridge.port}=${inBoxSocket(bridge.name)}`), "--", command, ...args] };
}

/** A word for /bin/sh, single-quoted. */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
