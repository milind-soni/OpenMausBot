// The US keyboard layout below is Puppeteer's USKeyboardLayout
// (packages/puppeteer-core/src/common/USKeyboardLayout.ts, puppeteer-core
// 24.37.5), Copyright 2017 Google Inc., licensed under the Apache License,
// Version 2.0 (third_party/puppeteer/LICENSE). The key description rules in
// keyDescription() follow Puppeteer's CdpKeyboard (src/cdp/Input.ts) under the
// same license. Modified: compacted to one line per key and typed for OMB.

import type { CdpSession } from "./connection.ts";
import { DriverError } from "./errors.ts";

export interface KeyDefinition {
  keyCode?: number;
  shiftKeyCode?: number;
  key?: string;
  shiftKey?: string;
  code?: string;
  text?: string;
  shiftText?: string;
  location?: number;
}

export const US_KEYBOARD: Readonly<Record<string, KeyDefinition>> = {
  "0": { keyCode: 48, key: "0", code: "Digit0" },
  "1": { keyCode: 49, key: "1", code: "Digit1" },
  "2": { keyCode: 50, key: "2", code: "Digit2" },
  "3": { keyCode: 51, key: "3", code: "Digit3" },
  "4": { keyCode: 52, key: "4", code: "Digit4" },
  "5": { keyCode: 53, key: "5", code: "Digit5" },
  "6": { keyCode: 54, key: "6", code: "Digit6" },
  "7": { keyCode: 55, key: "7", code: "Digit7" },
  "8": { keyCode: 56, key: "8", code: "Digit8" },
  "9": { keyCode: 57, key: "9", code: "Digit9" },
  Power: { key: "Power", code: "Power" },
  Eject: { key: "Eject", code: "Eject" },
  Abort: { keyCode: 3, key: "Cancel", code: "Abort" },
  Help: { keyCode: 6, key: "Help", code: "Help" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Numpad5: { keyCode: 12, shiftKeyCode: 101, key: "Clear", shiftKey: "5", code: "Numpad5", location: 3 },
  NumpadEnter: { keyCode: 13, key: "Enter", code: "NumpadEnter", text: "\r", location: 3 },
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  "\r": { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  "\n": { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  ShiftLeft: { keyCode: 16, key: "Shift", code: "ShiftLeft", location: 1 },
  ShiftRight: { keyCode: 16, key: "Shift", code: "ShiftRight", location: 2 },
  ControlLeft: { keyCode: 17, key: "Control", code: "ControlLeft", location: 1 },
  ControlRight: { keyCode: 17, key: "Control", code: "ControlRight", location: 2 },
  AltLeft: { keyCode: 18, key: "Alt", code: "AltLeft", location: 1 },
  AltRight: { keyCode: 18, key: "Alt", code: "AltRight", location: 2 },
  Pause: { keyCode: 19, key: "Pause", code: "Pause" },
  CapsLock: { keyCode: 20, key: "CapsLock", code: "CapsLock" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Convert: { keyCode: 28, key: "Convert", code: "Convert" },
  NonConvert: { keyCode: 29, key: "NonConvert", code: "NonConvert" },
  Space: { keyCode: 32, key: " ", code: "Space" },
  Numpad9: { keyCode: 33, shiftKeyCode: 105, key: "PageUp", shiftKey: "9", code: "Numpad9", location: 3 },
  PageUp: { keyCode: 33, key: "PageUp", code: "PageUp" },
  Numpad3: { keyCode: 34, shiftKeyCode: 99, key: "PageDown", shiftKey: "3", code: "Numpad3", location: 3 },
  PageDown: { keyCode: 34, key: "PageDown", code: "PageDown" },
  End: { keyCode: 35, key: "End", code: "End" },
  Numpad1: { keyCode: 35, shiftKeyCode: 97, key: "End", shiftKey: "1", code: "Numpad1", location: 3 },
  Home: { keyCode: 36, key: "Home", code: "Home" },
  Numpad7: { keyCode: 36, shiftKeyCode: 103, key: "Home", shiftKey: "7", code: "Numpad7", location: 3 },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
  Numpad4: { keyCode: 37, shiftKeyCode: 100, key: "ArrowLeft", shiftKey: "4", code: "Numpad4", location: 3 },
  Numpad8: { keyCode: 38, shiftKeyCode: 104, key: "ArrowUp", shiftKey: "8", code: "Numpad8", location: 3 },
  ArrowUp: { keyCode: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowRight: { keyCode: 39, key: "ArrowRight", code: "ArrowRight" },
  Numpad6: { keyCode: 39, shiftKeyCode: 102, key: "ArrowRight", shiftKey: "6", code: "Numpad6", location: 3 },
  Numpad2: { keyCode: 40, shiftKeyCode: 98, key: "ArrowDown", shiftKey: "2", code: "Numpad2", location: 3 },
  ArrowDown: { keyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  Select: { keyCode: 41, key: "Select", code: "Select" },
  Open: { keyCode: 43, key: "Execute", code: "Open" },
  PrintScreen: { keyCode: 44, key: "PrintScreen", code: "PrintScreen" },
  Insert: { keyCode: 45, key: "Insert", code: "Insert" },
  Numpad0: { keyCode: 45, shiftKeyCode: 96, key: "Insert", shiftKey: "0", code: "Numpad0", location: 3 },
  Delete: { keyCode: 46, key: "Delete", code: "Delete" },
  NumpadDecimal: { keyCode: 46, shiftKeyCode: 110, key: "\u0000", shiftKey: ".", code: "NumpadDecimal", location: 3 },
  Digit0: { keyCode: 48, key: "0", shiftKey: ")", code: "Digit0" },
  Digit1: { keyCode: 49, key: "1", shiftKey: "!", code: "Digit1" },
  Digit2: { keyCode: 50, key: "2", shiftKey: "@", code: "Digit2" },
  Digit3: { keyCode: 51, key: "3", shiftKey: "#", code: "Digit3" },
  Digit4: { keyCode: 52, key: "4", shiftKey: "$", code: "Digit4" },
  Digit5: { keyCode: 53, key: "5", shiftKey: "%", code: "Digit5" },
  Digit6: { keyCode: 54, key: "6", shiftKey: "^", code: "Digit6" },
  Digit7: { keyCode: 55, key: "7", shiftKey: "&", code: "Digit7" },
  Digit8: { keyCode: 56, key: "8", shiftKey: "*", code: "Digit8" },
  Digit9: { keyCode: 57, key: "9", shiftKey: "(", code: "Digit9" },
  KeyA: { keyCode: 65, key: "a", shiftKey: "A", code: "KeyA" },
  KeyB: { keyCode: 66, key: "b", shiftKey: "B", code: "KeyB" },
  KeyC: { keyCode: 67, key: "c", shiftKey: "C", code: "KeyC" },
  KeyD: { keyCode: 68, key: "d", shiftKey: "D", code: "KeyD" },
  KeyE: { keyCode: 69, key: "e", shiftKey: "E", code: "KeyE" },
  KeyF: { keyCode: 70, key: "f", shiftKey: "F", code: "KeyF" },
  KeyG: { keyCode: 71, key: "g", shiftKey: "G", code: "KeyG" },
  KeyH: { keyCode: 72, key: "h", shiftKey: "H", code: "KeyH" },
  KeyI: { keyCode: 73, key: "i", shiftKey: "I", code: "KeyI" },
  KeyJ: { keyCode: 74, key: "j", shiftKey: "J", code: "KeyJ" },
  KeyK: { keyCode: 75, key: "k", shiftKey: "K", code: "KeyK" },
  KeyL: { keyCode: 76, key: "l", shiftKey: "L", code: "KeyL" },
  KeyM: { keyCode: 77, key: "m", shiftKey: "M", code: "KeyM" },
  KeyN: { keyCode: 78, key: "n", shiftKey: "N", code: "KeyN" },
  KeyO: { keyCode: 79, key: "o", shiftKey: "O", code: "KeyO" },
  KeyP: { keyCode: 80, key: "p", shiftKey: "P", code: "KeyP" },
  KeyQ: { keyCode: 81, key: "q", shiftKey: "Q", code: "KeyQ" },
  KeyR: { keyCode: 82, key: "r", shiftKey: "R", code: "KeyR" },
  KeyS: { keyCode: 83, key: "s", shiftKey: "S", code: "KeyS" },
  KeyT: { keyCode: 84, key: "t", shiftKey: "T", code: "KeyT" },
  KeyU: { keyCode: 85, key: "u", shiftKey: "U", code: "KeyU" },
  KeyV: { keyCode: 86, key: "v", shiftKey: "V", code: "KeyV" },
  KeyW: { keyCode: 87, key: "w", shiftKey: "W", code: "KeyW" },
  KeyX: { keyCode: 88, key: "x", shiftKey: "X", code: "KeyX" },
  KeyY: { keyCode: 89, key: "y", shiftKey: "Y", code: "KeyY" },
  KeyZ: { keyCode: 90, key: "z", shiftKey: "Z", code: "KeyZ" },
  MetaLeft: { keyCode: 91, key: "Meta", code: "MetaLeft", location: 1 },
  MetaRight: { keyCode: 92, key: "Meta", code: "MetaRight", location: 2 },
  ContextMenu: { keyCode: 93, key: "ContextMenu", code: "ContextMenu" },
  NumpadMultiply: { keyCode: 106, key: "*", code: "NumpadMultiply", location: 3 },
  NumpadAdd: { keyCode: 107, key: "+", code: "NumpadAdd", location: 3 },
  NumpadSubtract: { keyCode: 109, key: "-", code: "NumpadSubtract", location: 3 },
  NumpadDivide: { keyCode: 111, key: "/", code: "NumpadDivide", location: 3 },
  F1: { keyCode: 112, key: "F1", code: "F1" },
  F2: { keyCode: 113, key: "F2", code: "F2" },
  F3: { keyCode: 114, key: "F3", code: "F3" },
  F4: { keyCode: 115, key: "F4", code: "F4" },
  F5: { keyCode: 116, key: "F5", code: "F5" },
  F6: { keyCode: 117, key: "F6", code: "F6" },
  F7: { keyCode: 118, key: "F7", code: "F7" },
  F8: { keyCode: 119, key: "F8", code: "F8" },
  F9: { keyCode: 120, key: "F9", code: "F9" },
  F10: { keyCode: 121, key: "F10", code: "F10" },
  F11: { keyCode: 122, key: "F11", code: "F11" },
  F12: { keyCode: 123, key: "F12", code: "F12" },
  F13: { keyCode: 124, key: "F13", code: "F13" },
  F14: { keyCode: 125, key: "F14", code: "F14" },
  F15: { keyCode: 126, key: "F15", code: "F15" },
  F16: { keyCode: 127, key: "F16", code: "F16" },
  F17: { keyCode: 128, key: "F17", code: "F17" },
  F18: { keyCode: 129, key: "F18", code: "F18" },
  F19: { keyCode: 130, key: "F19", code: "F19" },
  F20: { keyCode: 131, key: "F20", code: "F20" },
  F21: { keyCode: 132, key: "F21", code: "F21" },
  F22: { keyCode: 133, key: "F22", code: "F22" },
  F23: { keyCode: 134, key: "F23", code: "F23" },
  F24: { keyCode: 135, key: "F24", code: "F24" },
  NumLock: { keyCode: 144, key: "NumLock", code: "NumLock" },
  ScrollLock: { keyCode: 145, key: "ScrollLock", code: "ScrollLock" },
  AudioVolumeMute: { keyCode: 173, key: "AudioVolumeMute", code: "AudioVolumeMute" },
  AudioVolumeDown: { keyCode: 174, key: "AudioVolumeDown", code: "AudioVolumeDown" },
  AudioVolumeUp: { keyCode: 175, key: "AudioVolumeUp", code: "AudioVolumeUp" },
  MediaTrackNext: { keyCode: 176, key: "MediaTrackNext", code: "MediaTrackNext" },
  MediaTrackPrevious: { keyCode: 177, key: "MediaTrackPrevious", code: "MediaTrackPrevious" },
  MediaStop: { keyCode: 178, key: "MediaStop", code: "MediaStop" },
  MediaPlayPause: { keyCode: 179, key: "MediaPlayPause", code: "MediaPlayPause" },
  Semicolon: { keyCode: 186, key: ";", shiftKey: ":", code: "Semicolon" },
  Equal: { keyCode: 187, key: "=", shiftKey: "+", code: "Equal" },
  NumpadEqual: { keyCode: 187, key: "=", code: "NumpadEqual", location: 3 },
  Comma: { keyCode: 188, key: ",", shiftKey: "<", code: "Comma" },
  Minus: { keyCode: 189, key: "-", shiftKey: "_", code: "Minus" },
  Period: { keyCode: 190, key: ".", shiftKey: ">", code: "Period" },
  Slash: { keyCode: 191, key: "/", shiftKey: "?", code: "Slash" },
  Backquote: { keyCode: 192, key: "`", shiftKey: "~", code: "Backquote" },
  BracketLeft: { keyCode: 219, key: "[", shiftKey: "{", code: "BracketLeft" },
  Backslash: { keyCode: 220, key: "\\", shiftKey: "|", code: "Backslash" },
  BracketRight: { keyCode: 221, key: "]", shiftKey: "}", code: "BracketRight" },
  Quote: { keyCode: 222, key: "'", shiftKey: "\"", code: "Quote" },
  AltGraph: { keyCode: 225, key: "AltGraph", code: "AltGraph" },
  Props: { keyCode: 247, key: "CrSel", code: "Props" },
  Cancel: { keyCode: 3, key: "Cancel", code: "Abort" },
  Clear: { keyCode: 12, key: "Clear", code: "Numpad5", location: 3 },
  Shift: { keyCode: 16, key: "Shift", code: "ShiftLeft", location: 1 },
  Control: { keyCode: 17, key: "Control", code: "ControlLeft", location: 1 },
  Alt: { keyCode: 18, key: "Alt", code: "AltLeft", location: 1 },
  Accept: { keyCode: 30, key: "Accept" },
  ModeChange: { keyCode: 31, key: "ModeChange" },
  " ": { keyCode: 32, key: " ", code: "Space" },
  Print: { keyCode: 42, key: "Print" },
  Execute: { keyCode: 43, key: "Execute", code: "Open" },
  "\u0000": { keyCode: 46, key: "\u0000", code: "NumpadDecimal", location: 3 },
  a: { keyCode: 65, key: "a", code: "KeyA" },
  b: { keyCode: 66, key: "b", code: "KeyB" },
  c: { keyCode: 67, key: "c", code: "KeyC" },
  d: { keyCode: 68, key: "d", code: "KeyD" },
  e: { keyCode: 69, key: "e", code: "KeyE" },
  f: { keyCode: 70, key: "f", code: "KeyF" },
  g: { keyCode: 71, key: "g", code: "KeyG" },
  h: { keyCode: 72, key: "h", code: "KeyH" },
  i: { keyCode: 73, key: "i", code: "KeyI" },
  j: { keyCode: 74, key: "j", code: "KeyJ" },
  k: { keyCode: 75, key: "k", code: "KeyK" },
  l: { keyCode: 76, key: "l", code: "KeyL" },
  m: { keyCode: 77, key: "m", code: "KeyM" },
  n: { keyCode: 78, key: "n", code: "KeyN" },
  o: { keyCode: 79, key: "o", code: "KeyO" },
  p: { keyCode: 80, key: "p", code: "KeyP" },
  q: { keyCode: 81, key: "q", code: "KeyQ" },
  r: { keyCode: 82, key: "r", code: "KeyR" },
  s: { keyCode: 83, key: "s", code: "KeyS" },
  t: { keyCode: 84, key: "t", code: "KeyT" },
  u: { keyCode: 85, key: "u", code: "KeyU" },
  v: { keyCode: 86, key: "v", code: "KeyV" },
  w: { keyCode: 87, key: "w", code: "KeyW" },
  x: { keyCode: 88, key: "x", code: "KeyX" },
  y: { keyCode: 89, key: "y", code: "KeyY" },
  z: { keyCode: 90, key: "z", code: "KeyZ" },
  Meta: { keyCode: 91, key: "Meta", code: "MetaLeft", location: 1 },
  "*": { keyCode: 106, key: "*", code: "NumpadMultiply", location: 3 },
  "+": { keyCode: 107, key: "+", code: "NumpadAdd", location: 3 },
  "-": { keyCode: 109, key: "-", code: "NumpadSubtract", location: 3 },
  "/": { keyCode: 111, key: "/", code: "NumpadDivide", location: 3 },
  ";": { keyCode: 186, key: ";", code: "Semicolon" },
  "=": { keyCode: 187, key: "=", code: "Equal" },
  ",": { keyCode: 188, key: ",", code: "Comma" },
  ".": { keyCode: 190, key: ".", code: "Period" },
  "`": { keyCode: 192, key: "`", code: "Backquote" },
  "[": { keyCode: 219, key: "[", code: "BracketLeft" },
  "\\": { keyCode: 220, key: "\\", code: "Backslash" },
  "]": { keyCode: 221, key: "]", code: "BracketRight" },
  "'": { keyCode: 222, key: "'", code: "Quote" },
  Attn: { keyCode: 246, key: "Attn" },
  CrSel: { keyCode: 247, key: "CrSel", code: "Props" },
  ExSel: { keyCode: 248, key: "ExSel" },
  EraseEof: { keyCode: 249, key: "EraseEof" },
  Play: { keyCode: 250, key: "Play" },
  ZoomOut: { keyCode: 251, key: "ZoomOut" },
  ")": { keyCode: 48, key: ")", code: "Digit0" },
  "!": { keyCode: 49, key: "!", code: "Digit1" },
  "@": { keyCode: 50, key: "@", code: "Digit2" },
  "#": { keyCode: 51, key: "#", code: "Digit3" },
  $: { keyCode: 52, key: "$", code: "Digit4" },
  "%": { keyCode: 53, key: "%", code: "Digit5" },
  "^": { keyCode: 54, key: "^", code: "Digit6" },
  "&": { keyCode: 55, key: "&", code: "Digit7" },
  "(": { keyCode: 57, key: "(", code: "Digit9" },
  A: { keyCode: 65, key: "A", code: "KeyA" },
  B: { keyCode: 66, key: "B", code: "KeyB" },
  C: { keyCode: 67, key: "C", code: "KeyC" },
  D: { keyCode: 68, key: "D", code: "KeyD" },
  E: { keyCode: 69, key: "E", code: "KeyE" },
  F: { keyCode: 70, key: "F", code: "KeyF" },
  G: { keyCode: 71, key: "G", code: "KeyG" },
  H: { keyCode: 72, key: "H", code: "KeyH" },
  I: { keyCode: 73, key: "I", code: "KeyI" },
  J: { keyCode: 74, key: "J", code: "KeyJ" },
  K: { keyCode: 75, key: "K", code: "KeyK" },
  L: { keyCode: 76, key: "L", code: "KeyL" },
  M: { keyCode: 77, key: "M", code: "KeyM" },
  N: { keyCode: 78, key: "N", code: "KeyN" },
  O: { keyCode: 79, key: "O", code: "KeyO" },
  P: { keyCode: 80, key: "P", code: "KeyP" },
  Q: { keyCode: 81, key: "Q", code: "KeyQ" },
  R: { keyCode: 82, key: "R", code: "KeyR" },
  S: { keyCode: 83, key: "S", code: "KeyS" },
  T: { keyCode: 84, key: "T", code: "KeyT" },
  U: { keyCode: 85, key: "U", code: "KeyU" },
  V: { keyCode: 86, key: "V", code: "KeyV" },
  W: { keyCode: 87, key: "W", code: "KeyW" },
  X: { keyCode: 88, key: "X", code: "KeyX" },
  Y: { keyCode: 89, key: "Y", code: "KeyY" },
  Z: { keyCode: 90, key: "Z", code: "KeyZ" },
  ":": { keyCode: 186, key: ":", code: "Semicolon" },
  "<": { keyCode: 188, key: "<", code: "Comma" },
  _: { keyCode: 189, key: "_", code: "Minus" },
  ">": { keyCode: 190, key: ">", code: "Period" },
  "?": { keyCode: 191, key: "?", code: "Slash" },
  "~": { keyCode: 192, key: "~", code: "Backquote" },
  "{": { keyCode: 219, key: "{", code: "BracketLeft" },
  "|": { keyCode: 220, key: "|", code: "Backslash" },
  "}": { keyCode: 221, key: "}", code: "BracketRight" },
  "\"": { keyCode: 222, key: "\"", code: "Quote" },
  SoftLeft: { key: "SoftLeft", code: "SoftLeft", location: 4 },
  SoftRight: { key: "SoftRight", code: "SoftRight", location: 4 },
  Camera: { keyCode: 44, key: "Camera", code: "Camera", location: 4 },
  Call: { key: "Call", code: "Call", location: 4 },
  EndCall: { keyCode: 95, key: "EndCall", code: "EndCall", location: 4 },
  VolumeDown: { keyCode: 182, key: "VolumeDown", code: "VolumeDown", location: 4 },
  VolumeUp: { keyCode: 183, key: "VolumeUp", code: "VolumeUp", location: 4 },
};

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type Modifier = keyof typeof MODIFIER_BITS;

const MODIFIER_NAMES: Readonly<Record<string, Modifier | "ControlOrMeta">> = {
  alt: "Alt",
  option: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  shift: "Shift",
  controlormeta: "ControlOrMeta",
  cmdorctrl: "ControlOrMeta",
};

const KEY_NAMES: Readonly<Record<string, string>> = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pgup: "PageUp",
  pgdn: "PageDown",
  ins: "Insert",
};

const NAMED_KEYS = new Map(Object.keys(US_KEYBOARD).filter((name) => name.length > 1).map((name) => [name.toLowerCase(), name]));

/** A printable character and the physical key that types it, shifted or not. */
const TYPED = new Map<string, { code: string; shift: boolean }>();
for (const [name, definition] of Object.entries(US_KEYBOARD)) {
  if (name !== definition.code || definition.location) continue;
  const text = definition.text ?? definition.key;
  if (text && text.length === 1 && !TYPED.has(text)) TYPED.set(text, { code: name, shift: false });
  const shifted = definition.shiftText ?? definition.shiftKey;
  if (shifted && shifted.length === 1 && !TYPED.has(shifted)) TYPED.set(shifted, { code: name, shift: true });
}
TYPED.set("\n", { code: "Enter", shift: false });
TYPED.set("\t", { code: "Tab", shift: false });
TYPED.set(" ", { code: "Space", shift: false });

export interface Chord {
  modifiers: Modifier[];
  key: string;
}

function keyName(name: string): string {
  if (US_KEYBOARD[name]) return name;
  const lower = name.toLowerCase();
  const found = KEY_NAMES[lower] ?? NAMED_KEYS.get(lower);
  if (found) return found;
  throw new DriverError("execution", `Unknown key "${name}". Use a key name such as Enter, Tab, ArrowDown or a single character.`);
}

/** "Control+Shift+A", "ControlOrMeta+a", "Shift++". ControlOrMeta is Meta on macOS. */
export function parseChord(chord: string, mac: boolean): Chord {
  const trimmed = chord.trim();
  if (!trimmed) throw new DriverError("execution", "No key was given.");
  const parts = trimmed === "+" ? ["+"] : trimmed.endsWith("++") ? [...trimmed.slice(0, -2).split("+"), "+"] : trimmed.split("+");
  const key = parts.pop() ?? "";
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const named = MODIFIER_NAMES[part.trim().toLowerCase()];
    if (!named) throw new DriverError("execution", `Unknown modifier "${part}". Use Alt, Control, Meta, Shift or ControlOrMeta.`);
    const modifier = named === "ControlOrMeta" ? (mac ? "Meta" : "Control") : named;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { modifiers, key: keyName(key) };
}

/** Headless Chromium runs copy and cut only as editing commands, and on macOS the Meta shortcuts too (no AppKit key bindings). */
export function editingCommands(key: string, modifiers: number, mac: boolean): string[] {
  const held = modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta);
  const lower = key.toLowerCase();
  if (held === (mac ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control)) {
    if (lower === "c" || lower === "keyc") return ["copy"];
    if (lower === "x" || lower === "keyx") return ["cut"];
  }
  if (mac && held === MODIFIER_BITS.Meta) {
    if (lower === "a" || lower === "keya") return ["selectAll"];
    if (lower === "v" || lower === "keyv") return ["paste"];
    if (lower === "z" || lower === "keyz") return [modifiers & MODIFIER_BITS.Shift ? "redo" : "undo"];
  }
  return [];
}

interface KeyDescription {
  keyCode: number;
  key: string;
  text: string;
  code: string;
  location: number;
}

export function keyDescription(name: string, modifiers: number): KeyDescription {
  const definition = US_KEYBOARD[name];
  if (!definition) throw new DriverError("execution", `Unknown key "${name}".`);
  const shift = (modifiers & MODIFIER_BITS.Shift) !== 0;
  const description: KeyDescription = { key: "", keyCode: 0, code: "", text: "", location: 0 };
  if (definition.key) description.key = definition.key;
  if (shift && definition.shiftKey) description.key = definition.shiftKey;
  if (definition.keyCode) description.keyCode = definition.keyCode;
  if (shift && definition.shiftKeyCode) description.keyCode = definition.shiftKeyCode;
  if (definition.code) description.code = definition.code;
  if (definition.location) description.location = definition.location;
  if (description.key.length === 1) description.text = description.key;
  if (definition.text) description.text = definition.text;
  if (shift && definition.shiftText) description.text = definition.shiftText;
  if (modifiers & ~MODIFIER_BITS.Shift) description.text = "";
  return description;
}

const modifierBit = (key: string): number => (key in MODIFIER_BITS ? MODIFIER_BITS[key as Modifier] : 0);

/** Trusted key events for one page. Every event goes through Input.dispatchKeyEvent. */
export class Keyboard {
  readonly #session: CdpSession;
  readonly #mac: boolean;
  readonly #pressed = new Set<string>();
  #modifiers = 0;

  constructor(session: CdpSession, { mac }: { mac: boolean }) {
    this.#session = session;
    this.#mac = mac;
  }

  get modifiers(): number {
    return this.#modifiers;
  }

  async down(name: string, commands: string[] = []): Promise<void> {
    const description = keyDescription(name, this.#modifiers);
    const autoRepeat = this.#pressed.has(description.code);
    this.#pressed.add(description.code);
    this.#modifiers |= modifierBit(description.key);
    const text = description.text;
    await this.#session.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: this.#modifiers,
      windowsVirtualKeyCode: description.keyCode,
      code: description.code,
      key: description.key,
      text,
      unmodifiedText: text,
      autoRepeat,
      location: description.location,
      isKeypad: description.location === 3,
      ...(commands.length ? { commands } : {}),
    });
  }

  async up(name: string): Promise<void> {
    const description = keyDescription(name, this.#modifiers);
    this.#modifiers &= ~modifierBit(description.key);
    this.#pressed.delete(description.code);
    await this.#session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: this.#modifiers,
      key: description.key,
      windowsVirtualKeyCode: description.keyCode,
      code: description.code,
      location: description.location,
    });
  }

  /** A character goes through its physical key, so Shift changes it as on a real keyboard; a bare shifted character holds Shift. */
  async press(chord: string): Promise<void> {
    const { modifiers, key } = parseChord(chord, this.#mac);
    const typed = key.length === 1 ? TYPED.get(key) : undefined;
    const name = typed?.code ?? key;
    const held: Modifier[] = typed?.shift && !modifiers.length ? ["Shift"] : modifiers;
    for (const modifier of held) await this.down(modifier);
    try {
      await this.down(name, editingCommands(name, this.#modifiers, this.#mac));
      await this.up(name);
    } finally {
      for (const modifier of [...held].reverse()) await this.up(modifier);
    }
  }

  /** Key events per character, Shift held for shifted ones; characters the US layout lacks are inserted as text. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      const typed = TYPED.get(char);
      if (!typed) {
        await this.insertText(char);
        continue;
      }
      if (typed.shift) await this.down("Shift");
      try {
        await this.down(typed.code);
        await this.up(typed.code);
      } finally {
        if (typed.shift) await this.up("Shift");
      }
    }
  }

  async insertText(text: string): Promise<void> {
    await this.#session.send("Input.insertText", { text });
  }

  /** Lets go of every key still held, so the next person or action starts clean. */
  async releaseAll(): Promise<void> {
    for (const code of this.#pressed) {
      const name = Object.keys(US_KEYBOARD).find((candidate) => US_KEYBOARD[candidate]?.code === code);
      if (name) await this.up(name).catch(() => {});
    }
    this.#pressed.clear();
    this.#modifiers = 0;
  }
}
