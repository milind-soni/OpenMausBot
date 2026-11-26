import { useSyncExternalStore } from "react";

import { windowPrefChanged } from "./window-pref-changes";

/** Local preference key for triggering Start fresh from the keyboard. */
export const START_FRESH_SHORTCUT_KEY = "omb-start-fresh-shortcut";
export const DEFAULT_START_FRESH_SHORTCUT = "mod+shift+k";

export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.ogb?.platform) {
    return window.ogb.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

export interface ShortcutChord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const SPECIAL_KEYS: Record<string, { mac: string; win: string }> = {
  backspace: { mac: "⌫", win: "Backspace" },
  delete: { mac: "⌦", win: "Delete" },
};

const PUNCTUATION_KEYS = new Set(["[", "]", "\\", "/", ",", ".", ";", "'", "-", "=", "`"]);
const SHIFTED_SYMBOL_TO_BASE: Record<string, string> = {
  "{": "[",
  "}": "]",
  "|": "\\",
  "?": "/",
  "<": ",",
  ">": ".",
  ":": ";",
  "\"": "'",
  "_": "-",
  "+": "=",
  "~": "`",
};

const MODIFIER_ONLY_KEYS = new Set([
  "Meta",
  "Control",
  "Shift",
  "Alt",
  "AltGraph",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
]);

function normalizeKeyToken(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (/^[a-z0-9]$/.test(lower)) return lower;
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower;
  if (lower === "backspace" || lower === "delete") return lower;
  if (PUNCTUATION_KEYS.has(lower)) return lower;
  return null;
}

export function parseShortcutChord(raw: string | null | undefined): ShortcutChord | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "off") return null;

  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (i < parts.length - 1) {
      if (part === "mod") mod = true;
      else if (part === "ctrl") ctrl = true;
      else if (part === "alt") alt = true;
      else if (part === "shift") shift = true;
      else return null;
    } else {
      key = normalizeKeyToken(part);
    }
  }

  if (!key || (!mod && !ctrl)) return null;
  return { mod, ctrl, alt, shift, key };
}

