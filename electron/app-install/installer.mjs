// Installs a saved app as a launcher of its own on this computer: a bundle in ~/Applications/MausBot Apps on macOS, a
// Start menu shortcut in "MausBot Apps" on Windows, a desktop entry in ~/.local/share/applications on Linux. Each one
// opens openmausbot://app/<id> in MausBot.
//
// Security invariants: nothing is written outside those folders, this app's own data folder and, on Linux, its icon
// folder; an existing file is replaced or removed only when it names the same app id inside it (a bundle's Info.plist,
// a desktop entry's key, a shortcut's argument), so a launcher the person made or renamed into place is never touched.
import { firstFreeName, launcherName, nameKey, validAppId, appKey, appLink, FOLDER_NAME } from "./names.mjs";
import { MAC_ICONSET, icoFromPng, letterTilePng, pngSize } from "./icons.mjs";
import {
  MAC_EXECUTABLE, MAC_ICON, desktopEntry, desktopEntryAppId, macInfoPlist, macLauncherScript, macPlistAppId, windowsShortcut,
} from "./launchers.mjs";

const MANIFEST = "installed.json";

/**
 * `platform`, `path` (the platform's flavour), `home`, `userData` (this app's data folder), `appData` (Windows roaming
 * folder) and `desktop` (Windows desktop folder), `dataHome` (Linux XDG data folder), `executable` (MausBot's own
 * executable or AppImage), `hostBundleId` (MausBot's macOS bundle id), `enabled` (false in an unpackaged build), and the
 * effects: `fs` (node:fs/promises shape), `run(file, args)` resolving `{ code }`, `shell` (Electron's: `trashItem`,
 * `writeShortcutLink`, `readShortcutLink`), `resizePng(png, side)` returning a PNG or null, `log(line)`.
 */
