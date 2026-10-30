// Runs inside a bot box when the image has no socat: listens on loopback ports and forwards each connection to a unix
// socket bound into the box, then runs the engine with the box's stdio and exits with its status.
//   node box-bridge.js --bridge=3128=/run/omb/egress.sock --bridge=8799=/run/omb/harness.sock -- claude -p ...
import { spawn } from "node:child_process";
import { connect, createServer, type Server } from "node:net";

export interface BridgeSpec { port: number; socket: string }

export function parseBridgeArgs(argv: readonly string[]): { bridges: BridgeSpec[]; command: string[] } {
  const bridges: BridgeSpec[] = [];
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") { index++; break; }
    const match = /^--bridge=(\d{1,5})=(.+)$/.exec(arg);
    if (!match) throw new Error(`box-bridge: unexpected argument ${arg}`);
    bridges.push({ port: Number(match[1]), socket: match[2]! });
  }
  return { bridges, command: argv.slice(index) };
}

/** Listens on 127.0.0.1:port and pipes each connection to the socket; resolves once listening. */
export function openBridge(spec: BridgeSpec): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      const upstream = connect(spec.socket);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.once("connect", () => { client.pipe(upstream); upstream.pipe(client); });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    server.once("error", reject);
    server.listen(spec.port, "127.0.0.1", () => { server.off("error", reject); resolve(server); });
  });
}

export async function runBridged(argv: readonly string[]): Promise<number> {
  const { bridges, command } = parseBridgeArgs(argv);
  if (!command.length) throw new Error("box-bridge: no command after --");
  const servers = await Promise.all(bridges.map(openBridge));
  for (const server of servers) server.unref();
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { try { child.kill(signal); } catch {} });
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}

if (process.argv[1] && /box-bridge\.[jt]s$/.test(process.argv[1])) {
  runBridged(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
