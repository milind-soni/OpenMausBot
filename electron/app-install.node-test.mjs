import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createAppInstaller } from "./app-install/installer.mjs";
import { icoFromPng, letterTilePng, pngSize, tileLetter } from "./app-install/icons.mjs";
import { L, PNG, linux, mac, windows } from "./app-install-test-fixture.mjs";
import { installAppInstall } from "./app-install/ipc.mjs";
import { desktopEntry, macInfoPlist, macLauncherScript, macPlistAppId, windowsShortcut, windowsWindowDetails } from "./app-install/launchers.mjs";
import { launcherBundleId, launcherLink, launcherName, validAppId, windowsAppUserModelId } from "./app-install/names.mjs";

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

test("app ids: only a saved app's id, which launchers and bundle ids are made from", () => {
  for (const id of [L("notes"), "la_AbCdEfGhIjKlMnOp", "la_0000000000000000", "la_-_-_-_-_-_-_-_-_"]) assert.ok(validAppId(id), id);
  for (const id of ["", "notes", "la_short", `${L("notes")}x`, "la_aaaaaaaaaaaaaa b", "la_aaaaaaaaaaaaaa/b", "la_aaaaaaaaaaaaaa.b", "la_aaaaaaaaaaaaa'b", 5, null]) {
    assert.equal(validAppId(id), false, String(id));
  }
  assert.equal(launcherLink(L("notes")), `openmausbot://app/${L("notes")}?window=1`);
  assert.match(launcherBundleId(L("notes")), /^com\.openmausbot\.app\.localapp\.[0-9a-f]{16}$/);
  assert.notEqual(launcherBundleId(L("notes")), launcherBundleId(L("notes2")));
  assert.equal(launcherBundleId(L("notes"), "bad id;rm"), launcherBundleId(L("notes")));
  assert.equal(windowsAppUserModelId(L("notes")), launcherBundleId(L("notes")));
});

test("Info.plist names the app, a bundle id of its own, the id marker and no Dock tile; the script opens the link", () => {
  const plist = macInfoPlist({ id: L("notes"), name: "Tom & Jerry <3>" });
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\n {2}<string>Tom &amp; Jerry &lt;3&gt;<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\n {2}<string>launcher<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\n {2}<string>AppIcon<\/string>/);
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key>\\n {2}<string>${launcherBundleId(L("notes")).replaceAll(".", "\\.")}</string>`));
  assert.match(plist, /<key>CFBundlePackageType<\/key>\n {2}<string>APPL<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\n {2}<true\/>/);
  assert.equal(macPlistAppId(plist), L("notes"));
  assert.doesNotMatch(macInfoPlist({ id: L("notes"), name: "N", icon: false }), /CFBundleIconFile/);
  assert.throws(() => macInfoPlist({ id: "x'y", name: "N" }));
  assert.equal(macLauncherScript({ id: L("notes") }),
    `#!/bin/sh\n/usr/bin/open -b 'com.openmausbot.app' '${launcherLink(L("notes"))}' 2>/dev/null || exec /usr/bin/open '${launcherLink(L("notes"))}'\n`);
  assert.match(macLauncherScript({ id: L("notes"), hostBundleId: "x'; rm -rf ~" }), /open -b 'com\.openmausbot\.app'/);
  assert.throws(() => macLauncherScript({ id: "a;b" }));
});

