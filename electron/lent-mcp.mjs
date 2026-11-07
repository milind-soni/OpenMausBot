// What this computer's MCP door builds on: its own ports, how a lent command starts and ends here, and what a person's
// Allow of one covers.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromeDataDirs, DEVTOOLS_FILE, parseDevtoolsActivePort } from "./device-chrome.mjs";
import { DESKTOP_PORTS } from "./desktop-ports.mjs";

/** What a job from a My Cloud too old for the link hears. */
export const MCP_JOBS_MOVED = "This computer runs MCP servers for My Cloud only through its link now; this My Cloud is too old to use it. It works once My Cloud updates.";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** What a lent server inherits from this app: where things live, never a key. */
const INHERITED = ["HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TEMP", "TMP", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "APPDATA", "LOCALAPPDATA", "ProgramData"];
export const inheritedEnvironment = (env = process.env) => Object.fromEntries(INHERITED.filter(key => env[key]).map(key => [key, env[key]]));

/** What a person's Allow of a command server covers: its command, args and env, values included, so any change asks
 * again. */
export const commandFingerprint = ({ command, args, env }) => createHash("sha256").update(JSON.stringify([command, args, Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])).digest("hex");

/** This computer's own ports: its OpenMausBot servers', and Chrome's DevTools port while Chrome is running. Security:
 * each takes commands from any local caller, so a lent MCP server is never reached on one. */
export async function ownPorts({ serverPorts = [], dirs = chromeDataDirs({ platform: process.platform, home: os.homedir(), localAppData: process.env.LOCALAPPDATA }), readFile = fs.promises.readFile } = {}) {
  const chrome = await Promise.all(dirs.map(dir => readFile(path.join(dir, DEVTOOLS_FILE), "utf8").then(parseDevtoolsActivePort, () => null)));
  return [...DESKTOP_PORTS, ...serverPorts, ...chrome.flatMap(found => (found ? [found.port] : []))];
}

/** This computer's own OpenMausBot installs, by the environment id each keeps in its data folder. */
export function ownEnvironmentIds(dataDirs) {
  const ids = new Set();
  for (const dir of dataDirs) {
    if (typeof dir !== "string" || !dir) continue;
    try {
      const id = fs.readFileSync(path.join(dir, "environment-id"), "utf8").trim();
      if (UUID.test(id)) ids.add(id.toLowerCase());
    } catch {}
  }
  return [...ids].slice(0, 8);
}

/** How Windows starts `command`: a program directly, found on PATH with PATHEXT as Windows finds it, and a .cmd or .bat
 * shim (npx.cmd, uvx.cmd) through cmd.exe, which alone runs one, each word quoted for it. Null when it isn't there. */
export function windowsLaunch(command, args, env, exists = fs.existsSync) {
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => extension.toLowerCase());
  const names = path.win32.extname(command) ? [command] : extensions.map(extension => `${command}${extension}`);
  const dirs = /[\\/]/.test(command) ? [""] : (env.PATH || env.Path || "").split(";").filter(Boolean);
  const file = dirs.flatMap(dir => names.map(name => (dir ? path.win32.join(dir, name) : name))).find(candidate => exists(candidate));
  if (!file) return null;
  if (!/\.(?:cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  const line = [file, ...args].map(word => `"${word.replace(/"/g, '""')}"`).join(" ");
  return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export function killTree(child, { platform = process.platform, spawn: start = spawn } = {}) {
  if (!child.pid) return;
  if (platform === "win32") {
    // Security: once a child has exited Windows may give its PID to another process, and taskkill /T /F would end that tree.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = start("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
