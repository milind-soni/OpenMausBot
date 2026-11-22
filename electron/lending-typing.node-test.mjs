import assert from "node:assert/strict";
import { test } from "node:test";

import { createLendingIndicator } from "./lending-indicator.mjs";

const ready = { ready: true, reason: null };
const TYPING = "When you type on this PC, bots use it";

function trayMenu(device) {
  const trays = [];
  class Tray { constructor() { trays.push(this); } on() {} setToolTip(tip) { this.tip = tip; } setTitle() {} setContextMenu(menu) { this.menu = menu; } isDestroyed() { return false; } destroy() {} }
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, onTerminal: () => {}, device });
  return { update: view => indicator.update(view), labels: () => trays[0].menu.filter(item => item.label).map(item => item.label), item: label => trays[0].menu.find(item => item.label === label), tip: () => trays[0].tip };
}

test("a computer a Cloud can use now says its bots use it while the person types on it", () => {
  const tray = trayMenu("PC");
  tray.update({ clouds: ["My Cloud"], screen: ready, typing: true });
  assert.deepEqual(tray.labels().slice(0, 2), ["My Cloud can use this PC", TYPING]);
  assert.equal(tray.item(TYPING).enabled, false, "a plain line, not an action");
  assert.equal(tray.tip(), "OpenMausBot: My Cloud can use this PC", "the tooltip stays short");

  tray.update({ clouds: ["My Cloud"], screen: { ready: false, reason: "desktop-host-stopped", fix: "start" }, typing: true });
  assert.equal(tray.labels().indexOf(TYPING), tray.labels().indexOf("Pause") - 1, "after the screen line and its fix, so those stay together");
});

test("the typing line is left out where no Cloud takes this computer as the one typed on", () => {
  const tray = trayMenu("PC");
  tray.update({ clouds: ["Garage server"], screen: ready });
  assert.ok(!tray.labels().includes(TYPING), "a server of the person's own does not match the typing computer");
  tray.update({ clouds: ["My Cloud"], paused: true, screen: ready, typing: true });
  assert.ok(!tray.labels().includes(TYPING), "not while paused");
  tray.update({ clouds: ["My Cloud"], pauseError: "not saved", screen: ready, typing: true });
  assert.ok(!tray.labels().includes(TYPING), "not while a pause failed to save");
});
