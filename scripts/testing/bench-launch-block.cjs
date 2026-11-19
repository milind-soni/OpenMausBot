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
    const refuse = () => this.destroy(new Error(`bench-launch: no connection to ${host} from a measured launch`));
    const stallMs = Number(process.env.OMB_BENCH_EGRESS_STALL_MS) || 0;
    if (stallMs) setTimeout(refuse, stallMs); else process.nextTick(refuse);
    return this;
  };
  // The CPU a server has used when it says it listens: a start's cost that a busy machine does not stretch.
  const cpuOut = process.env.OMB_BENCH_CPU_OUT;
  if (cpuOut) {
    const write = process.stdout.write;
    process.stdout.write = function (chunk, ...rest) {
      if (String(chunk).includes("openmausbot server on ")) {
        const used = process.cpuUsage();
        try { fs.writeFileSync(cpuOut, String((used.user + used.system) / 1000)); } catch {}
        process.stdout.write = write;
      }
      return write.call(this, chunk, ...rest);
    };
  }
  // The server child's own V8 profile, from its first line to its "listening" line (scripts/bench-launch.mjs --server-prof).
  const profDir = process.env.OMB_BENCH_SERVER_PROF;
  if (profDir && process.type === "utility") {
    const { Session } = require("node:inspector");
    const session = new Session();
    session.connect();
    session.post("Profiler.enable");
    session.post("Profiler.setSamplingInterval", { interval: 250 });
    session.post("Profiler.start");
    const write = process.stdout.write;
    let done = false;
    process.stdout.write = function (chunk, ...rest) {
      if (!done && String(chunk).includes("openmausbot server on ")) {
        done = true;
        const stop = () => session.post("Profiler.stop", (error, result) => {
          if (!error) try { fs.mkdirSync(profDir, { recursive: true }); fs.writeFileSync(`${profDir}/server-${process.pid}.cpuprofile`, JSON.stringify(result.profile)); } catch {}
        });
        const tailMs = Number(process.env.OMB_BENCH_SERVER_PROF_TAIL_MS) || 0;
        if (tailMs) setTimeout(stop, tailMs); else stop();
      }
      return write.call(this, chunk, ...rest);
    };
  }
}
