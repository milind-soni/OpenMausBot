import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createAppInstaller } from "./app-install/installer.mjs";
import { icoFromPng, letterTilePng, pngSize, tileLetter } from "./app-install/icons.mjs";
import { installAppInstall } from "./app-install/ipc.mjs";
import { desktopEntry, macInfoPlist, macLauncherScript, macPlistAppId, windowsShortcut, windowsWindowDetails } from "./app-install/launchers.mjs";
import { appIdFromCommandLine, appIdFromLink, launcherBundleId, launcherName, validAppId, windowsAppUserModelId } from "./app-install/names.mjs";

function memoryFs(flavour) {
  const entries = new Map();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const children = (p) => [...entries.keys()].filter((k) => k.startsWith(p.endsWith(flavour.sep) ? p : p + flavour.sep));
  const stat = (e) => ({ isDirectory: () => e.type === "dir", isFile: () => e.type === "file", isSymbolicLink: () => e.type === "link", mode: e.mode });
  const parentReady = (p) => { if (entries.get(flavour.dirname(p))?.type !== "dir") throw missing(flavour.dirname(p)); };
  const fs = {
    entries,
    async mkdir(p, { recursive } = {}) {
      const chain = [];
      for (let at = p; !entries.has(at); at = flavour.dirname(at)) { chain.unshift(at); if (flavour.dirname(at) === at) break; }
      if (!recursive && chain.length > 1) throw missing(p);
      for (const dir of chain) entries.set(dir, { type: "dir" });
    },
    async writeFile(p, data, opts) {
      parentReady(p);
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
      const moved = [[a, entries.get(a)], ...children(a).map((k) => [k, entries.get(k)])];
      for (const [k] of moved) entries.delete(k);
      for (const [k, v] of moved) entries.set(b + k.slice(a.length), v);
    },
    async lstat(p) { const e = entries.get(p); if (!e) throw missing(p); return stat(e); },
    async readdir(p) { return children(p).filter((k) => flavour.dirname(k) === p).map((k) => flavour.basename(k)); },
    async chmod(p, mode) { const e = entries.get(p); if (!e) throw missing(p); e.mode = mode; },
    text: (p) => entries.get(p)?.data?.toString("utf8"),
    files: () => [...entries].filter(([, e]) => e.type !== "dir").map(([k]) => k),
  };
  return fs;
}

const PNG = letterTilePng({ id: "seed", name: "Seed", size: 64 });

function mac({ runOk = true, trash = true, enabled = true } = {}) {
  const fs = memoryFs(path.posix);
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
  const installer = createAppInstaller({ platform: "darwin", path: path.posix, home: "/Users/u", userData: "/Users/u/Library/Application Support/OpenMausBot", fs, run, shell, hostBundleId: "com.openmausbot.app", enabled });
  return { fs, calls, trashed, installer, dir: "/Users/u/Applications/MausBot Apps" };
}

function windows({ executable = "C:\\Users\\u\\AppData\\Local\\Programs\\OpenMausBot\\OpenMausBot.exe" } = {}) {
  const fs = memoryFs(path.win32);
  const shortcuts = [];
  const shell = {
    writeShortcutLink(file, operation, options) {
      if (fs.entries.get(path.win32.dirname(file))?.type !== "dir") return false;
      shortcuts.push([file, operation, options]);
      fs.entries.set(file, { type: "file", data: Buffer.from(JSON.stringify(options)) });
      return true;
    },
    readShortcutLink(file) { return JSON.parse(fs.text(file)); },
  };
  const options = { platform: "win32", path: path.win32, home: "C:\\Users\\u", userData: "C:\\Users\\u\\AppData\\Roaming\\OpenMausBot", appData: "C:\\Users\\u\\AppData\\Roaming", desktop: "C:\\Users\\u\\Desktop", fs, shell, executable, resizePng: async (png) => png };
  return { fs, shortcuts, options, installer: createAppInstaller(options), dir: "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MausBot Apps" };
}

function linux({ executable = "/home/u/Apps/OpenMausBot.AppImage" } = {}) {
  const fs = memoryFs(path.posix);
  const options = { platform: "linux", path: path.posix, home: "/home/u", userData: "/home/u/.config/OpenMausBot", fs, executable };
  return { fs, options, installer: createAppInstaller(options), dir: "/home/u/.local/share/applications" };
}

