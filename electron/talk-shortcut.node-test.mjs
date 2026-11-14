import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createDesktopPrefs } from "./desktop-prefs.mjs";
import { createCallPresence, createTalkShortcut, TALK_SHORTCUT_UNAVAILABLE } from "./talk-shortcut.mjs";

const memoryPrefs = () => {
  let saved = null;
  return createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
};
const fakeShortcuts = (taken = []) => {
  const registered = new Map();
  return { registered, register: (accelerator, fn) => !taken.includes(accelerator) && Boolean(registered.set(accelerator, fn)),
    unregister: accelerator => { registered.delete(accelerator); } };
};
const KEYS = [{ id: "ctrl-opt-space", label: "⌃⌥Space" }, { id: "ctrl-shift-space", label: "⌃⇧Space" }, { id: "opt-shift-space", label: "⌥⇧Space" }];

test("registers the saved key when on; a press reaches onPress", () => {
  const shortcuts = fakeShortcuts(); let presses = 0;
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs: memoryPrefs(), available: () => true, onPress: () => { presses += 1; } });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Alt+Space"]);
  shortcuts.registered.get("Control+Alt+Space")();
  assert.equal(presses, 1);
  assert.deepEqual(talk.state(), { available: true, enabled: true, key: "ctrl-opt-space", keys: KEYS, taken: false });
  assert.deepEqual(talk.releaseModifiers(), ["control", "option"]);
});

test("a key another app holds is reported, and another key can be chosen", () => {
  const shortcuts = fakeShortcuts(["Control+Alt+Space"]); const prefs = memoryPrefs();
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs, available: () => true, onPress: () => {} });
  assert.equal(talk.state().taken, true);
  assert.deepEqual(talk.set({ key: "ctrl-shift-space" }), { available: true, enabled: true, key: "ctrl-shift-space", keys: KEYS, taken: false });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Shift+Space"]);
  assert.deepEqual(talk.releaseModifiers(), ["control", "shift"]);
  assert.equal(prefs.talkKey(), "ctrl-shift-space");
});

test("off lets the key go, on takes it again, close lets it go", () => {
  const shortcuts = fakeShortcuts(); const prefs = memoryPrefs();
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs, available: () => true, onPress: () => {} });
  assert.equal(talk.set({ enabled: false }).enabled, false);
  assert.deepEqual([...shortcuts.registered.keys()], []);
  assert.equal(prefs.talkShortcut(), false);
  assert.equal(talk.state().taken, false);
  talk.set({ enabled: true });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Alt+Space"]);
  talk.close();
  assert.deepEqual([...shortcuts.registered.keys()], []);
});

test("an unknown key changes nothing", () => {
  const shortcuts = fakeShortcuts(); const prefs = memoryPrefs();
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs, available: () => true, onPress: () => {} });
  talk.set({ key: "cmd-space" });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Alt+Space"]);
  assert.equal(prefs.talkKey(), "ctrl-opt-space");
});

test("where Apple speech is unavailable nothing registers and nothing changes", () => {
  const shortcuts = fakeShortcuts(); const prefs = memoryPrefs();
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs, available: () => false, onPress: () => {} });
  assert.deepEqual([...shortcuts.registered.keys()], []);
  assert.equal(talk.state().available, false);
  talk.set({ enabled: false, key: "opt-shift-space" });
  assert.equal(prefs.talkShortcut(), true);
  assert.equal(prefs.talkKey(), "ctrl-opt-space");
  assert.deepEqual([...shortcuts.registered.keys()], []);
});

test("refresh lets the key go once it is no longer available and takes it again when it is, keeping the saved choice", () => {
  const shortcuts = fakeShortcuts(); const prefs = memoryPrefs(); let available = true; let registrations = 0;
  const counting = { ...shortcuts, register: (accelerator, fn) => { registrations += 1; return shortcuts.register(accelerator, fn); } };
  const talk = createTalkShortcut({ globalShortcut: counting, prefs, available: () => available, onPress: () => {} });
  talk.set({ key: "ctrl-shift-space" });
  talk.refresh();
  assert.equal(registrations, 2, "nothing changed, so the key is not taken again");
  available = false;
  talk.refresh();
  assert.deepEqual([...shortcuts.registered.keys()], []);
  assert.equal(talk.state().available, false);
  talk.refresh();
  assert.equal(registrations, 2);
  available = true;
  talk.refresh();
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Shift+Space"]);
  assert.deepEqual(talk.state(), { available: true, enabled: true, key: "ctrl-shift-space", keys: KEYS, taken: false });

  const off = memoryPrefs(); off.setTalkShortcut(false); let offAvailable = false;
  const quiet = fakeShortcuts();
  const later = createTalkShortcut({ globalShortcut: quiet, prefs: off, available: () => offAvailable, onPress: () => {} });
  offAvailable = true;
  later.refresh();
  assert.deepEqual([...quiet.registered.keys()], [], "turned off stays off");
});

test("a shortcut not set up says it is unavailable, in the same shape as a real one", () => {
  assert.deepEqual(TALK_SHORTCUT_UNAVAILABLE, { available: false, enabled: false, key: "ctrl-opt-space", keys: KEYS, taken: false });
  const real = createTalkShortcut({ globalShortcut: fakeShortcuts(), prefs: memoryPrefs(), available: () => false, onPress: () => {} }).state();
  assert.deepEqual(Object.keys(TALK_SHORTCUT_UNAVAILABLE).sort(), Object.keys(real).sort());
  assert.ok(Object.isFrozen(TALK_SHORTCUT_UNAVAILABLE));
});

test("a reported call blocks until it ends, its page navigates, or its renderer goes away", () => {
  const presence = createCallPresence(), page = Object.assign(new EventEmitter(), { id: 1 });
  presence.set(page, true); assert.equal(presence.active(), true);
  presence.set(page, false); assert.equal(presence.active(), false);
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    presence.set(page, true); page.emit(event); assert.equal(presence.active(), false, event);
  }
  for (let i = 0; i < 5; i += 1) presence.set(page, true);
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) assert.equal(page.listenerCount(event), 1, event);
});
