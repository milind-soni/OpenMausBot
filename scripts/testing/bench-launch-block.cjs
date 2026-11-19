// scripts/bench-launch.mjs loads this into the bench's Electron main process and, through NODE_OPTIONS, its server
// child: a Node socket to anything but this computer is refused and written down, so a measured launch never calls out.
const fs = require("node:fs");
const net = require("node:net");

const LOADED = Symbol.for("omb.bench-launch.block");
if (!globalThis[LOADED]) {
  globalThis[LOADED] = true;
  const file = process.env.OMB_BENCH_EGRESS_LOG;
  const note = (line) => {
    if (!file) return;
    try { fs.appendFileSync(file, `${Date.now()} pid=${process.pid} ${line}\n`); } catch {}
  };
  note(`loaded type=${process.type ?? "node"}`);
  const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::"]);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === "object" ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    const host = options.path ? null : String(options.host ?? "localhost").toLowerCase();
    if (host === null || LOCAL.has(host)) return connect.apply(this, args);
    note(`blocked ${host}:${options.port}`);
    process.nextTick(() => this.destroy(new Error(`bench-launch: no connection to ${host} from a measured launch`)));
    return this;
  };
}