test("launcher names are safe file names on macOS, Windows and Linux", () => {
  const table = [
    ["Notes", "Notes"],
    ["  Budget   2026  ", "Budget 2026"],
    ["a/b\\c:d*e?f\"g<h>i|j", "a b c d e f g h i j"],
    ["...hidden", "hidden"],
    ["trailing. . ", "trailing"],
    ["CON", "CON_"],
    ["con.txt", "con_.txt"],
    ["LPT9", "LPT9_"],
    ["COM¹", "COM¹_"],
    ["Console", "Console"],
    ["evil\u202Etxt.exe", "eviltxt.exe"],
    ["zero\u200Bwidth\u2066x\u2069", "zerowidthx"],
    ["line\nbreak\ttab\u0000", "line break tab"],
    ["Cafe\u0301", "Café"],
    ["مرحبا", "مرحبا"],
    ["", "App"],
    [null, "App"],
    ["\u202E\u200B", "App"],
    ["../../etc/passwd", "etc passwd"],
  ];
  for (const [raw, want] of table) assert.equal(launcherName(raw), want, JSON.stringify(raw));
  const long = launcherName("x".repeat(300));
  assert.equal([...long].length, 64);
  const emoji = launcherName("👩‍👩‍👧".repeat(100));
  assert.ok(Buffer.byteLength(emoji) <= 180 && emoji.length > 0);
  assert.equal(launcherName("é".repeat(100)).length, 64);
});

test("app ids and links: a strict alphabet, and the link parser takes nothing else", () => {
  for (const id of ["notes", "a1b2", "3f2b-77_x", "550e8400-e29b-41d4-a716-446655440000"]) assert.ok(validAppId(id), id);
  for (const id of ["", "-x", "a b", "a/b", "a.b", "a'b", "a\"b", "a$b", "a%b", "x".repeat(129), 5, null]) assert.equal(validAppId(id), false, String(id));
  assert.equal(appIdFromLink("openmausbot://app/notes"), "notes");
  assert.equal(appIdFromLink("OpenMausBot://app/notes/"), "notes");
  assert.equal(appIdFromLink("openmausbot://app/../x"), null);
  assert.equal(appIdFromLink("openmausbot://thread/notes"), null);
  assert.equal(appIdFromCommandLine(["exe", "--flag", "openmausbot://app/n1"]), "n1");
  assert.equal(appIdFromCommandLine(["exe"]), null);
  assert.match(launcherBundleId("notes"), /^com\.openmausbot\.app\.localapp\.[0-9a-f]{16}$/);
  assert.notEqual(launcherBundleId("notes"), launcherBundleId("notes2"));
  assert.equal(launcherBundleId("notes", "bad id;rm"), launcherBundleId("notes"));
  assert.equal(windowsAppUserModelId("notes"), launcherBundleId("notes"));
});