test("desktop entry and Windows shortcut carry the link, quoted executable and id marker", () => {
  const entry = desktopEntry({ id: L("notes"), name: "My\nNotes", executable: "/home/u/My Apps/100%$x\\y.AppImage", iconPath: "/home/u/.local/share/icons/mausbot-apps/i.png" });
  assert.match(entry, /^Name=My\\nNotes$/m);
  assert.match(entry, /^Exec="\/home\/u\/My Apps\/100%%\\\\\$x\\\\\\\\y\.AppImage" "openmausbot:\/\/app\/la_notes00000000000\?window=1"$/m);
  assert.match(entry, /^Icon=\/home\/u\/\.local\/share\/icons\/mausbot-apps\/i\.png$/m);
  assert.match(entry, /^X-OpenMausBot-LocalApp=la_notes00000000000$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.deepEqual(windowsShortcut({ id: L("notes"), name: "Notes", executable: "C:\\P\\OpenMausBot.exe", iconPath: "C:\\i.ico" }), {
    target: "C:\\P\\OpenMausBot.exe", args: launcherLink(L("notes")), description: "Notes", icon: "C:\\i.ico", iconIndex: 0, appUserModelId: windowsAppUserModelId(L("notes")),
  });
  assert.equal(windowsWindowDetails({ id: L("notes"), name: "Notes", executable: "C:\\P\\O.exe" }).relaunchCommand, `"C:\\P\\O.exe" ${launcherLink(L("notes"))}`);
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
  assert.equal(icoFromPng(letterTilePng({ id: L("a"), name: "A", size: 256 }))[6], 0);
  assert.throws(() => icoFromPng(Buffer.from("nope")));
  assert.equal(tileLetter("élan"), "E");
  assert.equal(tileLetter("  9 lives"), "9");
  assert.equal(tileLetter("日本"), null);
  assert.deepEqual(pngSize(letterTilePng({ id: L("x"), name: "日本", size: 32 })), { width: 32, height: 32 });
});

test("macOS: a bundle in ~/Applications/MausBot Apps with its plist, script and icon", async () => {
  const { fs, calls, installer, dir } = mac();
  const result = await installer.installApp({ id: L("notes"), name: "Notes", iconPng: PNG });
  assert.deepEqual(result, { ok: true, app: { id: L("notes"), name: "Notes", path: `${dir}/Notes.app`, desktop: false } });
  const bundle = `${dir}/Notes.app/Contents`;
  assert.equal(macPlistAppId(fs.text(`${bundle}/Info.plist`)), L("notes"));
  assert.match(fs.text(`${bundle}/Info.plist`), /CFBundleIconFile/);
  assert.equal(fs.text(`${bundle}/MacOS/launcher`), macLauncherScript({ id: L("notes") }));
  assert.equal(fs.entries.get(`${bundle}/MacOS/launcher`).mode, 0o755);
  assert.equal(fs.text(`${bundle}/Resources/AppIcon.icns`), "icns");
  assert.equal(fs.text(`${bundle}/PkgInfo`), "APPL????");
  assert.equal(calls.filter(([f]) => f === "/usr/bin/sips").length, 10);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["/usr/bin/iconutil", "-c", "icns", "-o"]);
  assert.ok(calls.at(-1)[4].endsWith("AppIcon.icns") && calls.at(-1)[5].endsWith("icon.iconset"));
  assert.deepEqual(await installer.installedApps(), [{ id: L("notes"), name: "Notes", path: `${dir}/Notes.app`, desktop: false }]);
  assert.equal(await installer.isInstalled(L("notes")), true);
  assert.equal(await installer.isInstalled(L("other")), false);
  assert.equal(fs.files().some((f) => f.includes("/work/") || f.includes(".staging")), false);
  for (const file of fs.files()) assert.ok(file.startsWith(`${dir}/`) || file.startsWith("/Users/u/Library/Application Support/OpenMausBot/app-install/"), file);
});

test("macOS: when sips or iconutil fails the bundle has no icon of its own and still installs", async () => {
  const { fs, installer, dir } = mac({ runOk: false });
  assert.equal((await installer.installApp({ id: L("notes"), name: "Notes" })).ok, true);
  assert.doesNotMatch(fs.text(`${dir}/Notes.app/Contents/Info.plist`), /CFBundleIconFile/);
  assert.equal(fs.entries.has(`${dir}/Notes.app/Contents/Resources/AppIcon.icns`), false);
  assert.equal(fs.files().some((f) => f.includes("/work/")), false);
});