export function createAppInstaller(options) {
  const { platform, path, home, userData, fs, run = null, shell = {}, resizePng = null, log = () => {} } = options;
  const enabled = options.enabled !== false && ["darwin", "win32", "linux"].includes(platform) && Boolean(home && userData && path)
    && (platform !== "win32" || (Boolean(options.appData) && typeof shell.writeShortcutLink === "function"))
    && (platform === "darwin" || Boolean(options.executable));
  const stateDir = path.join(userData, "app-install");
  const manifestFile = path.join(stateDir, MANIFEST);
  const dataHome = options.dataHome || path.join(home ?? "", ".local", "share");
  const roots = {
    darwin: { launchers: path.join(home ?? "", "Applications", FOLDER_NAME) },
    win32: { launchers: path.join(options.appData ?? "", "Microsoft", "Windows", "Start Menu", "Programs", FOLDER_NAME), desktop: options.desktop || null },
    linux: { launchers: path.join(dataHome, "applications"), icons: path.join(dataHome, "icons", "mausbot-apps") },
  }[platform] ?? {};

  const childOf = (dir, file) => {
    if (!dir) return false;
    const rel = path.relative(dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
  };
  const allowed = (file) => Object.values(roots).some((dir) => childOf(dir, file)) || childOf(path.join(stateDir, "icons"), file);

  const lstat = async (file) => { try { return await fs.lstat(file); } catch { return null; } };
  const readText = async (file) => { try { return String(await fs.readFile(file, "utf8")); } catch { return null; } };

  async function readManifest() {
    const text = await readText(manifestFile);
    if (text === null) return { version: 1, apps: {} };
    try {
      const parsed = JSON.parse(text);
      if (parsed?.version === 1 && parsed.apps && typeof parsed.apps === "object") return parsed;
    } catch {}
    log("[app-install] the list of installed launchers was unreadable; starting it again");
    return { version: 1, apps: {} };
  }
  async function writeManifest(manifest) {
    await fs.mkdir(stateDir, { recursive: true });
    const temp = `${manifestFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2));
    await fs.rename(temp, manifestFile);
  }

  /** Whether `file` is a launcher this installer wrote for `id`: the id is inside it, and it is no symbolic link. */
  async function ownedBy(id, file, kind) {
    const stat = await lstat(file);
    if (!stat || stat.isSymbolicLink()) return false;
    if (kind === "bundle") return stat.isDirectory() && macPlistAppId(await readText(path.join(file, "Contents", "Info.plist"))) === id;
    if (kind === "desktop-entry") return stat.isFile() && desktopEntryAppId(await readText(file)) === id;
    if (kind === "shortcut") {
      try { return stat.isFile() && String(shell.readShortcutLink?.(file)?.args ?? "").trim() === appLink(id); } catch { return false; }
    }
    if (kind === "icon") return stat.isFile() && path.basename(file).includes(appKey(id));
    return false;
  }

  /** The first free `<name><ext>` in `dir`: absent, or already this app's own launcher; another app's chosen name is
   * skipped even where the file system tells case or Unicode form apart. */
  function chooseName(manifest, id, dir, base, ext, kind) {
    const others = new Set(Object.entries(manifest.apps).filter(([other]) => other !== id)
      .flatMap(([, entry]) => (entry.files ?? []).filter((f) => f.kind === kind).map((f) => nameKey(path.basename(f.path)))));
    return firstFreeName(base, async (candidate) => {
      const file = path.join(dir, `${candidate}${ext}`);
      if (others.has(nameKey(`${candidate}${ext}`))) return false;
      return !(await lstat(file)) || ownedBy(id, file, kind);
    });
  }

  async function removeOwned(id, file) {
    if (!allowed(file.path)) { log(`[app-install] left ${file.path}: outside the launcher folders`); return false; }
    if (!(await lstat(file.path))) return true;
    if (!(await ownedBy(id, file.path, file.kind))) { log(`[app-install] left ${file.path}: not a launcher this app wrote for ${id}`); return false; }
    if (file.kind === "bundle" && typeof shell.trashItem === "function") {
      try { await shell.trashItem(file.path); return true; } catch {}
    }
    await fs.rm(file.path, { recursive: file.kind === "bundle", force: true });
    return true;
  }

  function iconSource(id, name, iconPng, side) {
    if (pngSize(iconPng)) return Buffer.from(iconPng.buffer, iconPng.byteOffset, iconPng.byteLength);
    return letterTilePng({ id, name, size: side });
  }

  async function squareIcon(png, side) {
    if (!resizePng) return png;
    try { const out = await resizePng(png, side); return pngSize(out) ? Buffer.from(out) : png; } catch { return png; }
  }

  /** sips and iconutil ship with every macOS; when either fails the bundle simply has no icon of its own. */
  async function macIcon(id, png, out) {
    if (!run) return false;
    const work = path.join(stateDir, "work", appKey(id));
    const iconset = path.join(work, "icon.iconset");
    try {
      await fs.rm(work, { recursive: true, force: true });
      await fs.mkdir(iconset, { recursive: true });
      const source = path.join(work, "source.png");
      await fs.writeFile(source, png);
      for (const { file, px } of MAC_ICONSET) {
        const result = await run("/usr/bin/sips", ["-z", String(px), String(px), source, "--out", path.join(iconset, file)]);
        if (result?.code !== 0) return false;
      }
      const result = await run("/usr/bin/iconutil", ["-c", "icns", "-o", out, iconset]);
      return result?.code === 0 && Boolean(await lstat(out));
    } catch (error) {
      log(`[app-install] no icon for ${id}: ${error?.message ?? error}`);
      return false;
    } finally {
      await fs.rm(path.dirname(work), { recursive: true, force: true }).catch(() => {});
    }
  }

  async function installMac(manifest, { id, name, iconPng }) {
    const dir = roots.launchers;
    await fs.mkdir(dir, { recursive: true });
    const chosen = await chooseName(manifest, id, dir, name, ".app", "bundle");
    if (!chosen) return { error: "taken" };
    const bundle = path.join(dir, `${chosen}.app`);
    const staging = path.join(dir, `.mausbot-${appKey(id)}.staging`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(path.join(staging, "Contents", "MacOS"), { recursive: true });
    await fs.mkdir(path.join(staging, "Contents", "Resources"), { recursive: true });
    const icon = await macIcon(id, iconSource(id, name, iconPng, 1024), path.join(staging, "Contents", "Resources", `${MAC_ICON}.icns`));
    await fs.writeFile(path.join(staging, "Contents", "Info.plist"), macInfoPlist({ id, name: chosen, hostBundleId: options.hostBundleId, icon }));
    await fs.writeFile(path.join(staging, "Contents", "PkgInfo"), "APPL????");
    await fs.writeFile(path.join(staging, "Contents", "MacOS", MAC_EXECUTABLE), macLauncherScript({ id, hostBundleId: options.hostBundleId }), { mode: 0o755 });
    await fs.chmod?.(path.join(staging, "Contents", "MacOS", MAC_EXECUTABLE), 0o755);
    if (await lstat(bundle)) {
      if (!(await ownedBy(id, bundle, "bundle"))) { await fs.rm(staging, { recursive: true, force: true }); return { error: "taken" }; }
      await fs.rm(bundle, { recursive: true, force: true });
    }
    await fs.rename(staging, bundle);
    return { name: chosen, files: [{ path: bundle, kind: "bundle" }] };
  }

  async function writeShortcut(manifest, id, dir, name, iconPath) {
    await fs.mkdir(dir, { recursive: true });
    const chosen = await chooseName(manifest, id, dir, name, ".lnk", "shortcut");
    if (!chosen) return null;
    const file = path.join(dir, `${chosen}.lnk`);
    const exists = Boolean(await lstat(file));
    if (!shell.writeShortcutLink(file, exists ? "replace" : "create", windowsShortcut({ id, name: chosen, executable: options.executable, iconPath }))) {
      throw new Error(`Windows did not write ${file}`);
    }
    return { name: chosen, file: { path: file, kind: "shortcut" } };
  }

  async function installWindows(manifest, { id, name, iconPng, desktopShortcut }) {
    const iconDir = path.join(stateDir, "icons");
    await fs.mkdir(iconDir, { recursive: true });
    const iconPath = path.join(iconDir, `${appKey(id)}.ico`);
    let icon = null;
    try {
      await fs.writeFile(iconPath, icoFromPng(await squareIcon(iconSource(id, name, iconPng, 256), 256)));
      icon = { path: iconPath, kind: "icon" };
    } catch (error) { log(`[app-install] no icon for ${id}: ${error?.message ?? error}`); }
    const start = await writeShortcut(manifest, id, roots.launchers, name, icon?.path);
    if (!start) return { error: "taken" };
    const files = [start.file, ...(icon ? [icon] : [])];
    if (desktopShortcut === true && roots.desktop) {
      const onDesktop = await writeShortcut(manifest, id, roots.desktop, name, icon?.path);
      if (onDesktop) files.push(onDesktop.file);
    }
    return { name: start.name, files };
  }

  async function installLinux(manifest, { id, name, iconPng }) {
    await fs.mkdir(roots.launchers, { recursive: true });
    const file = path.join(roots.launchers, `mausbot-app-${id}.desktop`);
    if ((await lstat(file)) && !(await ownedBy(id, file, "desktop-entry"))) return { error: "taken" };
    let icon = null;
    try {
      await fs.mkdir(roots.icons, { recursive: true });
      const iconPath = path.join(roots.icons, `mausbot-app-${appKey(id)}.png`);
      await fs.writeFile(iconPath, await squareIcon(iconSource(id, name, iconPng, 256), 256));
      icon = { path: iconPath, kind: "icon" };
    } catch (error) { log(`[app-install] no icon for ${id}: ${error?.message ?? error}`); }
    await fs.writeFile(file, desktopEntry({ id, name, executable: options.executable, iconPath: icon?.path }), { mode: 0o644 });
    return { name, files: [{ path: file, kind: "desktop-entry" }, ...(icon ? [icon] : [])] };
  }

  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };

  const launcherOf = (entry) => entry.files?.find((f) => f.kind !== "icon")?.path ?? null;
  const view = (id, entry) => ({ id, name: entry.name, path: launcherOf(entry) });

  async function present(manifest) {
    const out = [];
    for (const [id, entry] of Object.entries(manifest.apps)) {
      const launcher = entry.files?.find((f) => f.kind !== "icon");
      if (launcher && (await ownedBy(id, launcher.path, launcher.kind))) out.push(view(id, entry));
    }
    return out;
  }

  async function uninstallLocked(manifest, id) {
    const entry = manifest.apps[id];
    if (!entry) return { ok: true, removed: false };
    const left = [];
    for (const file of entry.files ?? []) if (!(await removeOwned(id, file).catch(() => false))) left.push(file.path);
    delete manifest.apps[id];
    await writeManifest(manifest);
    return { ok: true, removed: true, ...(left.length ? { left } : {}) };
  }

  return {
    available: () => enabled,

    /** `{ id, name, iconPng?, desktopShortcut? }` → `{ ok: true, app: { id, name, path } }` or `{ ok: false, reason }`
     * with reason "unavailable", "invalid-id", "taken" or "failed". Installing again replaces the launcher; a new name
     * writes the new one and then removes the old. */
    installApp: (input) => serial(async () => {
      if (!enabled) return { ok: false, reason: "unavailable" };
      const id = input?.id;
      if (!validAppId(id)) return { ok: false, reason: "invalid-id" };
      const name = launcherName(input?.name);
      const iconPng = input?.iconPng instanceof Uint8Array ? input.iconPng : null;
      const manifest = await readManifest();
      const previous = manifest.apps[id];
      let written;
      try {
        const request = { id, name, iconPng, desktopShortcut: input?.desktopShortcut === true };
        written = platform === "darwin" ? await installMac(manifest, request)
          : platform === "win32" ? await installWindows(manifest, request) : await installLinux(manifest, request);
      } catch (error) {
        log(`[app-install] could not install ${id}: ${error?.message ?? error}`);
        return { ok: false, reason: "failed" };
      }
      if (written.error) return { ok: false, reason: written.error };
      const kept = new Set(written.files.map((f) => nameKey(f.path)));
      for (const file of previous?.files ?? []) if (!kept.has(nameKey(file.path))) await removeOwned(id, file).catch(() => false);
      manifest.apps[id] = { name: written.name, files: written.files, ...(options.executable ? { target: options.executable } : {}) };
      await writeManifest(manifest);
      return { ok: true, app: view(id, manifest.apps[id]) };
    }),

    /** Removes only this app's own launcher files; on macOS the bundle goes to the Trash when it can. */
    uninstallApp: (id) => serial(async () => {
      if (!validAppId(id)) return { ok: false, reason: "invalid-id" };
      return uninstallLocked(await readManifest(), id);
    }),

    /** The launchers still on disk as this app wrote them, `{ id, name, path }` each. */
    installedApps: () => serial(async () => (enabled ? present(await readManifest()) : [])),

    isInstalled: (id) => serial(async () => {
      if (!enabled || !validAppId(id)) return false;
      const entry = (await readManifest()).apps[id];
      const launcher = entry?.files?.find((f) => f.kind !== "icon");
      return Boolean(launcher && (await ownedBy(id, launcher.path, launcher.kind)));
    }),

    /** Removes the launchers of apps that no longer exist (`ids`: every saved app's id, an array; anything else, such as
     * a failed fetch of the list, removes nothing), and leftover work folders. */
    cleanup: (ids) => serial(async () => {
      if (!Array.isArray(ids)) return [];
      const keep = new Set(ids);
      const manifest = await readManifest();
      const removed = [];
      for (const id of Object.keys(manifest.apps)) {
        if (keep.has(id)) continue;
        await uninstallLocked(manifest, id);
        removed.push(id);
      }
      await fs.rm(path.join(stateDir, "work"), { recursive: true, force: true }).catch(() => {});
      if (platform === "darwin" && roots.launchers) {
        const names = await fs.readdir(roots.launchers).catch(() => []);
        for (const name of names) {
          if (/^\.mausbot-[0-9a-f]{16}\.staging$/.test(name)) await fs.rm(path.join(roots.launchers, name), { recursive: true, force: true }).catch(() => {});
        }
      }
      return removed;
    }),

    /** Windows and Linux launchers name MausBot's executable: after it moved (a new AppImage, another install folder)
     * each one is written again with the current one. */
    refreshTargets: () => serial(async () => {
      if (!enabled || platform === "darwin") return [];
      const manifest = await readManifest();
      const refreshed = [];
      for (const [id, entry] of Object.entries(manifest.apps)) {
        if (entry.target === options.executable) continue;
        const icon = entry.files.find((f) => f.kind === "icon")?.path;
        for (const file of entry.files) {
          if (file.kind === "icon" || !allowed(file.path) || !(await ownedBy(id, file.path, file.kind))) continue;
          if (file.kind === "desktop-entry") await fs.writeFile(file.path, desktopEntry({ id, name: entry.name, executable: options.executable, iconPath: icon }), { mode: 0o644 });
          else shell.writeShortcutLink(file.path, "replace", windowsShortcut({ id, name: entry.name, executable: options.executable, iconPath: icon }));
        }
        entry.target = options.executable;
        refreshed.push(id);
      }
      if (refreshed.length) await writeManifest(manifest);
      return refreshed;
    }),
  };
}