test("Info.plist names the app, a bundle id of its own, the id marker and no Dock tile; the script opens the link", () => {
  const plist = macInfoPlist({ id: "notes", name: "Tom & Jerry <3>" });
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\n {2}<string>Tom &amp; Jerry &lt;3&gt;<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\n {2}<string>launcher<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\n {2}<string>AppIcon<\/string>/);
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key>\\n {2}<string>${launcherBundleId("notes").replaceAll(".", "\\.")}</string>`));
  assert.match(plist, /<key>CFBundlePackageType<\/key>\n {2}<string>APPL<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\n {2}<true\/>/);
  assert.equal(macPlistAppId(plist), "notes");
  assert.doesNotMatch(macInfoPlist({ id: "notes", name: "N", icon: false }), /CFBundleIconFile/);
  assert.throws(() => macInfoPlist({ id: "x'y", name: "N" }));
  assert.equal(macLauncherScript({ id: "notes" }),
    "#!/bin/sh\n/usr/bin/open -b 'com.openmausbot.app' 'openmausbot://app/notes' 2>/dev/null || exec /usr/bin/open 'openmausbot://app/notes'\n");
  assert.match(macLauncherScript({ id: "notes", hostBundleId: "x'; rm -rf ~" }), /open -b 'com\.openmausbot\.app'/);
  assert.throws(() => macLauncherScript({ id: "a;b" }));
});

test("desktop entry and Windows shortcut carry the link, quoted executable and id marker", () => {
  const entry = desktopEntry({ id: "notes", name: "My\nNotes", executable: "/home/u/My Apps/100%$x\\y.AppImage", iconPath: "/home/u/.local/share/icons/mausbot-apps/i.png" });
  assert.match(entry, /^Name=My\\nNotes$/m);
  assert.match(entry, /^Exec="\/home\/u\/My Apps\/100%%\\\\\$x\\\\\\\\y\.AppImage" openmausbot:\/\/app\/notes$/m);
  assert.match(entry, /^Icon=\/home\/u\/\.local\/share\/icons\/mausbot-apps\/i\.png$/m);
  assert.match(entry, /^X-OpenMausBot-LocalApp=notes$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.deepEqual(windowsShortcut({ id: "notes", name: "Notes", executable: "C:\\P\\OpenMausBot.exe", iconPath: "C:\\i.ico" }), {
    target: "C:\\P\\OpenMausBot.exe", args: "openmausbot://app/notes", description: "Notes", icon: "C:\\i.ico", iconIndex: 0, appUserModelId: windowsAppUserModelId("notes"),
  });
  assert.equal(windowsWindowDetails({ id: "notes", name: "Notes", executable: "C:\\P\\O.exe" }).relaunchCommand, '"C:\\P\\O.exe" openmausbot://app/notes');
});

test("icons: PNG checks, a one-image .ico, and a letter tile", () => {
  assert.deepEqual(pngSize(PNG), { width: 64, height: 64 });
  assert.equal(pngSize(Buffer.from("GIF89a not a png at all, long enough....")), null);
  assert.equal(pngSize("x"), null);
  const ico = icoFromPng(PNG);
  assert.deepEqual([...ico.subarray(0, 8)], [0, 0, 1, 0, 1, 0, 64, 64]);
  assert.equal(ico.readUInt32LE(14), PNG.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.ok(ico.subarray(22).equals(PNG));
  assert.equal(icoFromPng(letterTilePng({ id: "a", name: "A", size: 256 }))[6], 0);
  assert.throws(() => icoFromPng(Buffer.from("nope")));
  assert.equal(tileLetter("élan"), "E");
  assert.equal(tileLetter("  9 lives"), "9");
  assert.equal(tileLetter("日本"), null);
  assert.deepEqual(pngSize(letterTilePng({ id: "x", name: "日本", size: 32 })), { width: 32, height: 32 });
});

test("macOS: a bundle in ~/Applications/MausBot Apps with its plist, script and icon", async () => {
  const { fs, calls, installer, dir } = mac();
  const result = await installer.installApp({ id: "notes", name: "Notes", iconPng: PNG });
  assert.deepEqual(result, { ok: true, app: { id: "notes", name: "Notes", path: `${dir}/Notes.app` } });
  const bundle = `${dir}/Notes.app/Contents`;
  assert.equal(macPlistAppId(fs.text(`${bundle}/Info.plist`)), "notes");
  assert.match(fs.text(`${bundle}/Info.plist`), /CFBundleIconFile/);
  assert.equal(fs.text(`${bundle}/MacOS/launcher`), macLauncherScript({ id: "notes" }));
  assert.equal(fs.entries.get(`${bundle}/MacOS/launcher`).mode, 0o755);
  assert.equal(fs.text(`${bundle}/Resources/AppIcon.icns`), "icns");
  assert.equal(fs.text(`${bundle}/PkgInfo`), "APPL????");
  assert.equal(calls.filter(([f]) => f === "/usr/bin/sips").length, 10);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["/usr/bin/iconutil", "-c", "icns", "-o"]);
  assert.ok(calls.at(-1)[4].endsWith("AppIcon.icns") && calls.at(-1)[5].endsWith("icon.iconset"));
  assert.deepEqual(await installer.installedApps(), [{ id: "notes", name: "Notes", path: `${dir}/Notes.app` }]);
  assert.equal(await installer.isInstalled("notes"), true);
  assert.equal(await installer.isInstalled("other"), false);
  assert.equal(fs.files().some((f) => f.includes("/work/") || f.includes(".staging")), false);
  for (const file of fs.files()) assert.ok(file.startsWith(`${dir}/`) || file.startsWith("/Users/u/Library/Application Support/OpenMausBot/app-install/"), file);
});

test("macOS: when sips or iconutil fails the bundle has no icon of its own and still installs", async () => {
  const { fs, installer, dir } = mac({ runOk: false });
  assert.equal((await installer.installApp({ id: "notes", name: "Notes" })).ok, true);
  assert.doesNotMatch(fs.text(`${dir}/Notes.app/Contents/Info.plist`), /CFBundleIconFile/);
  assert.equal(fs.entries.has(`${dir}/Notes.app/Contents/Resources/AppIcon.icns`), false);
  assert.equal(fs.files().some((f) => f.includes("/work/")), false);
});

test("macOS: two apps with one name, a name only case apart, and a bundle someone else made", async () => {
  const { fs, installer, dir } = mac();
  await fs.mkdir(`${dir}/Budget.app/Contents`, { recursive: true });
  await fs.writeFile(`${dir}/Budget.app/Contents/Info.plist`, "<plist>theirs</plist>");
  fs.entries.set(`${dir}/Linked.app`, { type: "link" });
  assert.equal((await installer.installApp({ id: "a", name: "Notes" })).app.name, "Notes");
  assert.equal((await installer.installApp({ id: "b", name: "Notes" })).app.name, "Notes 2");
  assert.equal((await installer.installApp({ id: "c", name: "notes" })).app.name, "notes 3");
  assert.equal((await installer.installApp({ id: "d", name: "Budget" })).app.name, "Budget 2");
  assert.equal((await installer.installApp({ id: "e", name: "Linked" })).app.name, "Linked 2");
  assert.equal(fs.text(`${dir}/Budget.app/Contents/Info.plist`), "<plist>theirs</plist>");
  assert.equal((await installer.installApp({ id: "a", name: "Notes" })).app.name, "Notes");
  assert.equal(macPlistAppId(fs.text(`${dir}/Notes 2.app/Contents/Info.plist`)), "b");
});

test("macOS: a new name writes the new bundle and moves the old one to the Trash", async () => {
  const { fs, trashed, installer, dir } = mac();
  await installer.installApp({ id: "notes", name: "Notes" });
  const renamed = await installer.installApp({ id: "notes", name: "Journal" });
  assert.equal(renamed.app.path, `${dir}/Journal.app`);
  assert.deepEqual(trashed, [`${dir}/Notes.app`]);
  assert.equal(fs.entries.has(`${dir}/Notes.app`), false);
  assert.deepEqual((await installer.installedApps()).map((a) => a.name), ["Journal"]);
});

test("macOS: uninstall removes only this app's own bundle, deleting it when there is no Trash", async () => {
  const { fs, installer, dir } = mac({ trash: false });
  await installer.installApp({ id: "a", name: "Alpha" });
  await installer.installApp({ id: "b", name: "Beta" });
  await fs.writeFile(`${dir}/Beta.app/Contents/Info.plist`, macInfoPlist({ id: "someone-else", name: "Beta" }));
  assert.deepEqual(await installer.uninstallApp("a"), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}/Alpha.app`), false);
  assert.deepEqual(await installer.uninstallApp("b"), { ok: true, removed: true, left: [`${dir}/Beta.app`] });
  assert.ok(fs.entries.has(`${dir}/Beta.app/Contents/Info.plist`));
  assert.deepEqual(await installer.uninstallApp("b"), { ok: true, removed: false });
  assert.deepEqual(await installer.uninstallApp("../x"), { ok: false, reason: "invalid-id" });
});

