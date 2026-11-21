// What a launch pays outside our own code, for the launch record: each program a process starts (a fixed name and how
// long it ran) and each request to anything but this computer (the kind of host and how long it took). Plain ESM so the
// main process and the server count the same way. Privacy: a command line, a path, an address or a response never
// leaves here; a program outside PROGRAMS is "other", a host is one of four kinds.
import path from "node:path";
import { promisify } from "node:util";

const PROGRAMS = new Set([
  "sysctl", "ioreg", "scutil", "codesign", "spctl", "security", "open", "defaults", "osascript", "ps", "lsof", "launchctl", "sw_vers", "which", "where",
  "reg", "wmic", "powershell", "cmd", "tasklist", "xdg-mime", "xdg-settings", "gsettings", "dbus-send", "loginctl", "getent", "id",
  "cua-driver", "cloudflared", "tailscale", "git", "node", "claude", "codex", "opencode", "grok", "gemini", "pi", "cursor-agent",
]);
const STARTERS = /^(?:spawn|exec|execFile|fork)(?:Sync)?$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
/** A launch that starts this many programs or requests is no longer being measured. */
const KEPT = 200;

/** The name a started program is kept under: its file name without folder or extension when it is a known one.
 * `shell`: the command is a whole command line (exec), whose first word is the program. */
export function programName(command, { shell = false } = {}) {
  if (typeof command !== "string") return "other";
  const file = shell ? command.trim().split(/\s+/)[0] ?? "" : command;
  const base = path.win32.basename(file).toLowerCase().replace(/\.(?:exe|cmd|bat|sh|js|mjs|ts)$/, "");
  return PROGRAMS.has(base) ? base : "other";
}

/** The kind of host a request went to; null for this computer. */
export function hostKind(target) {
  let host;
  try { host = new URL(typeof target === "string" ? target : target?.url ?? String(target)).hostname.toLowerCase(); } catch { return "other"; }
  if (LOOPBACK.has(host)) return null;
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com")) return "updates";
  if (host === "accounts.openmausbot.com") return "accounts";
  if (host.endsWith(".openmausbot.com") || host.endsWith(".mausbot.cloud") || host.endsWith(".fly.dev")) return "cloud";
  return "other";
}

/**
 * Counts until `finish()`, which puts everything back and returns the counts. `childProcess` is node:child_process's
 * default export and `sync` node:module's syncBuiltinESMExports, so named imports of it see the wrappers too. Nothing a
 * wrapper does can change or fail the call it wraps.
 * @param {{ childProcess?: Record<string, any>, sync?: () => void, fetchOwners?: Array<Record<string, any>>, now?: () => number }} deps
 */
export function watchLaunchWork({ childProcess, sync = () => {}, fetchOwners = [], now = () => performance.now() } = {}) {
  const children = [];
  const net = {};
  const restore = [];
  let open = true;
  const child = (command, ms, shell = false) => { if (open && children.length < KEPT) children.push({ name: programName(command, { shell }), ms: Math.max(0, ms) }); };
  const request = (kind, ms) => {
    if (!open || !kind) return;
    const entry = (net[kind] ??= { n: 0, ms: 0 });
    entry.n += 1; entry.ms += Math.max(0, ms);
  };
  const quietly = (work) => { try { work(); } catch {} };
  const whenOver = (command, at, started, shell) => quietly(() => {
    const over = () => child(command, now() - at, shell);
    if (typeof started?.once === "function") started.once("exit", over);
    else if (typeof started?.then === "function") started.then(over, over);
  });

  if (childProcess) {
    for (const name of Object.keys(childProcess)) {
      const original = childProcess[name];
      if (typeof original !== "function" || !STARTERS.test(name)) continue;
      const blocking = name.endsWith("Sync");
      const shell = name.startsWith("exec") && !name.startsWith("execFile");
      const wrapper = function (...args) {
        const at = now();
        let started;
        try { started = original.apply(this, args); return started; } finally {
          if (blocking) child(args[0], now() - at, shell); else whenOver(args[0], at, started, shell);
        }
      };
      quietly(() => Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original)));
      const promised = original[promisify.custom];
      if (typeof promised === "function") {
        quietly(() => Object.defineProperty(wrapper, promisify.custom, { configurable: true, value(...args) {
          const at = now();
          const pending = promised.apply(this, args);
          whenOver(args[0], at, pending, shell);
          return pending;
        } }));
      }
      childProcess[name] = wrapper;
      restore.push(() => { if (childProcess[name] === wrapper) childProcess[name] = original; });
    }
    quietly(sync);
  }
  for (const owner of fetchOwners) {
    const original = owner?.fetch;
    if (typeof original !== "function") continue;
    const wrapper = function (...args) {
      const at = now();
      const pending = original.apply(this, args);
      quietly(() => { const kind = hostKind(args[0]); if (kind) pending.then(() => request(kind, now() - at), () => request(kind, now() - at)); });
      return pending;
    };
    try { owner.fetch = wrapper; } catch { continue; }
    restore.push(() => { if (owner.fetch === wrapper) owner.fetch = original; });
  }

  const counts = () => ({
    children: children.map((entry) => ({ ...entry, ms: Math.round(entry.ms) })),
    net: Object.fromEntries(Object.entries(net).map(([kind, entry]) => [kind, { n: entry.n, ms: Math.round(entry.ms) }])),
  });
  return {
    /** A program or request timed by the caller itself. */
    child,
    request,
    counts,
    finish() {
      if (open) { for (const undo of restore.splice(0)) quietly(undo); quietly(sync); }
      open = false;
      return counts();
    },
  };
}