test("macOS: two apps with one name, a name only case apart, and a bundle someone else made", async () => {
  const { fs, installer, dir } = mac();
  await fs.mkdir(`${dir}/Budget.app/Contents`, { recursive: true });
  await fs.writeFile(`${dir}/Budget.app/Contents/Info.plist`, "<plist>theirs</plist>");
  fs.entries.set(`${dir}/Linked.app`, { type: "link" });
  assert.equal((await installer.installApp({ id: L("a"), name: "Notes" })).app.name, "Notes");
  assert.equal((await installer.installApp({ id: L("b"), name: "Notes" })).app.name, "Notes 2");
  assert.equal((await installer.installApp({ id: L("c"), name: "notes" })).app.name, "notes 3");
  assert.equal((await installer.installApp({ id: L("d"), name: "Budget" })).app.name, "Budget 2");
  assert.equal((await installer.installApp({ id: L("e"), name: "Linked" })).app.name, "Linked 2");
  assert.equal(fs.text(`${dir}/Budget.app/Contents/Info.plist`), "<plist>theirs</plist>");
  assert.equal((await installer.installApp({ id: L("a"), name: "Notes" })).app.name, "Notes");
  assert.equal(macPlistAppId(fs.text(`${dir}/Notes 2.app/Contents/Info.plist`)), L("b"));
});

test("macOS: a new name writes the new bundle and moves the old one to the Trash", async () => {
  const { fs, trashed, installer, dir } = mac();
  await installer.installApp({ id: L("notes"), name: "Notes" });
  const renamed = await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.equal(renamed.app.path, `${dir}/Journal.app`);
  assert.deepEqual(trashed, [`${dir}/Notes.app`]);
  assert.equal(fs.entries.has(`${dir}/Notes.app`), false);
  assert.deepEqual((await installer.installedApps()).map((a) => a.name), ["Journal"]);
});