test("macOS: a file the person put at our launcher's path is never replaced", async () => {
  const { fs, installer, dir } = mac();
  await installer.installApp({ id: "notes", name: "Notes" });
  await fs.rm(`${dir}/Notes.app`, { recursive: true });
  await fs.mkdir(`${dir}/Notes.app/Contents`, { recursive: true });
  await fs.writeFile(`${dir}/Notes.app/Contents/Info.plist`, "mine");
  assert.equal(await installer.isInstalled("notes"), false);
  assert.deepEqual(await installer.installedApps(), []);
  assert.equal((await installer.installApp({ id: "notes", name: "Notes" })).app.name, "Notes 2");
  assert.equal(fs.text(`${dir}/Notes.app/Contents/Info.plist`), "mine");
});

test("cleanup removes launchers of apps that are gone, and leftover staging folders", async () => {
  const { fs, installer, dir } = mac();
  await installer.installApp({ id: "keep", name: "Keep" });
  await installer.installApp({ id: "gone", name: "Gone" });
  await fs.mkdir(`${dir}/.mausbot-0123456789abcdef.staging/Contents`, { recursive: true });
  await fs.mkdir(`${dir}/.someone-elses.staging`, { recursive: true });
  assert.deepEqual(await installer.cleanup(undefined), []);
  assert.deepEqual(await installer.cleanup(null), []);
  assert.ok(fs.entries.has(`${dir}/Gone.app`));
  assert.deepEqual(await installer.cleanup(["keep"]), ["gone"]);
  assert.equal(fs.entries.has(`${dir}/Gone.app`), false);
  assert.equal(fs.entries.has(`${dir}/.mausbot-0123456789abcdef.staging`), false);
  assert.ok(fs.entries.has(`${dir}/.someone-elses.staging`));
  assert.deepEqual((await installer.installedApps()).map((a) => a.id), ["keep"]);
});

