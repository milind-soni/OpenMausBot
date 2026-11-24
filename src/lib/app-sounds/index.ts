import { finishedNotificationsEnabled, readSoundChoice } from "../notification-preferences";
import { createEventSounds } from "./events";
import { createSoundPlayer, type HoldReason, type SoundDecision, type SoundOutput } from "./player";
import type { SoundEvent, SoundStyle } from "./render";

export { SOUND_STYLES, type SoundChoice, type SoundEvent, type SoundStyle } from "./render";
export type { SoundDecision, SoundOutcome } from "./player";

export const SOUND_WINDOW_KEY = "omb-sound-window";
/** How often the window in use says it is still open, and how long others wait before taking over from a silent one.
 * Chrome 88+ wakes a hidden page's timers about once a minute, so the wait outlasts that. */
export const SOUND_WINDOW_HEARTBEAT_MS = 15_000;
export const SOUND_WINDOW_STALE_MS = 90_000;
const windowId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readSoundWindow(): { id: string; at: number } | null {
  try {
    const value = JSON.parse(storage()?.getItem(SOUND_WINDOW_KEY) ?? "null") as { id?: unknown; at?: unknown } | null;
    return value && typeof value.id === "string" && typeof value.at === "number" ? { id: value.id, at: value.at } : null;
  } catch {
    return null;
  }
}

function claimSoundWindow(): void {
  try {
    storage()?.setItem(SOUND_WINDOW_KEY, JSON.stringify({ id: windowId, at: Date.now() }));
  } catch {
    // Without storage every window counts as the one in use.
  }
}

/** The window used last leads; when it closed or stopped answering, the first open window that asks takes over. */
export function isSoundWindow(): boolean {
  const lead = readSoundWindow();
  if (lead && lead.id !== windowId && Date.now() - lead.at < SOUND_WINDOW_STALE_MS) return false;
  if (lead?.id !== windowId) claimSoundWindow();
  return true;
}

function stillOpen(): void {
  if (readSoundWindow()?.id === windowId) claimSoundWindow();
}

function closing(): void {
  try {
    if (readSoundWindow()?.id === windowId) storage()?.removeItem(SOUND_WINDOW_KEY);
  } catch {
    // Nothing to hand over without storage.
  }
}

function createOutput(): SoundOutput | null {
  const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    return new Context();
  } catch {
    return null;
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const player = createSoundPlayer({
  now,
  choice: readSoundChoice,
  background: () => typeof document === "undefined" || document.visibilityState === "hidden" || !document.hasFocus(),
  leader: isSoundWindow,
  createOutput,
});

const eventSounds = createEventSounds({ play: (event) => player.play(event), now, finishedNotices: finishedNotificationsEnabled, soundsOn: () => readSoundChoice() !== "off" && !player.holding() });

export const playAppSound = (event: SoundEvent): SoundDecision => player.play(event);
export const holdAppSounds = (reason: HoldReason): (() => void) => player.hold(reason);
export const previewAppSound = (style: SoundStyle): SoundDecision => player.preview(style);
export const notificationSound = eventSounds.notified;
export const replySound = eventSounds.replied;

let started = false;
export function startAppSounds(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const used = () => {
    player.unlock();
    claimSoundWindow();
  };
  window.addEventListener("pointerdown", used, { capture: true, passive: true });
  window.addEventListener("keydown", used, { capture: true });
  window.addEventListener("focus", claimSoundWindow);
  window.addEventListener("pagehide", closing);
  setInterval(stillOpen, SOUND_WINDOW_HEARTBEAT_MS);
}
