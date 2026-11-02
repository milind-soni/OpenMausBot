// Whether this computer's apps and screen are lent to the person's own Clouds, and what the icon's menu says when they
// aren't: read from computer control's own state on Windows, macOS and Linux.
import assert from "node:assert/strict";
import { test } from "node:test";

import { automaticGrant } from "./computer-sharing.mjs";
import { createLendingIndicator, indicatorText } from "./lending-indicator.mjs";
import { screenStatus } from "./screen-status.mjs";
import { askPromptWords, screenFixLabel, screenLine } from "./screen-words.mjs";
import { driverFailure } from "./cua-failure.mjs";

const embedded = (extra = {}) => ({
  mode: "embedded", socketPath: "\\\\.\\pipe\\cua-driver-1234", mcpCommand: "C:\\Program Files\\OpenMausBot\\resources\\cua-driver.exe",
  mcpArgs: ["mcp", "--embedded", "--socket", "\\\\.\\pipe\\cua-driver-1234"], mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app" }, ...extra,
});

test("a PC lends its apps and screen once its own embedded computer control runs, and never through another driver", () => {
  assert.deepEqual(screenStatus({ platform: "win32", connection: embedded() }), { ready: true, lent: true, reason: null, fix: null });
  assert.equal(automaticGrant({ screen: screenStatus({ platform: "win32", connection: embedded() }).lent }).screen, true);
  // A driver the person installed themselves answers on a pipe this app does not own.
  const standalone = screenStatus({ platform: "win32", connection: embedded({ mode: "standalone" }) });
  assert.deepEqual({ lent: standalone.lent, reason: standalone.reason }, { lent: false, reason: "not-running" });
  assert.equal(automaticGrant({ screen: standalone.lent }).screen, false);
  for (const broken of [embedded({ socketPath: "" }), embedded({ mcpArgs: ["serve"] }), embedded({ mcpEnv: { CUA_DRIVER_EMBEDDED: 1 } }), embedded({ status: "error" })]) {
    assert.equal(screenStatus({ platform: "win32", connection: broken }).lent, false, JSON.stringify(broken));
  }
  assert.equal(screenStatus({ platform: "win32", connection: embedded(), remote: true }).lent, false, "a remote companion lends nothing of this computer");
});

test("why a PC's apps and screen aren't lent, and the one fix", () => {
  const starting = screenStatus({ platform: "win32", connection: { mode: "unavailable", reason: "not-started" } });
  assert.deepEqual({ reason: starting.reason, fix: starting.fix }, { reason: "starting", fix: null });
  const timedOut = screenStatus({ platform: "win32", connection: { mode: "unavailable", reason: "embedded host failed: StartupTimeout: timeoutMs 10000" } });
  assert.deepEqual({ reason: timedOut.reason, fix: timedOut.fix }, { reason: "not-running", fix: "start" });
  for (const reason of [
    "embedded host failed: Spawn: binaryPath C:\\OpenMausBot\\resources\\cua-driver-background.exe; reason Access is denied. (os error 5)",
    "embedded host failed: Spawn: reason Operation did not complete successfully because the file contains a virus or potentially unwanted software. (os error 225)",
    "cua-driver binary not found",
    "embedded host failed: Packaged background CUA driver is missing; reinstall OpenMausBot",
  ]) {
    const blocked = screenStatus({ platform: "win32", connection: { mode: "unavailable", reason } });
    assert.deepEqual({ reason: blocked.reason, fix: blocked.fix }, { reason: "blocked", fix: "start" }, reason);
  }
  assert.equal(screenLine(timedOut, "PC"), "Screen control isn't running on this PC");
  assert.equal(screenFixLabel(timedOut), "Start screen control");
  assert.equal(screenLine({ ready: false, reason: "blocked" }, "PC"), "Screen control is blocked: Windows Security may have stopped it");
});

test("a Mac lacking only macOS's permissions still lends them, so a bot's first need asks macOS; Linux control is off until turned on", () => {
  const mac = screenStatus({ platform: "darwin", connection: { mode: "unavailable", reason: "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings and restart OpenMausBot" } });
  assert.deepEqual(mac, { ready: false, lent: true, reason: "permissions", fix: "allow" });
  assert.equal(screenFixLabel(mac), "Allow screen control…");
  const linux = screenStatus({ platform: "linux", connection: { schemaVersion: 1, platform: "linux", mode: "unavailable", enabled: false, status: "disabled", reasonCode: "opt-in-required" } });
  assert.deepEqual({ lent: linux.lent, reason: linux.reason, fix: linux.fix }, { lent: false, reason: "off", fix: "start" });
  assert.equal(screenFixLabel(linux), "Turn on screen control");
  const wayland = screenStatus({ platform: "linux", connection: { mode: "unavailable", status: "unavailable", reasonCode: "linux-wayland-seat-safety-blocked",
    message: "Local control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer." } });
  assert.deepEqual({ reason: wayland.reason, fix: wayland.fix }, { reason: "unsupported", fix: null });
  assert.equal(screenFixLabel(wayland), null, "nothing here can fix a Wayland session");
});