test("refusals: unavailable when off, a bad id, and an unreadable list starts again", async () => {
  const off = mac({ enabled: false });
  assert.deepEqual(await off.installer.installApp({ id: "notes", name: "N" }), { ok: false, reason: "unavailable" });
  assert.deepEqual(await off.installer.installedApps(), []);
  assert.equal(off.fs.files().length, 0);
  const { fs, installer } = mac();
  for (const id of ["../../x", "a b", "", undefined]) assert.deepEqual(await installer.installApp({ id, name: "N" }), { ok: false, reason: "invalid-id" });
  await fs.mkdir("/Users/u/Library/Application Support/OpenMausBot/app-install", { recursive: true });
  await fs.writeFile("/Users/u/Library/Application Support/OpenMausBot/app-install/installed.json", "{not json");
  assert.equal((await installer.installApp({ id: "n", name: "N" })).ok, true);
  assert.equal(createAppInstaller({ platform: "freebsd", path: path.posix, home: "/h", userData: "/d", fs }).available(), false);
  assert.equal(createAppInstaller({ platform: "win32", path: path.win32, home: "C:\\h", userData: "C:\\d", appData: "C:\\a", fs, executable: "C:\\x.exe" }).available(), false);
});

test("Windows: a Start menu shortcut to MausBot's executable with the link, its own taskbar id and icon", async () => {
  const { fs, shortcuts, installer, dir, options } = windows();
  const result = await installer.installApp({ id: "notes", name: "Notes", iconPng: PNG });
  assert.equal(result.app.path, `${dir}\\Notes.lnk`);
  const [file, operation, link] = shortcuts[0];
  assert.equal(file, `${dir}\\Notes.lnk`);
  assert.equal(operation, "create");
  assert.equal(link.target, options.executable);
  assert.equal(link.args, "openmausbot://app/notes");
  assert.equal(link.appUserModelId, windowsAppUserModelId("notes"));
  assert.match(link.icon, /^C:\\Users\\u\\AppData\\Roaming\\OpenMausBot\\app-install\\icons\\[0-9a-f]{16}\.ico$/);
  assert.deepEqual([...fs.entries.get(link.icon).data.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(shortcuts.length, 1);
  assert.equal(fs.entries.has("C:\\Users\\u\\Desktop"), false);

  await installer.installApp({ id: "notes", name: "Notes", desktopShortcut: true });
  assert.deepEqual(shortcuts.slice(1).map(([f, op]) => [f, op]), [[`${dir}\\Notes.lnk`, "replace"], ["C:\\Users\\u\\Desktop\\Notes.lnk", "create"]]);

  await installer.installApp({ id: "other", name: "NOTES" });
  assert.equal(shortcuts.at(-1)[0], `${dir}\\NOTES 2.lnk`);

  await installer.installApp({ id: "notes", name: "Journal" });
  assert.ok(fs.entries.has(`${dir}\\Journal.lnk`));
  assert.equal(fs.entries.has(`${dir}\\Notes.lnk`), false);
  assert.equal(fs.entries.has("C:\\Users\\u\\Desktop\\Notes.lnk"), false);

  fs.entries.set(`${dir}\\Mine.lnk`, { type: "file", data: Buffer.from(JSON.stringify({ target: "C:\\x.exe", args: "" })) });
  assert.equal((await installer.installApp({ id: "m", name: "Mine" })).app.name, "Mine 2");
  assert.equal(JSON.parse(fs.text(`${dir}\\Mine.lnk`)).target, "C:\\x.exe");

  assert.deepEqual(await installer.uninstallApp("notes"), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}\\Journal.lnk`), false);
  assert.equal(fs.entries.has(link.icon), false);
  for (const f of fs.files()) assert.ok(f.startsWith(`${dir}\\`) || f.startsWith("C:\\Users\\u\\AppData\\Roaming\\OpenMausBot\\app-install\\"), f);
});

test("Windows: shortcuts follow MausBot's executable when it moved", async () => {
  const first = windows();
  await first.installer.installApp({ id: "notes", name: "Notes" });
  const moved = createAppInstaller({ ...first.options, executable: "D:\\OpenMausBot\\OpenMausBot.exe" });
  assert.deepEqual(await moved.refreshTargets(), ["notes"]);
  assert.deepEqual(first.shortcuts.at(-1).slice(0, 2), [`${first.dir}\\Notes.lnk`, "replace"]);
  assert.equal(first.shortcuts.at(-1)[2].target, "D:\\OpenMausBot\\OpenMausBot.exe");
  assert.deepEqual(await moved.refreshTargets(), []);
});

test("Linux: a desktop entry and an icon, refusing an entry it did not write", async () => {
  const { fs, installer, dir, options } = linux();
  const result = await installer.installApp({ id: "notes", name: "Notes" });
  assert.equal(result.app.path, `${dir}/mausbot-app-notes.desktop`);
  const entry = fs.text(`${dir}/mausbot-app-notes.desktop`);
  assert.match(entry, /^Exec="\/home\/u\/Apps\/OpenMausBot\.AppImage" openmausbot:\/\/app\/notes$/m);
  const icon = /^Icon=(.+)$/m.exec(entry)[1];
  assert.match(icon, /^\/home\/u\/\.local\/share\/icons\/mausbot-apps\/mausbot-app-[0-9a-f]{16}\.png$/);
  assert.ok(pngSize(fs.entries.get(icon).data));
  await installer.installApp({ id: "notes", name: "Journal" });
  assert.match(fs.text(`${dir}/mausbot-app-notes.desktop`), /^Name=Journal$/m);

  await fs.writeFile(`${dir}/mausbot-app-theirs.desktop`, "[Desktop Entry]\nName=Theirs\n");
  assert.deepEqual(await installer.installApp({ id: "theirs", name: "X" }), { ok: false, reason: "taken" });
  assert.equal(fs.text(`${dir}/mausbot-app-theirs.desktop`), "[Desktop Entry]\nName=Theirs\n");

  const moved = createAppInstaller({ ...options, executable: "/opt/OpenMausBot/openmausbot" });
  assert.deepEqual(await moved.refreshTargets(), ["notes"]);
  assert.match(fs.text(`${dir}/mausbot-app-notes.desktop`), /^Exec="\/opt\/OpenMausBot\/openmausbot" openmausbot:\/\/app\/notes$/m);

  assert.deepEqual(await installer.uninstallApp("notes"), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}/mausbot-app-notes.desktop`), false);
  assert.equal(fs.entries.has(icon), false);
  assert.deepEqual(fs.files().sort(), ["/home/u/.config/OpenMausBot/app-install/installed.json", `${dir}/mausbot-app-theirs.desktop`]);
});