test("macOS: uninstall removes only this app's own bundle, deleting it when there is no Trash", async () => {
  const { fs, installer, dir } = mac({ trash: false });
  await installer.installApp({ id: L("a"), name: "Alpha" });
  await installer.installApp({ id: L("b"), name: "Beta" });
  await fs.writeFile(`${dir}/Beta.app/Contents/Info.plist`, macInfoPlist({ id: L("someone-else"), name: "Beta" }));
  assert.deepEqual(await installer.uninstallApp(L("a")), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}/Alpha.app`), false);
  assert.deepEqual(await installer.uninstallApp(L("b")), { ok: true, removed: true, left: [`${dir}/Beta.app`] });
  assert.ok(fs.entries.has(`${dir}/Beta.app/Contents/Info.plist`));
  assert.deepEqual(await installer.uninstallApp(L("b")), { ok: true, removed: false });
  assert.deepEqual(await installer.uninstallApp("../x"), { ok: false, reason: "invalid-id" });
});

test("macOS: a file the person put at our launcher's path is never replaced", async () => {
  const { fs, installer, dir } = mac();
  await installer.installApp({ id: L("notes"), name: "Notes" });
  await fs.rm(`${dir}/Notes.app`, { recursive: true });
  await fs.mkdir(`${dir}/Notes.app/Contents`, { recursive: true });
  await fs.writeFile(`${dir}/Notes.app/Contents/Info.plist`, "mine");
  assert.equal(await installer.isInstalled(L("notes")), false);
  assert.deepEqual(await installer.installedApps(), []);
  assert.equal((await installer.installApp({ id: L("notes"), name: "Notes" })).app.name, "Notes 2");
  assert.equal(fs.text(`${dir}/Notes.app/Contents/Info.plist`), "mine");
});

test("cleanup removes launchers of apps that are gone, and leftover staging folders", async () => {
  const { fs, installer, dir } = mac();
  await installer.installApp({ id: L("keep"), name: "Keep" });
  await installer.installApp({ id: L("gone"), name: "Gone" });
  await fs.mkdir(`${dir}/.mausbot-0123456789abcdef.staging/Contents`, { recursive: true });
  await fs.mkdir(`${dir}/.someone-elses.staging`, { recursive: true });
  assert.deepEqual(await installer.cleanup(undefined), []);
  assert.deepEqual(await installer.cleanup(null), []);
  assert.ok(fs.entries.has(`${dir}/Gone.app`));
  assert.deepEqual(await installer.cleanup([L("keep")]), [L("gone")]);
  assert.equal(fs.entries.has(`${dir}/Gone.app`), false);
  assert.equal(fs.entries.has(`${dir}/.mausbot-0123456789abcdef.staging`), false);
  assert.ok(fs.entries.has(`${dir}/.someone-elses.staging`));
  assert.deepEqual((await installer.installedApps()).map((a) => a.id), [L("keep")]);
});

test("refusals: unavailable when off, a bad id, and an unreadable list starts again", async () => {
  const off = mac({ enabled: false });
  assert.deepEqual(await off.installer.installApp({ id: L("notes"), name: "N" }), { ok: false, reason: "unavailable" });
  assert.deepEqual(await off.installer.installedApps(), []);
  assert.equal(off.fs.files().length, 0);
  const { fs, installer } = mac();
  for (const id of ["../../x", "a b", "", undefined]) assert.deepEqual(await installer.installApp({ id, name: "N" }), { ok: false, reason: "invalid-id" });
  await fs.mkdir("/Users/u/Library/Application Support/OpenMausBot/app-install", { recursive: true });
  await fs.writeFile("/Users/u/Library/Application Support/OpenMausBot/app-install/installed.json", "{not json");
  assert.equal((await installer.installApp({ id: L("n"), name: "N" })).ok, true);
  assert.equal(createAppInstaller({ platform: "freebsd", path: path.posix, home: "/h", userData: "/d", fs }).available(), false);
  assert.equal(createAppInstaller({ platform: "win32", path: path.win32, home: "C:\\h", userData: "C:\\d", appData: "C:\\a", fs, executable: "C:\\x.exe" }).available(), false);
});

test("Windows: a Start menu shortcut to MausBot's executable with the link, its own taskbar id and icon", async () => {
  const { fs, shortcuts, installer, dir, options } = windows({ makeDesktop: true });
  const result = await installer.installApp({ id: L("notes"), name: "Notes", iconPng: PNG });
  assert.equal(result.app.path, `${dir}\\Notes.lnk`);
  const [file, operation, link] = shortcuts[0];
  assert.equal(file, `${dir}\\Notes.lnk`);
  assert.equal(operation, "create");
  assert.equal(link.target, options.executable);
  assert.equal(link.args, launcherLink(L("notes")));
  assert.equal(link.appUserModelId, windowsAppUserModelId(L("notes")));
  assert.match(link.icon, /^C:\\Users\\u\\AppData\\Roaming\\OpenMausBot\\app-install\\icons\\[0-9a-f]{16}\.ico$/);
  assert.deepEqual([...fs.entries.get(link.icon).data.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(shortcuts.length, 1);
  assert.equal(fs.files().some((f) => f.startsWith("C:\\Users\\u\\Desktop\\")), false);

  await installer.installApp({ id: L("notes"), name: "Notes", desktopShortcut: true });
  assert.deepEqual(shortcuts.slice(1).map(([f, op]) => [f, op]), [[`${dir}\\Notes.lnk`, "replace"], ["C:\\Users\\u\\Desktop\\Notes.lnk", "create"]]);

  await installer.installApp({ id: L("other"), name: "NOTES" });
  assert.equal(shortcuts.at(-1)[0], `${dir}\\NOTES 2.lnk`);

  await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.ok(fs.entries.has(`${dir}\\Journal.lnk`));
  assert.equal(fs.entries.has(`${dir}\\Notes.lnk`), false);
  assert.equal(fs.entries.has("C:\\Users\\u\\Desktop\\Notes.lnk"), false);

  fs.entries.set(`${dir}\\Mine.lnk`, { type: "file", data: Buffer.from(JSON.stringify({ target: "C:\\x.exe", args: "" })) });
  assert.equal((await installer.installApp({ id: L("m"), name: "Mine" })).app.name, "Mine 2");
  assert.equal(JSON.parse(fs.text(`${dir}\\Mine.lnk`)).target, "C:\\x.exe");

  assert.deepEqual(await installer.uninstallApp(L("notes")), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}\\Journal.lnk`), false);
  assert.equal(fs.entries.has(link.icon), false);
  for (const f of fs.files()) assert.ok(f.startsWith(`${dir}\\`) || f.startsWith("C:\\Users\\u\\AppData\\Roaming\\OpenMausBot\\app-install\\"), f);
});

