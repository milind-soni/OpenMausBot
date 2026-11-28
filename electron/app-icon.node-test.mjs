import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { APP_ICON_CHOICE_FILE, APP_ICON_MAX_BYTES, appIconState, applyAppIcon, clearAppIcon, installAppIconHandlers, readAppIconChoice, resolveAppIcon, saveAppIcon } from "./app-icon.mjs";

const DEFAULT = "/app/default-icon.png";

function dataDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "app-icon-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function picture(dir, name, bytes = "image") {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

/** The parts of Electron's nativeImage the icon code reads. */
function nativeImage(sizes = {}) {
  return {
    createFromPath(file) {
      const empty = file.includes("empty");
      const size = sizes[path.basename(file)] ?? { width: 512, height: 512 };
      return { isEmpty: () => empty, getSize: () => size };
    },
  };
}

test("with no saved icon the app's own picture is used", (t) => {
  const dir = dataDir(t);
  assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: DEFAULT, custom: false });
});

test("a chosen picture is copied into the data folder, remembered, and used", (t) => {
  const dir = dataDir(t);
  const outside = dataDir(t);
  const source = picture(outside, "My Icon.png");
  const saved = saveAppIcon({ userData: dir, imagePath: source, nativeImage: nativeImage() });
  assert.equal(saved.ok, true);
  assert.equal(saved.name, "My Icon.png");
  assert.equal(saved.path, path.join(dir, "app-icon.png"));
  assert.equal(readFileSync(saved.path, "utf8"), "image", "the bytes are copied");
  assert.deepEqual(readAppIconChoice(dir), { file: "app-icon.png", name: "My Icon.png" });
  assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: path.join(dir, "app-icon.png"), custom: true, name: "My Icon.png" });
});

test("a missing or renamed copy falls back to the app's own picture", (t) => {
  const dir = dataDir(t);
  saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "icon.png"), nativeImage: nativeImage() });
  rmSync(path.join(dir, "app-icon.png"));
  assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: DEFAULT, custom: false });
});

test("changing the picture removes the copy it replaces", (t) => {
  const dir = dataDir(t);
  saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "one.png"), nativeImage: nativeImage() });
  const saved = saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "two.ico"), nativeImage: nativeImage() });
  assert.equal(saved.ok, true);
  assert.equal(existsSync(path.join(dir, "app-icon.png")), false);
  assert.equal(existsSync(path.join(dir, "app-icon.ico")), true);
});

test("a picture the app cannot use leaves the current icon and choice alone", (t) => {
  const dir = dataDir(t);
  saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "good.png"), nativeImage: nativeImage() });
  const before = readAppIconChoice(dir);
  const cases = [
    ["notes.txt", "extension"],
    ["empty.png", "unreadable"],
    ["tiny.png", "dimensions"],
    ["huge.png", "dimensions"],
  ];
  const images = nativeImage({ "tiny.png": { width: 8, height: 8 }, "huge.png": { width: 5000, height: 5000 } });
  for (const [name, problem] of cases) {
    const saved = saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), name), nativeImage: images });
    assert.deepEqual(saved, { ok: false, problem }, name);
  }
  const big = picture(dataDir(t), "big.png", Buffer.alloc(APP_ICON_MAX_BYTES + 1));
  assert.deepEqual(saveAppIcon({ userData: dir, imagePath: big, nativeImage: images }), { ok: false, problem: "size" });
  assert.deepEqual(readAppIconChoice(dir), before);
  assert.equal(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }).custom, true);
});

test("a saved name that is not our own icon file is never followed, and a broken file means no choice", (t) => {
  const dir = dataDir(t);
  writeFileSync(path.join(dir, "config.json"), "{}");
  for (const file of ["../outside.png", "..\\outside.png", "nested/icon.png", ".", "..", "", "config.json", "app-icon.exe"]) {
    writeFileSync(path.join(dir, APP_ICON_CHOICE_FILE), JSON.stringify({ file }));
    assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: DEFAULT, custom: false }, file);
  }
  writeFileSync(path.join(dir, APP_ICON_CHOICE_FILE), "{ not json");
  assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: DEFAULT, custom: false });
});

