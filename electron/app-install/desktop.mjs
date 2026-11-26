// An installed app's icon on the person's Desktop: on macOS a second copy of its small launcher bundle, on Windows a
// second shortcut, on Linux a second, executable desktop entry. Each carries the same id marker as the launcher.
//
// Security invariants: the Desktop folder is never created, and nothing is written outside it; an item is replaced
// only when it is this app's own (the installer's `chooseName` and `ownedBy`).
import { desktopEntry } from "./launchers.mjs";

const STAGING = /^\.mausbot-[0-9a-f]{16}\.staging$/;

export const isDesktopFile = (file) => file?.desktop === true;

/**
 * `desktop`: the folder Electron names (`app.getPath("desktop")`, which follows an iCloud Drive or OneDrive redirection).
 * On Linux the folder is `xdg-user-dir DESKTOP`, else ~/Desktop. `ctx` is the installer's own: `chooseName`,
 * `placeMacBundle`, `writeShortcut`, `readBytes`.
 */
export function createDesktopItems({ platform, path, fs, home, run, desktop, executable, log }, ctx) {
  async function xdgDesktop() {
    if (!run) return null;
    try {
      const result = await run("xdg-user-dir", ["DESKTOP"]);
      const out = result?.code === 0 ? String(result.stdout ?? "").trim() : "";
      // xdg-user-dir prints $HOME itself when no Desktop folder is set.
      return out && !out.includes("\n") && path.isAbsolute(out) && path.resolve(out) !== path.resolve(home) ? out : null;
    } catch {
      return null;
    }
  }

  /** The Desktop folder when it exists as a folder, else null. */
  async function folder() {
    const dir = platform === "linux" ? (await xdgDesktop()) ?? (home ? path.join(home, "Desktop") : null) : desktop || null;
    if (!dir || !path.isAbsolute(dir) || (home && path.resolve(dir) === path.resolve(home))) return null;
    try { return (await fs.stat(dir)).isDirectory() ? path.resolve(dir) : null; } catch { return null; }
  }

  /** Writes the app's Desktop item into `dir` from its installed `entry`; null when every name is taken. */
  async function write(manifest, id, entry, dir) {
    const icon = entry.files?.find((f) => f.kind === "icon")?.path;
    if (platform === "darwin") {
      const launcher = entry.files?.find((f) => f.kind === "bundle" && !isDesktopFile(f))?.path;
      const icns = launcher ? await ctx.readBytes(path.join(launcher, "Contents", "Resources", "AppIcon.icns")) : null;
      const chosen = await ctx.chooseName(manifest, id, dir, entry.name, ".app", "bundle");
      if (!chosen) return null;
      const bundle = await ctx.placeMacBundle(id, dir, chosen, async (out) => {
        if (!icns) return false;
        await fs.writeFile(out, icns);
        return true;
      });
      return bundle ? { path: bundle, kind: "bundle", desktop: true } : null;
    }
    if (platform === "win32") {
      const written = await ctx.writeShortcut(manifest, id, dir, entry.name, icon, { create: false });
      return written ? { ...written.file, desktop: true } : null;
    }
    const chosen = await ctx.chooseName(manifest, id, dir, entry.name, ".desktop", "desktop-entry");
    if (!chosen) return null;
    const file = path.join(dir, `${chosen}.desktop`);
    await fs.writeFile(file, desktopEntry({ id, name: entry.name, executable, iconPath: icon }), { mode: 0o755 });
    await fs.chmod?.(file, 0o755);
    return { path: file, kind: "desktop-entry", desktop: true };
  }

  /** Leftover staging folders of a Desktop bundle that was being written when MausBot stopped. */
  async function sweep(dir) {
    if (platform !== "darwin" || !dir) return;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (STAGING.test(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch((error) => log(`[app-install] left ${name}: ${error?.message ?? error}`));
    }
  }

  return { folder, write, sweep };
}
