import assert from "node:assert/strict";
import test from "node:test";
import { createAppInstaller } from "./app-install/installer.mjs";
import { desktopEntry, macInfoPlist, macLauncherScript, macPlistAppId, windowsShortcut } from "./app-install/launchers.mjs";
import { launcherLink, windowsAppUserModelId } from "./app-install/names.mjs";
import { L, PNG, linux, mac, windows } from "./app-install-test-fixture.mjs";

const UD_MAC = "/Users/u/Library/Application Support/OpenMausBot/";

test("macOS: installing puts nothing on the Desktop; Add to Desktop copies the launcher bundle there", async () => {
  const { fs, calls, installer, dir, desktop } = mac({ makeDesktop: true });
  await installer.installApp({ id: L("notes"), name: "Notes", iconPng: PNG });
  assert.deepEqual(await fs.readdir(desktop), []);
  const sipsRuns = calls.length;

  const added = await installer.addToDesktop(L("notes"));
  assert.deepEqual(added, { ok: true, app: { id: L("notes"), name: "Notes", path: `${dir}/Notes.app`, desktop: true } });
  const copy = `${desktop}/Notes.app/Contents`;
  assert.equal(fs.text(`${copy}/Info.plist`), fs.text(`${dir}/Notes.app/Contents/Info.plist`));
  assert.equal(macPlistAppId(fs.text(`${copy}/Info.plist`)), L("notes"));
  assert.equal(fs.text(`${copy}/MacOS/launcher`), macLauncherScript({ id: L("notes") }));
  assert.equal(fs.entries.get(`${copy}/MacOS/launcher`).mode, 0o755);
  assert.equal(fs.text(`${copy}/Resources/AppIcon.icns`), "icns");
  assert.equal(fs.text(`${copy}/PkgInfo`), "APPL????");
  assert.equal(calls.length, sipsRuns, "the icon is copied from the installed bundle, not made again");
  assert.deepEqual(await fs.readdir(desktop), ["Notes.app"]);
  assert.deepEqual(await installer.installedApps(), [{ id: L("notes"), name: "Notes", path: `${dir}/Notes.app`, desktop: true }]);
  assert.deepEqual(await installer.addToDesktop(L("notes")), added);
  for (const file of fs.files()) assert.ok(file.startsWith(`${dir}/`) || file.startsWith(`${desktop}/Notes.app/`) || file.startsWith(UD_MAC), file);

  assert.deepEqual(await installer.removeFromDesktop(L("notes")), { ok: true, removed: true });
  assert.deepEqual(await fs.readdir(desktop), []);
  assert.equal(await installer.isInstalled(L("notes")), true);
  assert.equal((await installer.installedApps())[0].desktop, false);
  assert.deepEqual(await installer.removeFromDesktop(L("notes")), { ok: true, removed: false });
});

test("macOS: Add to Desktop refuses an app that is not installed, a bad id, and an installer that is off", async () => {
  const { fs, installer, desktop } = mac({ makeDesktop: true });
  assert.deepEqual(await installer.addToDesktop(L("notes")), { ok: false, reason: "not-installed" });
  assert.deepEqual(await installer.addToDesktop("../x"), { ok: false, reason: "invalid-id" });
  assert.deepEqual(await installer.removeFromDesktop("../x"), { ok: false, reason: "invalid-id" });
  assert.deepEqual(await fs.readdir(desktop), []);
  const off = mac({ makeDesktop: true, enabled: false });
  assert.deepEqual(await off.installer.addToDesktop(L("notes")), { ok: false, reason: "unavailable" });
});