test("clearing removes the copy and the saved choice", (t) => {
  const dir = dataDir(t);
  saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "icon.png"), nativeImage: nativeImage() });
  clearAppIcon(dir);
  assert.equal(existsSync(path.join(dir, "app-icon.png")), false);
  assert.equal(existsSync(path.join(dir, APP_ICON_CHOICE_FILE)), false);
  assert.deepEqual(resolveAppIcon({ userData: dir, defaultPath: DEFAULT }), { path: DEFAULT, custom: false });
});

test("the settings row reads the saved name and a small preview", (t) => {
  const dir = dataDir(t);
  const previewImage = { isEmpty: () => false, resize: () => ({ toDataURL: () => "data:image/png;base64,small" }) };
  assert.deepEqual(appIconState({ userData: dir, defaultPath: DEFAULT, nativeImage: { createFromPath: () => previewImage } }), { custom: false, preview: "data:image/png;base64,small" });
  saveAppIcon({ userData: dir, imagePath: picture(dataDir(t), "moon.png"), nativeImage: nativeImage() });
  assert.deepEqual(appIconState({ userData: dir, defaultPath: DEFAULT, nativeImage: { createFromPath: () => previewImage } }), { custom: true, name: "moon.png", preview: "data:image/png;base64,small" });
});

test("an icon is applied to the Dock on macOS, the windows elsewhere, and the trays everywhere", () => {
  const calls = [];
  const app = { dock: { setIcon: (icon) => calls.push(["dock", icon]) } };
  const nativeImage = { createFromPath: () => ({ isEmpty: () => false }) };
  const window = { setIcon: (icon) => calls.push(["window", icon]) };
  const activity = { setIcon: (icon) => calls.push(["activity", icon]) };
  const tray = { setIcon: (icon) => calls.push(["tray", icon]) };
  applyAppIcon("chosen.png", { platform: "darwin", app, nativeImage, windows: [window], trays: [tray], activity });
  assert.deepEqual(calls.map(([where]) => where), ["dock", "tray", "activity"]);
  calls.length = 0;
  applyAppIcon("chosen.png", { platform: "win32", app, nativeImage, windows: [window], trays: [tray], activity });
  assert.deepEqual(calls.map(([where]) => where), ["window", "tray", "activity"]);
  assert.deepEqual(applyAppIcon("chosen.png", { platform: "darwin", app: { dock: { setIcon() { throw new Error("no dock here"); } } }, nativeImage, windows: [], trays: [], activity: null }), undefined);
});

test("the settings routes choose a picture, report a refusal, and reset", async (t) => {
  const dir = dataDir(t);
  const handlers = new Map();
  const applied = [];
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
  const app = { getPath: () => dir, dock: { setIcon() {} } };
  const images = nativeImage();
  installAppIconHandlers({
    ipcMain, app, nativeImage: images, defaultPath: DEFAULT, t: (key) => key,
    localOnly: (_name, handler) => handler,
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [picture(dataDir(t), "chosen.png")] }) },
    apply: (iconPath) => applied.push(iconPath),
  });
  assert.deepEqual([...handlers.keys()], ["desktop:app-icon:state", "desktop:app-icon:choose", "desktop:app-icon:reset"]);
  assert.equal(handlers.get("desktop:app-icon:state")().custom, false);
  const chosen = await handlers.get("desktop:app-icon:choose")({ sender: {} });
  assert.equal(chosen.outcome, "saved");
  assert.equal(chosen.state.custom, true);
  assert.deepEqual(applied, [path.join(dir, "app-icon.png")]);
  const reset = handlers.get("desktop:app-icon:reset")();
  assert.equal(reset.outcome, "reset");
  assert.equal(reset.state.custom, false);
  assert.deepEqual(applied, [path.join(dir, "app-icon.png"), DEFAULT]);
});