test("Linux: XDG data home moves the launcher folders", async () => {
  const { fs, options } = linux();
  const installer = createAppInstaller({ ...options, dataHome: "/data" });
  assert.equal((await installer.installApp({ id: "n", name: "N" })).app.path, "/data/applications/mausbot-app-n.desktop");
  assert.ok(fs.files().some((f) => f.startsWith("/data/icons/mausbot-apps/")));
});

test("calls run one at a time, so two installs of one name never pick the same file", async () => {
  const { installer } = mac();
  const [a, b] = await Promise.all([installer.installApp({ id: "a", name: "Same" }), installer.installApp({ id: "b", name: "Same" })]);
  assert.deepEqual([a.app.name, b.app.name], ["Same", "Same 2"]);
});

test("IPC: three guarded channels that pass on only what the installer takes", async () => {
  const handlers = new Map();
  const guarded = [];
  const seen = [];
  const installer = {
    available: () => true,
    installApp: async (input) => { seen.push(input); return { ok: true }; },
    uninstallApp: async (id) => { seen.push(id); return { ok: true }; },
    installedApps: async () => [{ id: "a", name: "A", path: "/p" }],
  };
  installAppInstall({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, guard: (channel, fn) => { guarded.push(channel); return fn; }, installer });
  assert.deepEqual([...handlers.keys()], ["app-install:install", "app-install:uninstall", "app-install:list"]);
  assert.deepEqual(guarded, [...handlers.keys()]);
  await handlers.get("app-install:install")({}, { id: "a", name: "x".repeat(600), iconPng: "x", desktopShortcut: 1, extra: true });
  await handlers.get("app-install:uninstall")({}, { id: "a" });
  assert.deepEqual(seen, [{ id: "a", name: "x".repeat(512), iconPng: undefined, desktopShortcut: false }, ""]);
  assert.deepEqual(await handlers.get("app-install:list")({}), { available: true, apps: [{ id: "a", name: "A", path: "/p" }] });
});