export function formatCanonicalChord(chord: ShortcutChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("mod");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

export const DEFAULT_START_FRESH_CHORD: ShortcutChord = parseShortcutChord(DEFAULT_START_FRESH_SHORTCUT)!;

export function isDefaultStartFreshShortcut(chord: ShortcutChord | null): boolean {
  return chord !== null && formatCanonicalChord(chord) === DEFAULT_START_FRESH_SHORTCUT;
}

export function shortcutChordKeys(chord: ShortcutChord, isMac: boolean = isMacPlatform()): string[] {
  const keys: string[] = [];
  if (isMac) {
    if (chord.mod) keys.push("⌘");
    if (chord.ctrl) keys.push("⌃");
    if (chord.alt) keys.push("⌥");
    if (chord.shift) keys.push("⇧");
  } else {
    if (chord.mod || chord.ctrl) keys.push("Ctrl");
    if (chord.alt) keys.push("Alt");
    if (chord.shift) keys.push("Shift");
  }
  const special = SPECIAL_KEYS[chord.key];
  if (special) {
    keys.push(isMac ? special.mac : special.win);
  } else if (/^f\d+$/.test(chord.key) || /^[a-z]$/.test(chord.key)) {
    keys.push(chord.key.toUpperCase());
  } else {
    keys.push(chord.key);
  }
  return keys;
}

function eventKeyToken(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey">,
  { usePhysicalLetterWhenAlt }: { usePhysicalLetterWhenAlt: boolean },
): string | null {
  const rawKey = event.key;
  const lower = rawKey.toLowerCase();
  if (lower === "backspace" || lower === "delete") return lower;
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower;

  // On macOS, Option/Alt produces accented/symbol glyphs in `event.key`; recover A-Z/0-9 from `event.code`.
  if (usePhysicalLetterWhenAlt && event.altKey) {
    if (event.code && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
    if (event.code && /^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  }

  if (/^[a-z]$/.test(lower)) return lower;
  if (event.code && /^Key[A-Z]$/.test(event.code) && !/^[a-z]$/.test(lower)) {
    return event.code.slice(3).toLowerCase();
  }

  if (/^[0-9]$/.test(rawKey)) return rawKey;
  if (event.code && /^Digit[0-9]$/.test(event.code)) {
    return event.code.slice(5);
  }

  if (PUNCTUATION_KEYS.has(rawKey)) return rawKey;
  const unshifted = SHIFTED_SYMBOL_TO_BASE[rawKey];
  if (unshifted && PUNCTUATION_KEYS.has(unshifted)) return unshifted;

  return null;
}

export type CaptureChordResult =
  | { ok: true; chord: ShortcutChord }
  | { ok: false; reason: "modifier-only" | "need-modifier" | "unsupported" };

export function chordFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean = isMacPlatform(),
): CaptureChordResult {
  if (MODIFIER_ONLY_KEYS.has(event.key)) {
    return { ok: false, reason: "modifier-only" };
  }

  const mod = isMac ? event.metaKey : event.ctrlKey;
  const ctrl = isMac ? event.ctrlKey : false;
  if (!mod && !ctrl) {
    return { ok: false, reason: "need-modifier" };
  }

  const key = eventKeyToken(event, { usePhysicalLetterWhenAlt: true });
  if (!key) {
    return { ok: false, reason: "unsupported" };
  }

  return {
    ok: true,
    chord: {
      mod,
      ctrl,
      alt: event.altKey,
      shift: event.shiftKey,
      key,
    },
  };
}

export function matchesShortcutChord(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing" | "keyCode">,
  chord: ShortcutChord | null,
  isMac: boolean = isMacPlatform(),
): boolean {
  if (!chord || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;

  if (isMac) {
    if (event.metaKey !== chord.mod || event.ctrlKey !== chord.ctrl || event.altKey !== chord.alt || event.shiftKey !== chord.shift) {
      return false;
    }
  } else {
    const expectsCtrl = chord.mod || chord.ctrl;
    if (event.ctrlKey !== expectsCtrl || event.metaKey || event.altKey !== chord.alt || event.shiftKey !== chord.shift) {
      return false;
    }
  }

  const token = eventKeyToken(event, { usePhysicalLetterWhenAlt: isMac && chord.alt });
  return token === chord.key;
}

const BUILTIN_CHORDS: ReadonlyArray<{ chord: string; itemId: string }> = [
  { chord: "mod+k", itemId: "command-palette" },
  { chord: "mod+n", itemId: "new-bot" },
  { chord: "mod+shift+n", itemId: "new-thread" },
  { chord: "mod+t", itemId: "new-thread" },
  ...Array.from({ length: 9 }, (_, i) => ({ chord: `mod+${i + 1}`, itemId: "jump-bot" })),
  { chord: "mod+\\", itemId: "toggle-sidebar" },
  { chord: "mod+shift+[", itemId: "switch-bot" },
  { chord: "mod+shift+]", itemId: "switch-bot" },
  { chord: "mod+f", itemId: "find-conversation" },
  { chord: "mod+d", itemId: "dictation-toggle" },
  { chord: "mod+/", itemId: "shortcuts-cheat-sheet" },
  { chord: "mod+shift+m", itemId: "live-call-mute" },
  { chord: "mod+shift+h", itemId: "live-call-hang-up" },
];

const RESERVED_CHORDS = new Set([
  "mod+r",
  "mod+shift+r",
  "mod+w",
  "mod+q",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+a",
  "mod+z",
  "mod+shift+z",
  "mod+,",
  "mod+m",
  "mod+=",
  "mod+-",
  "mod+0",
  "mod+alt+i",
  "mod+shift+i",
  "mod+h",
]);

function effectiveCanonical(chord: ShortcutChord, isMac: boolean): string {
  if (isMac) return formatCanonicalChord(chord);
  // Outside macOS, Ctrl serves both `mod` and `ctrl`.
  return formatCanonicalChord({ ...chord, mod: chord.mod || chord.ctrl, ctrl: false });
}

export function shortcutConflict(
  chord: ShortcutChord,
  isMac: boolean = isMacPlatform(),
): { kind: "builtin"; itemId: string } | { kind: "reserved" } | null {
  const canonical = effectiveCanonical(chord, isMac);
  const builtin = BUILTIN_CHORDS.find((entry) => entry.chord === canonical);
  if (builtin) return { kind: "builtin", itemId: builtin.itemId };
  if (RESERVED_CHORDS.has(canonical)) return { kind: "reserved" };
  return null;
}

let sessionChoice: ShortcutChord | null | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStartFreshShortcut(): ShortcutChord | null {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    const raw = storage()?.getItem(START_FRESH_SHORTCUT_KEY);
    if (raw === null || raw === undefined) return DEFAULT_START_FRESH_CHORD;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "" || normalized === "off") return null;
    return parseShortcutChord(normalized) ?? DEFAULT_START_FRESH_CHORD;
  } catch {
    return DEFAULT_START_FRESH_CHORD;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== START_FRESH_SHORTCUT_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setStartFreshShortcut(chord: ShortcutChord | null): void {
  sessionChoice = chord;
  try {
    storage()?.setItem(START_FRESH_SHORTCUT_KEY, chord ? formatCanonicalChord(chord) : "off");
  } catch {
  }
  notify();
  windowPrefChanged();
}

export function resetStartFreshShortcut(): void {
  sessionChoice = DEFAULT_START_FRESH_CHORD;
  try {
    storage()?.removeItem(START_FRESH_SHORTCUT_KEY);
  } catch {
  }
  notify();
  windowPrefChanged();
}

/** Reset cached state for tests when stubbing or clearing localStorage outside StorageEvents. */
export function resetStartFreshShortcutCache(): void {
  sessionChoice = undefined;
}

export function useStartFreshShortcut(): ShortcutChord | null {
  return useSyncExternalStore(subscribe, readStartFreshShortcut, readStartFreshShortcut);
}