test("the icon's menu says plainly what the Clouds can't use, why, and offers the fix", () => {
  const notRunning = screenStatus({ platform: "win32", connection: { mode: "unavailable", reason: "desktop-host-stopped" } });
  assert.deepEqual(indicatorText({ clouds: ["My Cloud"], using: [], paused: false, screen: notRunning }, "PC"),
    { line: "My Cloud can use this PC, but not its apps and screen", title: "", screen: "Screen control isn't running on this PC" });
  assert.deepEqual(indicatorText({ clouds: ["My Cloud"], using: [], paused: false, screen: { ready: true, reason: null } }, "PC"),
    { line: "My Cloud can use this PC", title: "", screen: null });
  assert.equal(indicatorText({ clouds: ["My Cloud"], using: [], paused: true, screen: notRunning }, "PC").screen, null, "paused says only that");

  const trays = [];
  let started = 0;
  class Tray { constructor() { trays.push(this); } on() {} setToolTip(tip) { this.tip = tip; } setTitle() {} setContextMenu(menu) { this.menu = menu; } isDestroyed() { return false; } destroy() {} }
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, onTerminal: () => {}, onStartScreen: () => { started++; }, device: "PC" });
  indicator.update({ clouds: ["My Cloud"], screen: notRunning });
  const [line, why, fix] = trays[0].menu;
  assert.deepEqual([line.label, line.enabled, why.label, why.enabled, fix.label], ["My Cloud can use this PC, but not its apps and screen", false, "Screen control isn't running on this PC", false, "Start screen control"]);
  assert.equal(trays[0].tip, "OpenMausBot: My Cloud can use this PC, but not its apps and screen. Screen control isn't running on this PC");
  fix.click();
  assert.equal(started, 1, "one click starts screen control");
  indicator.update({ clouds: ["My Cloud"], screen: { ready: true, lent: true, reason: null, fix: null } });
  assert.deepEqual(trays[0].menu.filter(item => item.label).map(item => item.label), ["My Cloud can use this PC", "Pause", "Let Clouds run commands on this PC", "See activity"]);
});

test("the app's own prompt names the bot, its Cloud, what it wants and why, and why it can't now", () => {
  assert.deepEqual(askPromptWords({ bot: "Scout", need: "screen", reason: "not-running", why: "Fill in the invoice in Excel" }, { cloud: "My Cloud", device: "PC" }), {
    message: "Scout on My Cloud wants to use this PC's apps and screen",
    detail: "“Fill in the invoice in Excel”\n\nScreen control isn't running on this PC.",
    buttons: ["Turn on", "Not now"],
  });
  assert.equal(askPromptWords({ bot: "Scout", need: "folders", reason: "paused" }, { cloud: "My Cloud", device: "Mac" }).detail, "Using this Mac is paused.");
  assert.equal(askPromptWords({ bot: "Scout", need: "terminal", reason: "terminal-off" }, { cloud: "My Cloud", device: "computer" }).message, "Scout on My Cloud wants to run commands on this computer");
});

test("a failed start keeps the reason Windows gave, not only the kind of failure", () => {
  const spawn = Object.assign(new Error("EmbeddedDriverError.Spawn"), { tag: "Spawn", inner: { binaryPath: "C:\\x\\cua-driver-background.exe", reason: "Access is denied. (os error 5)" } });
  assert.equal(driverFailure(spawn), "Spawn: binaryPath C:\\x\\cua-driver-background.exe; reason Access is denied. (os error 5)");
  assert.equal(driverFailure(Object.assign(new Error("EmbeddedDriverError.StartupTimeout"), { tag: "StartupTimeout", inner: { timeoutMs: 10_000n } })), "StartupTimeout: timeoutMs 10000");
  assert.equal(driverFailure(new Error("plain")), "plain");
});

test("the menu never says a Cloud can use this computer before that Cloud accepts it (#4078)", () => {
  const ready = { ready: true, reason: null };
  assert.deepEqual(indicatorText({ clouds: ["Debian Server"], using: [], paused: false, screen: ready, waiting: ["Debian Server"] }, "Mac"),
    { line: "Waiting for Debian Server to accept this Mac", title: "", screen: null });
  assert.deepEqual(indicatorText({ clouds: ["My Cloud", "Debian Server"], using: [], paused: false, screen: ready, waiting: ["Debian Server"] }, "Mac"),
    { line: "My Cloud can use this Mac", title: "", screen: null, pending: "Waiting for Debian Server to accept this Mac" });
  assert.equal(indicatorText({ clouds: ["Debian Server"], using: [], paused: true, screen: ready, waiting: [] }, "Mac").line,
    "Paused: Debian Server can't use this Mac", "paused is unchanged");

  const trays = [];
  class Tray { constructor() { trays.push(this); } on() {} setToolTip(tip) { this.tip = tip; } setTitle() {} setContextMenu(menu) { this.menu = menu; } isDestroyed() { return false; } destroy() {} }
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, onTerminal: () => {}, device: "Mac" });
  indicator.update({ clouds: ["My Cloud", "Debian Server"], waiting: ["Debian Server"], screen: ready });
  assert.deepEqual(trays[0].menu.filter(item => item.label).map(item => item.label),
    ["My Cloud can use this Mac", "Waiting for Debian Server to accept this Mac", "Pause", "Let Clouds run commands on this Mac", "See activity"]);
  assert.equal(trays[0].tip, "OpenMausBot: My Cloud can use this Mac. Waiting for Debian Server to accept this Mac");
  indicator.update({ clouds: ["My Cloud", "Debian Server"], waiting: [], screen: ready });
  assert.equal(trays[0].menu[0].label, "My Cloud and Debian Server can use this Mac", "accepted: the waiting line goes away");
});