test("macOS: a Desktop item the person made is never replaced or removed; two apps of one name both get theirs", async () => {
  const { fs, installer, desktop } = mac({ makeDesktop: true });
  await fs.mkdir(`${desktop}/Notes.app/Contents`, { recursive: true });
  await fs.writeFile(`${desktop}/Notes.app/Contents/Info.plist`, "<plist>theirs</plist>");
  fs.entries.set(`${desktop}/Notes 2.app`, { type: "link" });
  await installer.installApp({ id: L("a"), name: "Notes" });
  await installer.installApp({ id: L("b"), name: "Notes" });
  await installer.addToDesktop(L("a"));
  await installer.addToDesktop(L("b"));
  assert.equal(fs.text(`${desktop}/Notes.app/Contents/Info.plist`), "<plist>theirs</plist>");
  assert.equal(fs.entries.get(`${desktop}/Notes 2.app`).type, "link");
  assert.equal(macPlistAppId(fs.text(`${desktop}/Notes 3.app/Contents/Info.plist`)), L("a"));
  assert.equal(macPlistAppId(fs.text(`${desktop}/Notes 2 2.app/Contents/Info.plist`)), L("b"));

  await fs.writeFile(`${desktop}/Notes 3.app/Contents/Info.plist`, macInfoPlist({ id: L("someone-else"), name: "Notes" }));
  assert.equal((await installer.installedApps()).find((a) => a.id === L("a")).desktop, false);
  assert.deepEqual(await installer.removeFromDesktop(L("a")), { ok: true, removed: true, left: [`${desktop}/Notes 3.app`] });
  assert.equal(macPlistAppId(fs.text(`${desktop}/Notes 3.app/Contents/Info.plist`)), L("someone-else"));
});

test("macOS: a renamed app's Desktop item takes the new name; one the person deleted is not brought back", async () => {
  const { fs, trashed, installer, dir, desktop } = mac({ makeDesktop: true });
  await installer.installApp({ id: L("notes"), name: "Notes" });
  await installer.addToDesktop(L("notes"));
  const renamed = await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.equal(renamed.app.desktop, true);
  assert.deepEqual(await fs.readdir(desktop), ["Journal.app"]);
  assert.equal(macPlistAppId(fs.text(`${desktop}/Journal.app/Contents/Info.plist`)), L("notes"));
  assert.match(fs.text(`${desktop}/Journal.app/Contents/Info.plist`), /<string>Journal<\/string>/);
  assert.deepEqual(trashed.sort(), [`${desktop}/Notes.app`, `${dir}/Notes.app`].sort());

  await fs.rm(`${desktop}/Journal.app`, { recursive: true });
  const again = await installer.installApp({ id: L("notes"), name: "Diary" });
  assert.equal(again.app.desktop, false);
  assert.deepEqual(await fs.readdir(desktop), []);
});

