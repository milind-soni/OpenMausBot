// The computer's own door onto its MCP servers, for a bot on My Cloud. My Cloud names a server, and for one at a
// loopback address a port, or the fingerprint of a command definition it serves; this computer decides from the answers
// its person gave here, never from My Cloud's word.
import { spawn as spawnChild } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { homedir } from "node:os";
import { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { commandFingerprint, inheritedEnvironment, killTree, windowsLaunch } from "./lent-mcp.mjs";
import { commandPath } from "./shell-path.mjs";

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SECRETY = /token|secret|pass|key|auth|credential|bearer|api/i;
const DECLINE_MS = 600_000;
const CONNECT_MS = 10_000;

/** The command line a person is shown: every arg in full except a value whose flag, `KEY=` or `Header:` name says it is
 * a secret, a URL's password and a Bearer credential, which become "…". Env is never shown. */
export function shownCommand(command, args) {
  const hide = (arg) => {
    const pair = /^([^=\s]+)=(.*)$/s.exec(arg) ?? /^([^:\s/][^:]*):\s*(.*)$/s.exec(arg);
    if (pair && SECRETY.test(pair[1])) return `${pair[1]}${arg[pair[1].length]}${arg[pair[1].length] === ":" ? " " : ""}…`;
    return arg.replace(/(\/\/[^/:@\s]*):[^@\s/]*@/g, "$1:…@").replace(/\bBearer\s+\S+/gi, "Bearer …");
  };
  return [command, ...args.map((arg, i) => (args[i - 1]?.startsWith("-") && !args[i - 1].includes("=") && SECRETY.test(args[i - 1]) ? "…" : hide(arg)))].join(" ");
}

function childStream(child, { platform, spawn }) {
  const stream = new Duplex({
    write(chunk, _encoding, callback) { child.stdin.write(chunk, callback); },
    final(callback) { child.stdin.end(); callback(); },
    read() { child.stdout.resume(); },
    destroy(error, callback) { killTree(child, { platform, spawn }); callback(error); },
  });
  child.stdout.on("data", (data) => { if (!stream.push(data)) child.stdout.pause(); });
  child.stdin.on("error", () => stream.destroy());
  child.on("error", () => stream.destroy());
  child.on("close", () => { stream.push(null); stream.destroy(); });
  return stream;
}

/**
 * `open(target)` answers `{ socket }`, `{ refused }` ("needs-approval": a prompt, for this server or another, is up on
 * this computer or was just shown; "declined": its person said no to this name, or to this port or command under any
 * name, in the last `declineMs`; "no-window": a prompt was needed and `canAsk()` said none can be shown) or `{ failed }`.
 * `approvals` is this computer's record of what its person allowed; `prompt` asks them and resolves true for Allow;
 * `definition(name)` is the command My Cloud now serves for a name, and `ownPorts()` the ports of this computer's own listeners.
 * `close()` ends every child it started, and any still starting.
 */
export function createMcpDoor({
  approvals, prompt, ownPorts, definition, canAsk = () => true,
  environment = async () => ({ ...inheritedEnvironment(), PATH: await commandPath() }), home = homedir(),
  connect = tcpConnect, spawn = spawnChild, now = Date.now, platform = process.platform,
  declineMs = DECLINE_MS, connectMs = CONNECT_MS,
}) {
  const declined = new Map();
  const holds = (name, wanted) => [name, JSON.stringify(wanted)];
  let asking = false;
  let generation = 0;
  const live = new Set();

  // Security: a URL is reached only on a port from 1024 to 65535 that is not one of this computer's own listeners; a
  // command is only the definition My Cloud serves now for that name, and only when it is the one the frame names.
  const wantedFor = async ({ name, port, fingerprint }) => {
    if (port !== undefined) {
      let own = [];
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
        try { own = await ownPorts(); } catch { return { failed: "unreachable" }; }
      }
      const refused = !Number.isInteger(port) || port < 1024 || port > 65535 || own.includes(port);
      return refused ? { failed: "bad-port" } : { wanted: { kind: "url", port } };
    }
    if (typeof fingerprint !== "string") return { failed: "no-server" };
    const entry = await Promise.resolve().then(() => definition(name)).catch(() => null);
    const strings = (list) => Array.isArray(list) && list.every((item) => typeof item === "string");
    const env = entry?.env;
    if (typeof entry?.command !== "string" || !strings(entry.args) || !env || typeof env !== "object" || !Object.values(env).every((value) => typeof value === "string")) return { failed: "no-server" };
    if (commandFingerprint(entry) !== fingerprint) return { failed: "changed" };
    return { wanted: { kind: "command", fingerprint }, entry };
  };

  // Security: the prompt names the exact target that is stored, and the env names the fingerprint covers.
  const ask = (name, wanted, entry) => {
    const target = wanted.kind === "url" ? wanted : { kind: "command", command: shownCommand(entry.command, entry.args), env: Object.keys(entry.env).sort() };
    asking = true;
    const asked = generation;
    void Promise.resolve().then(() => prompt({ name, target }))
      .then((ok) => {
        // Security: an answer given after close() belongs to a door that no longer lends anything.
        if (asked !== generation) return;
        if (ok === true) approvals.write({ ...approvals.read(), [name]: wanted }); else for (const key of holds(name, wanted)) declined.set(key, now() + declineMs);
      })
      .catch(() => {})
      .finally(() => { asking = false; });
  };

  const reach = (port, started) => new Promise((settle) => {
    if (started !== generation) { settle({ failed: "unreachable" }); return; }
    const socket = connect({ host: "127.0.0.1", port });
    const done = (result) => { clearTimeout(timer); socket.off("connect", opened); socket.off("error", failed); settle(result); };
    const opened = () => {
      if (started !== generation) { socket.destroy(); done({ failed: "unreachable" }); return; }
      live.add(socket);
      socket.once("close", () => live.delete(socket));
      done({ socket });
    };
    const failed = () => { socket.destroy(); done({ failed: "unreachable" }); };
    const timer = setTimeout(() => { socket.destroy(); done({ failed: "timeout" }); }, connectMs);
    socket.once("connect", opened);
    socket.once("error", failed);
  });

  // Security: the child's stderr is never read: a server's stderr often holds its secrets.
  const run = async (entry, started) => {
    let env;
    try { env = { ...(await environment()), ...entry.env }; } catch { return { failed: "spawn-failed" }; }
    if (started !== generation) return { failed: "spawn-failed" };
    const launch = platform === "win32"
      ? windowsLaunch(entry.command, entry.args, { ...env, ComSpec: env.ComSpec || process.env.ComSpec })
      : { file: entry.command, args: entry.args, verbatim: false };
    if (!launch) return { failed: "spawn-failed" };
    return new Promise((settle) => {
      let child;
      try {
        child = spawn(launch.file, launch.args, { cwd: home, env, stdio: ["pipe", "pipe", "ignore"], detached: platform !== "win32", windowsHide: true, windowsVerbatimArguments: launch.verbatim });
      } catch { settle({ failed: "spawn-failed" }); return; }
      const socket = childStream(child, { platform, spawn });
      live.add(socket);
      socket.once("close", () => live.delete(socket));
      if (started !== generation) socket.destroy();
      child.on("error", () => settle({ failed: "spawn-failed" }));
      child.once("spawn", () => settle(socket.destroyed ? { failed: "spawn-failed" } : { socket }));
    });
  };

  return {
    async open(target) {
      const started = generation;
      const name = target?.name;
      if (typeof name !== "string" || !NAME.test(name)) return { failed: "no-server" };
      const found = await wantedFor(target);
      if (found.failed) return { failed: found.failed };
      // Security: approvals are this computer's own record of what its person allowed, never My Cloud's word.
      if (!isDeepStrictEqual(approvals.read()[name], found.wanted)) {
        if (holds(name, found.wanted).some((key) => (declined.get(key) ?? 0) > now())) return { refused: "declined" };
        if (asking) return { refused: "needs-approval" };
        if (!canAsk()) return { refused: "no-window" };
        ask(name, found.wanted, found.entry);
        return { refused: "needs-approval" };
      }
      return found.wanted.kind === "url" ? reach(found.wanted.port, started) : run(found.entry, started);
    },
    close() {
      generation += 1;
      for (const socket of live) socket.destroy();
    },
  };
}