test("Windows: shortcuts follow MausBot's executable when it moved", async () => {
  const first = windows();
  await first.installer.installApp({ id: L("notes"), name: "Notes" });
  const moved = createAppInstaller({ ...first.options, executable: "D:\\OpenMausBot\\OpenMausBot.exe" });
  assert.deepEqual(await moved.refreshTargets(), [L("notes")]);
  assert.deepEqual(first.shortcuts.at(-1).slice(0, 2), [`${first.dir}\\Notes.lnk`, "replace"]);
  assert.equal(first.shortcuts.at(-1)[2].target, "D:\\OpenMausBot\\OpenMausBot.exe");
  assert.deepEqual(await moved.refreshTargets(), []);
});

test("Linux: a desktop entry and an icon, refusing an entry it did not write", async () => {
  const { fs, installer, dir, options } = linux();
  const result = await installer.installApp({ id: L("notes"), name: "Notes" });
  assert.equal(result.app.path, `${dir}/mausbot-app-${L("notes")}.desktop`);
  const entry = fs.text(`${dir}/mausbot-app-${L("notes")}.desktop`);
  assert.match(entry, /^Exec="\/home\/u\/Apps\/OpenMausBot\.AppImage" "openmausbot:\/\/app\/la_notes00000000000\?window=1"$/m);
  const icon = /^Icon=(.+)$/m.exec(entry)[1];
  assert.match(icon, /^\/home\/u\/\.local\/share\/icons\/mausbot-apps\/mausbot-app-[0-9a-f]{16}\.png$/);
  assert.ok(pngSize(fs.entries.get(icon).data));
  await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.match(fs.text(`${dir}/mausbot-app-${L("notes")}.desktop`), /^Name=Journal$/m);

  await fs.writeFile(`${dir}/mausbot-app-${L("theirs")}.desktop`, "[Desktop Entry]\nName=Theirs\n");
  assert.deepEqual(await installer.installApp({ id: L("theirs"), name: "X" }), { ok: false, reason: "taken" });
  assert.equal(fs.text(`${dir}/mausbot-app-${L("theirs")}.desktop`), "[Desktop Entry]\nName=Theirs\n");

  const moved = createAppInstaller({ ...options, executable: "/opt/OpenMausBot/openmausbot" });
  assert.deepEqual(await moved.refreshTargets(), [L("notes")]);
  assert.match(fs.text(`${dir}/mausbot-app-${L("notes")}.desktop`), /^Exec="\/opt\/OpenMausBot\/openmausbot" "openmausbot:\/\/app\/la_notes00000000000\?window=1"$/m);

  assert.deepEqual(await installer.uninstallApp(L("notes")), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${dir}/mausbot-app-${L("notes")}.desktop`), false);
  assert.equal(fs.entries.has(icon), false);
  assert.deepEqual(fs.files().sort(), ["/home/u/.config/OpenMausBot/app-install/installed.json", `${dir}/mausbot-app-${L("theirs")}.desktop`]);
});

test("Linux: XDG data home moves the launcher folders", async () => {
  const { fs, options } = linux();
  const installer = createAppInstaller({ ...options, dataHome: "/data" });
  assert.equal((await installer.installApp({ id: L("n"), name: "N" })).app.path, `/data/applications/mausbot-app-${L("n")}.desktop`);
  assert.ok(fs.files().some((f) => f.startsWith("/data/icons/mausbot-apps/")));
});

test("calls run one at a time, so two installs of one name never pick the same file", async () => {
  const { installer } = mac();
  const [a, b] = await Promise.all([installer.installApp({ id: L("a"), name: "Same" }), installer.installApp({ id: L("b"), name: "Same" })]);
  assert.deepEqual([a.app.name, b.app.name], ["Same", "Same 2"]);
});

test("IPC: six guarded channels that pass on only what the installer takes", async () => {
  const handlers = new Map();
  const guarded = [];
  const seen = [];
  const installer = {
    available: () => true,
    installApp: async (input) => { seen.push(input); return { ok: true }; },
    uninstallApp: async (id) => { seen.push(id); return { ok: true }; },
    installedApps: async () => [{ id: L("a"), name: "A", path: "/p" }],
    cleanup: async (ids) => { seen.push(["cleanup", ids]); return []; },
    addToDesktop: async (id) => { seen.push(["add", id]); return { ok: true }; },
    removeFromDesktop: async (id) => { seen.push(["remove", id]); return { ok: true }; },
  };
  installAppInstall({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, guard: (channel, fn) => { guarded.push(channel); return fn; }, installer });
  assert.deepEqual([...handlers.keys()], [
    "app-install:install", "app-install:uninstall", "app-install:add-to-desktop", "app-install:remove-from-desktop", "app-install:list", "app-install:cleanup",
  ]);
  assert.deepEqual(guarded, [...handlers.keys()]);
  await handlers.get("app-install:install")({}, { id: L("a"), name: "x".repeat(600), iconPng: "x", desktopShortcut: 1, extra: true });
  await handlers.get("app-install:uninstall")({}, { id: L("a") });
  assert.deepEqual(seen, [{ id: L("a"), name: "x".repeat(512), iconPng: undefined, desktopShortcut: false }, ""]);
  assert.deepEqual(await handlers.get("app-install:list")({}), { available: true, apps: [{ id: L("a"), name: "A", path: "/p" }] });
  seen.length = 0;
  await handlers.get("app-install:cleanup")({}, [L("a")]);
  for (const bad of [undefined, null, "x", [1], { length: 1 }]) assert.deepEqual(await handlers.get("app-install:cleanup")({}, bad), []);
  assert.deepEqual(seen, [["cleanup", [L("a")]]]);
  seen.length = 0;
  await handlers.get("app-install:add-to-desktop")({}, L("a"));
  await handlers.get("app-install:add-to-desktop")({}, { id: L("a") });
  await handlers.get("app-install:remove-from-desktop")({}, L("a"));
  await handlers.get("app-install:remove-from-desktop")({}, 7);
  assert.deepEqual(seen, [["add", L("a")], ["add", ""], ["remove", L("a")], ["remove", ""]]);
});

test("Windows: an installed app's own window takes its launcher's taskbar details; nothing elsewhere or uninstalled", async () => {
  const { installer } = windows();
  assert.equal(await installer.windowDetails(L("notes")), null);
  await installer.installApp({ id: L("notes"), name: "Notes", iconPng: PNG });
  const details = await installer.windowDetails(L("notes"));
  assert.equal(details.appId, windowsAppUserModelId(L("notes")));
  assert.equal(details.relaunchDisplayName, "Notes");
  assert.match(details.relaunchCommand, new RegExp(`OpenMausBot\\.exe" openmausbot://app/${L("notes")}\\?window=1$`));
  assert.match(details.appIconPath, /\.ico$/);
  assert.equal(await installer.windowDetails("../x"), null);
  assert.equal(await linux().installer.windowDetails(L("notes")), null);
});