test("macOS: Uninstall and the cleanup of gone apps take the Desktop item too, and leftover Desktop staging folders", async () => {
  const { fs, dir, desktop, options } = mac({ makeDesktop: true });
  // A fresh installer for every call: what each one needs is read from disk, as after a restart.
  const installer = new Proxy({}, { get: (_target, key) => createAppInstaller(options)[key] });
  await installer.installApp({ id: L("keep"), name: "Keep" });
  await installer.installApp({ id: L("gone"), name: "Gone" });
  await installer.installApp({ id: L("bye"), name: "Bye" });
  for (const id of [L("keep"), L("gone"), L("bye")]) await installer.addToDesktop(id);
  await fs.mkdir(`${desktop}/.mausbot-0123456789abcdef.staging/Contents`, { recursive: true });
  await fs.mkdir(`${desktop}/.mausbot-mine.staging`, { recursive: true });

  assert.deepEqual(await installer.uninstallApp(L("bye")), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${desktop}/Bye.app`), false);
  assert.equal(fs.entries.has(`${dir}/Bye.app`), false);

  assert.deepEqual(await installer.cleanup([L("keep")]), [L("gone")]);
  assert.deepEqual((await fs.readdir(desktop)).sort(), [".mausbot-mine.staging", "Keep.app"]);
});

test("macOS: installing, listing, uninstalling and cleanup never look at the Desktop of someone who never added an item", async () => {
  const { fs, installer, desktop } = mac({ makeDesktop: true });
  const looked = [];
  for (const method of ["stat", "lstat", "readdir", "readFile"]) {
    const real = fs[method];
    fs[method] = (p, ...rest) => { if (p === desktop || p.startsWith(`${desktop}/`)) looked.push([method, p]); return real(p, ...rest); };
  }
  await installer.installApp({ id: L("a"), name: "A" });
  await installer.installApp({ id: L("a"), name: "B" });
  await installer.installApp({ id: L("gone"), name: "Gone" });
  await installer.installedApps();
  await installer.isInstalled(L("a"));
  await installer.cleanup([L("a")]);
  await installer.uninstallApp(L("a"));
  await installer.removeFromDesktop(L("a"));
  assert.deepEqual(looked, []);
});

test("macOS: no Desktop folder, or one that can't be written, fails and leaves the launcher as it was", async () => {
  const missing = mac();
  await missing.installer.installApp({ id: L("notes"), name: "Notes" });
  assert.deepEqual(await missing.installer.addToDesktop(L("notes")), { ok: false, reason: "no-desktop" });
  assert.equal(missing.fs.entries.has(missing.desktop), false, "the Desktop folder is never made");
  assert.equal(await missing.installer.isInstalled(L("notes")), true);

  const home = mac({ desktop: "/Users/u", makeDesktop: true });
  await home.installer.installApp({ id: L("notes"), name: "Notes" });
  assert.deepEqual(await home.installer.addToDesktop(L("notes")), { ok: false, reason: "no-desktop" });

  const locked = mac({ makeDesktop: true });
  await locked.installer.installApp({ id: L("notes"), name: "Notes" });
  locked.fs.readOnly.add(locked.desktop);
  assert.deepEqual(await locked.installer.addToDesktop(L("notes")), { ok: false, reason: "failed" });
  assert.deepEqual(await locked.fs.readdir(locked.desktop), []);
  assert.equal(await locked.installer.isInstalled(L("notes")), true);
  assert.equal((await locked.installer.installedApps())[0].desktop, false);
  locked.fs.readOnly.clear();
  assert.equal((await locked.installer.addToDesktop(L("notes"))).ok, true);

  const renameLocked = mac({ makeDesktop: true });
  await renameLocked.installer.installApp({ id: L("notes"), name: "Notes" });
  await renameLocked.installer.addToDesktop(L("notes"));
  renameLocked.fs.readOnly.add(renameLocked.desktop);
  const renamed = await renameLocked.installer.installApp({ id: L("notes"), name: "Journal" });
  assert.equal(renamed.ok, true, "a Desktop that can't be written never fails the launcher's own rename");
  assert.equal(renamed.app.desktop, true);
  assert.ok(renameLocked.fs.entries.has(`${renameLocked.desktop}/Notes.app`));
});

test("macOS: a Desktop redirected into iCloud Drive is where the item goes", async () => {
  const icloud = "/Users/u/Library/Mobile Documents/com~apple~CloudDocs/Desktop";
  const { fs, installer } = mac({ desktop: icloud, makeDesktop: true });
  await installer.installApp({ id: L("notes"), name: "Notes" });
  assert.equal((await installer.addToDesktop(L("notes"))).ok, true);
  assert.equal(macPlistAppId(fs.text(`${icloud}/Notes.app/Contents/Info.plist`)), L("notes"));
  assert.equal(fs.entries.has("/Users/u/Desktop"), false);
  assert.deepEqual(await installer.uninstallApp(L("notes")), { ok: true, removed: true });
  assert.deepEqual(await fs.readdir(icloud), []);
});

test("Windows: a Desktop shortcut like the Start menu one, refusing the person's own, following renames and moves", async () => {
  const { fs, shortcuts, installer, dir, desktop, options } = windows({ makeDesktop: true });
  await installer.installApp({ id: L("notes"), name: "Notes", iconPng: PNG });
  assert.equal(shortcuts.length, 1);
  assert.deepEqual(await installer.addToDesktop(L("notes")), { ok: true, app: { id: L("notes"), name: "Notes", path: `${dir}\\Notes.lnk`, desktop: true } });
  const [start, onDesktop] = shortcuts.map(([file, op, link]) => ({ file, op, link }));
  assert.equal(onDesktop.file, `${desktop}\\Notes.lnk`);
  assert.equal(onDesktop.op, "create");
  assert.deepEqual(onDesktop.link, start.link);
  assert.equal(onDesktop.link.target, options.executable);
  assert.equal(onDesktop.link.args, launcherLink(L("notes")));
  assert.equal(onDesktop.link.appUserModelId, windowsAppUserModelId(L("notes")));
  assert.match(onDesktop.link.icon, /\\app-install\\icons\\[0-9a-f]{16}\.ico$/);

  fs.entries.set(`${desktop}\\Mine.lnk`, { type: "file", data: Buffer.from(JSON.stringify({ target: "C:\\x.exe", args: "" })) });
  await installer.installApp({ id: L("mine"), name: "Mine" });
  await installer.addToDesktop(L("mine"));
  assert.equal(JSON.parse(fs.text(`${desktop}\\Mine.lnk`)).target, "C:\\x.exe");
  assert.ok(fs.entries.has(`${desktop}\\Mine 2.lnk`));

  await installer.installApp({ id: L("other"), name: "NOTES" });
  assert.equal((await installer.installedApps()).find((a) => a.id === L("other")).path, `${dir}\\NOTES 2.lnk`);
  await installer.addToDesktop(L("other"));
  assert.equal(shortcuts.at(-1)[0], `${desktop}\\NOTES 2.lnk`);

  await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.ok(fs.entries.has(`${desktop}\\Journal.lnk`));
  assert.equal(fs.entries.has(`${desktop}\\Notes.lnk`), false);

  const moved = createAppInstaller({ ...options, executable: "D:\\OpenMausBot\\OpenMausBot.exe" });
  assert.equal((await moved.refreshTargets()).length, 3);
  assert.equal(JSON.parse(fs.text(`${desktop}\\Journal.lnk`)).target, "D:\\OpenMausBot\\OpenMausBot.exe");

  assert.deepEqual(await installer.uninstallApp(L("notes")), { ok: true, removed: true });
  assert.equal(fs.entries.has(`${desktop}\\Journal.lnk`), false);
  assert.deepEqual(await installer.cleanup([L("mine")]), [L("other")]);
  assert.deepEqual((await fs.readdir(desktop)).sort(), ["Mine 2.lnk", "Mine.lnk"]);
  assert.deepEqual(await installer.removeFromDesktop(L("mine")), { ok: true, removed: true });
  assert.deepEqual(await fs.readdir(desktop), ["Mine.lnk"]);
});

test("Windows: a Desktop moved to OneDrive is used; a missing one fails without touching the Start menu", async () => {
  const oneDrive = "C:\\Users\\u\\OneDrive\\Desktop";
  const redirected = windows({ desktop: oneDrive, makeDesktop: true });
  await redirected.installer.installApp({ id: L("notes"), name: "Notes" });
  assert.equal((await redirected.installer.addToDesktop(L("notes"))).ok, true);
  assert.ok(redirected.fs.entries.has(`${oneDrive}\\Notes.lnk`));

  const missing = windows();
  await missing.installer.installApp({ id: L("notes"), name: "Notes" });
  assert.deepEqual(await missing.installer.addToDesktop(L("notes")), { ok: false, reason: "no-desktop" });
  assert.equal(missing.fs.entries.has(missing.desktop), false);
  assert.ok(missing.fs.entries.has(`${missing.dir}\\Notes.lnk`));

  const locked = windows({ makeDesktop: true });
  await locked.installer.installApp({ id: L("notes"), name: "Notes" });
  locked.fs.readOnly.add(locked.desktop);
  assert.deepEqual(await locked.installer.addToDesktop(L("notes")), { ok: false, reason: "failed" });
  assert.ok(locked.fs.entries.has(`${locked.dir}\\Notes.lnk`));
});

test("Windows: installing with desktopShortcut also puts one there, and never fails over the Desktop", async () => {
  const { fs, installer, desktop } = windows();
  const result = await installer.installApp({ id: L("notes"), name: "Notes", desktopShortcut: true });
  assert.equal(result.ok, true);
  assert.equal(result.app.desktop, false);
  assert.equal(fs.entries.has(desktop), false);
  fs.entries.set(desktop, { type: "dir" });
  assert.equal((await installer.installApp({ id: L("notes"), name: "Notes", desktopShortcut: true })).app.desktop, true);
  assert.equal(JSON.parse(fs.text(`${desktop}\\Notes.lnk`)).args, launcherLink(L("notes")));
});

test("Linux: an executable copy of the desktop entry in the XDG Desktop folder", async () => {
  const { fs, runs, installer, dir, options } = linux({ xdg: "/home/u/Schreibtisch", makeDesktop: "/home/u/Schreibtisch" });
  await installer.installApp({ id: L("notes"), name: "Notes" });
  assert.equal(runs.length, 0);
  assert.equal((await installer.addToDesktop(L("notes"))).app.desktop, true);
  assert.deepEqual(runs, [["xdg-user-dir", "DESKTOP"]]);
  const item = "/home/u/Schreibtisch/Notes.desktop";
  assert.equal(fs.text(item), fs.text(`${dir}/mausbot-app-${L("notes")}.desktop`));
  assert.equal(fs.entries.get(item).mode, 0o755);
  assert.match(fs.text(item), /^X-OpenMausBot-LocalApp=la_notes00000000000$/m);

  await fs.writeFile("/home/u/Schreibtisch/Budget.desktop", "[Desktop Entry]\nName=Budget\n");
  await installer.installApp({ id: L("budget"), name: "Budget" });
  await installer.addToDesktop(L("budget"));
  assert.equal(fs.text("/home/u/Schreibtisch/Budget.desktop"), "[Desktop Entry]\nName=Budget\n");
  assert.ok(fs.entries.has("/home/u/Schreibtisch/Budget 2.desktop"));

  await installer.installApp({ id: L("twin"), name: "Notes" });
  await installer.addToDesktop(L("twin"));
  assert.match(fs.text("/home/u/Schreibtisch/Notes 2.desktop"), /^X-OpenMausBot-LocalApp=la_twin000000000000$/m);

  await installer.installApp({ id: L("notes"), name: "Journal" });
  assert.equal(fs.entries.has(item), false);
  assert.match(fs.text("/home/u/Schreibtisch/Journal.desktop"), /^Name=Journal$/m);

  const moved = createAppInstaller({ ...options, executable: "/opt/OpenMausBot/openmausbot" });
  await moved.refreshTargets();
  assert.match(fs.text("/home/u/Schreibtisch/Journal.desktop"), /^Exec="\/opt\/OpenMausBot\/openmausbot" /m);
  assert.equal(fs.entries.get("/home/u/Schreibtisch/Journal.desktop").mode, 0o755);
  assert.equal(fs.entries.get(`${dir}/mausbot-app-${L("notes")}.desktop`).mode, 0o644);

  await fs.writeFile("/home/u/Schreibtisch/Journal.desktop", desktopEntry({ id: L("theirs"), name: "Journal", executable: "/x" }));
  assert.deepEqual(await createAppInstaller(options).uninstallApp(L("notes")), { ok: true, removed: true, left: ["/home/u/Schreibtisch/Journal.desktop"] });
  assert.ok(fs.entries.has("/home/u/Schreibtisch/Journal.desktop"));
  assert.deepEqual(await createAppInstaller(options).cleanup([L("budget")]), [L("twin")]);
  assert.deepEqual((await fs.readdir("/home/u/Schreibtisch")).sort(), ["Budget 2.desktop", "Budget.desktop", "Journal.desktop"]);
});

test("Linux: ~/Desktop when xdg-user-dir is missing or names the home folder; no folder at all fails", async () => {
  for (const xdg of [null, "/home/u", "relative/Desktop", "/a\n/b"]) {
    const { fs, installer } = linux({ xdg, makeDesktop: "/home/u/Desktop" });
    await installer.installApp({ id: L("notes"), name: "Notes" });
    assert.equal((await installer.addToDesktop(L("notes"))).ok, true, String(xdg));
    assert.equal(fs.entries.get("/home/u/Desktop/Notes.desktop").mode, 0o755);
  }
  const { fs, installer, dir } = linux({ xdg: "/home/u/Desktop" });
  await installer.installApp({ id: L("notes"), name: "Notes" });
  assert.deepEqual(await installer.addToDesktop(L("notes")), { ok: false, reason: "no-desktop" });
  assert.equal(fs.entries.has("/home/u/Desktop"), false);
  assert.ok(fs.entries.has(`${dir}/mausbot-app-${L("notes")}.desktop`));
});

test("Desktop items stay inside the Desktop folder whatever the app's name", async () => {
  const { fs, installer, desktop } = mac({ makeDesktop: true });
  for (const [short, name] of [["a", "../../Library/x"], ["b", "/etc/passwd"], ["c", "..."], ["d", "a\u202Eb"]]) {
    await installer.installApp({ id: L(short), name });
    assert.equal((await installer.addToDesktop(L(short))).ok, true, name);
  }
  for (const file of fs.files().filter((f) => !f.startsWith("/Users/u/Applications/") && !f.startsWith(UD_MAC))) {
    assert.ok(file.startsWith(`${desktop}/`) && !file.slice(desktop.length + 1).split("/")[0].startsWith("."), file);
  }
  assert.equal(windowsShortcut({ id: L("a"), name: "x", executable: "C:\\x.exe" }).args, launcherLink(L("a")));
});
