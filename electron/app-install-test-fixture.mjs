// The installer's tests share these: an in-memory file system in either path flavour and an installer for each platform
// with its folders and effects faked.
import path from "node:path";
import { createAppInstaller } from "./app-install/installer.mjs";
import { letterTilePng } from "./app-install/icons.mjs";

/** A saved app's id from a short name: `la_` and 16 characters, as the store makes them. */
export const L = (short) => `la_${short.padEnd(16, "0")}`;

export function memoryFs(flavour) {
  const entries = new Map();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const children = (p) => [...entries.keys()].filter((k) => k.startsWith(p.endsWith(flavour.sep) ? p : p + flavour.sep));
  const stat = (e) => ({ isDirectory: () => e.type === "dir", isFile: () => e.type === "file", isSymbolicLink: () => e.type === "link", mode: e.mode });
  const parentReady = (p) => { if (entries.get(flavour.dirname(p))?.type !== "dir") throw missing(flavour.dirname(p)); };
  const readOnly = new Set();
  const writable = (p) => { if (readOnly.has(flavour.dirname(p))) throw Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" }); };
  const fs = {
    entries,
    readOnly,
    async mkdir(p, { recursive } = {}) {
      const chain = [];
      for (let at = p; !entries.has(at); at = flavour.dirname(at)) { chain.unshift(at); if (flavour.dirname(at) === at) break; }
      if (!recursive && chain.length > 1) throw missing(p);
      if (!recursive && !chain.length) throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
      for (const dir of chain) { writable(dir); entries.set(dir, { type: "dir" }); }
    },
    async writeFile(p, data, opts) {
      parentReady(p);
      writable(p);
      if (entries.get(p)?.type === "dir") throw new Error(`EISDIR: ${p}`);
      entries.set(p, { type: "file", data: Buffer.from(data), mode: opts?.mode ?? 0o644 });
    },
    async readFile(p, encoding) {
      const e = entries.get(p);
      if (e?.type !== "file") throw missing(p);
      return encoding ? e.data.toString(encoding) : e.data;
    },
    async rm(p, { recursive, force } = {}) {
      if (!entries.has(p)) { if (force) return; throw missing(p); }
      if (entries.get(p).type === "dir" && children(p).length && !recursive) throw new Error(`ENOTEMPTY: ${p}`);
      for (const k of children(p)) entries.delete(k);
      entries.delete(p);
    },
    async rename(a, b) {
      if (!entries.has(a)) throw missing(a);
      parentReady(b);
      writable(b);
      const moved = [[a, entries.get(a)], ...children(a).map((k) => [k, entries.get(k)])];
      for (const [k] of moved) entries.delete(k);
      for (const [k, v] of moved) entries.set(b + k.slice(a.length), v);
    },
    async lstat(p) { const e = entries.get(p); if (!e) throw missing(p); return stat(e); },
    async stat(p) { const e = entries.get(p); if (!e) throw missing(p); return stat(e); },
    async readdir(p) { return children(p).filter((k) => flavour.dirname(k) === p).map((k) => flavour.basename(k)); },
    async chmod(p, mode) { const e = entries.get(p); if (!e) throw missing(p); e.mode = mode; },
    text: (p) => entries.get(p)?.data?.toString("utf8"),
    files: () => [...entries].filter(([, e]) => e.type !== "dir").map(([k]) => k),
  };
  return fs;
}

export const PNG = letterTilePng({ id: L("seed"), name: "Seed", size: 64 });

/** `desktop`: the Desktop folder Electron names; `makeDesktop`: whether it exists. */
export function mac({ runOk = true, trash = true, enabled = true, desktop = "/Users/u/Desktop", makeDesktop = false } = {}) {
  const fs = memoryFs(path.posix);
  if (makeDesktop) fs.entries.set(desktop, { type: "dir" });
  const calls = [];
  const trashed = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (!runOk) return { code: 1 };
    const out = file.endsWith("sips") ? args[args.indexOf("--out") + 1] : args[args.indexOf("-o") + 1];
    await fs.writeFile(out, file.endsWith("sips") ? PNG : Buffer.from("icns"));
    return { code: 0 };
  };
  const shell = trash ? { trashItem: async (p) => { trashed.push(p); await fs.rm(p, { recursive: true }); } } : {};
  const options = { platform: "darwin", path: path.posix, home: "/Users/u", userData: "/Users/u/Library/Application Support/OpenMausBot", desktop, fs, run, shell, hostBundleId: "com.openmausbot.app", enabled };
  return { fs, calls, trashed, options, installer: createAppInstaller(options), dir: "/Users/u/Applications/MausBot Apps", desktop };
}

export function windows({ executable = "C:\\Users\\u\\AppData\\Local\\Programs\\OpenMausBot\\OpenMausBot.exe", desktop = "C:\\Users\\u\\Desktop", makeDesktop = false } = {}) {
  const fs = memoryFs(path.win32);
  if (makeDesktop) fs.entries.set(desktop, { type: "dir" });
  const shortcuts = [];
  const shell = {
    writeShortcutLink(file, operation, options) {
      if (fs.entries.get(path.win32.dirname(file))?.type !== "dir" || fs.readOnly.has(path.win32.dirname(file))) return false;
      shortcuts.push([file, operation, options]);
      fs.entries.set(file, { type: "file", data: Buffer.from(JSON.stringify(options)) });
      return true;
    },
    readShortcutLink(file) { return JSON.parse(fs.text(file)); },
  };
  const options = { platform: "win32", path: path.win32, home: "C:\\Users\\u", userData: "C:\\Users\\u\\AppData\\Roaming\\OpenMausBot", appData: "C:\\Users\\u\\AppData\\Roaming", desktop, fs, shell, executable, resizePng: async (png) => png };
  return { fs, shortcuts, options, installer: createAppInstaller(options), dir: "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MausBot Apps", desktop };
}

/** `xdg`: what `xdg-user-dir DESKTOP` prints (null: it is not installed); `makeDesktop`: the folder that exists. */
export function linux({ executable = "/home/u/Apps/OpenMausBot.AppImage", xdg = null, makeDesktop = null } = {}) {
  const fs = memoryFs(path.posix);
  if (makeDesktop) fs.entries.set(makeDesktop, { type: "dir" });
  const runs = [];
  const run = async (file, args) => {
    runs.push([file, ...args]);
    return xdg === null ? { code: 127, stdout: "" } : { code: 0, stdout: `${xdg}\n` };
  };
  const options = { platform: "linux", path: path.posix, home: "/home/u", userData: "/home/u/.config/OpenMausBot", fs, run, executable };
  return { fs, runs, options, installer: createAppInstaller(options), dir: "/home/u/.local/share/applications" };
}
