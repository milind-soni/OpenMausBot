import { finishedNotificationsEnabled, readSoundChoice } from "../notification-preferences";
import { createEventSounds } from "./events";
import { createSoundPlayer, type HoldReason, type SoundOutput } from "./player";
import type { SoundEvent, SoundStyle } from "./render";

export { SOUND_STYLES, type SoundChoice, type SoundEvent, type SoundStyle } from "./render";

export const SOUND_WINDOW_KEY = "omb-sound-window";
const windowId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function isSoundWindow(): boolean {
  try {
    const current = storage()?.getItem(SOUND_WINDOW_KEY);
    return !current || current === windowId;
  } catch {
    return true;
  }
}

function claimSoundWindow(): void {
  try {
    const local = storage();
    if (local && local.getItem(SOUND_WINDOW_KEY) !== windowId) local.setItem(SOUND_WINDOW_KEY, windowId);
  } catch {
    // Without storage every window counts as the one in use.
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

const eventSounds = createEventSounds({ play: (event) => player.play(event), now, finishedNotices: finishedNotificationsEnabled });

export const playAppSound = (event: SoundEvent): boolean => player.play(event);
export const holdAppSounds = (reason: HoldReason): (() => void) => player.hold(reason);
export const previewAppSound = (style: SoundStyle): void => player.preview(style);
export const notificationSound = eventSounds.notified;
export const replySound = eventSounds.replied;

/** The system banner stays silent whenever the app speaks for itself: sounds are off, this window can already play
 * them, or another window of the app is the one in use. Only an untouched window that is the one in use, where a browser
 * would refuse the app's own sound, leaves the chime to the system. */
export function bannerSilent(): boolean {
  return readSoundChoice() === "off" || player.unlocked() || !isSoundWindow();
}

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
}
