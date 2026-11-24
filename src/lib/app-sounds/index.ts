import { finishedNotificationsEnabled, readSoundChoice } from "../notification-preferences";
import { createEventSounds, type NotificationSoundEntry } from "./events";
import { createSoundPlayer, type HoldReason, type PlayDecision, type PlayOutcome, type SoundDecision, type SoundOutcome, type SoundOutput } from "./player";
import type { SoundEvent, SoundStyle } from "./render";

export { SOUND_STYLES, type SoundChoice, type SoundEvent, type SoundStyle } from "./render";
export type { SoundDecision, SoundOutcome } from "./player";

export const SOUND_WINDOW_KEY = "omb-sound-window";
/** How often the window in use says it is still open, and how long others wait before taking over from a silent one.
 * Chrome 88+ wakes a hidden page's timers about once a minute, so the wait outlasts that. */
export const SOUND_WINDOW_HEARTBEAT_MS = 15_000;
export const SOUND_WINDOW_STALE_MS = 90_000;
export const SOUND_ACK_KEY = "omb-sound-ack";
/** How long a window in the background waits for the window in use to say it took a notice, before chiming itself. */
export const SOUND_ACK_WAIT_MS = 1_500;
const ACK_KEPT_MS = 10_000;
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

function readAcks(): Array<{ id: string; at: number }> {
  try {
    const value = JSON.parse(storage()?.getItem(SOUND_ACK_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((ack): ack is { id: string; at: number } => typeof ack?.id === "string" && typeof ack?.at === "number") : [];
  } catch {
    return [];
  }
}

const acknowledged = (key: string) => readAcks().some((ack) => ack.id === key);

function acknowledge(key: string): void {
  const now = Date.now();
  try {
    const kept = readAcks().filter((ack) => ack.id !== key && now - ack.at < ACK_KEPT_MS);
    storage()?.setItem(SOUND_ACK_KEY, JSON.stringify([...kept, { id: key, at: now }]));
  } catch {
    // Without storage every window counts as the one in use, so none waits for this.
  }
}

/** The window in use writes a receipt for each notice it took. One that never does (frozen, or closed without a word)
 * leaves this window's banner to chime, so a notice is never lost; a slow one may mean the person hears two. */
function awaitLeader(key: string): Promise<SoundOutcome> {
  return new Promise((resolve) => {
    const done = (outcome: SoundOutcome) => {
      clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("storage", heard);
      resolve(outcome);
    };
    const heard = (event: StorageEvent) => {
      if (event.key === SOUND_ACK_KEY && acknowledged(key)) done("silenced");
    };
    const timer = setTimeout(() => done(acknowledged(key) ? "silenced" : "unplayable"), SOUND_ACK_WAIT_MS);
    if (typeof window !== "undefined") window.addEventListener("storage", heard);
  });
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

const eventSounds = createEventSounds({ play: (event, wanted) => player.play(event, wanted), now, finishedNotices: finishedNotificationsEnabled, soundsOn: () => readSoundChoice() !== "off" && !player.holding() });

const here = (outcome: PlayOutcome): SoundOutcome => (outcome === "elsewhere" ? "silenced" : outcome);
const inThisWindow = (decision: PlayDecision): SoundDecision => (typeof decision === "string" ? here(decision) : decision.then(here));

export const playAppSound = (event: SoundEvent): SoundDecision => inThisWindow(player.play(event));
export const holdAppSounds = (reason: HoldReason): (() => void) => player.hold(reason);
export const previewAppSound = (style: SoundStyle): SoundDecision => player.preview(style);
export const replySound = (messageId: string, inView: boolean): SoundDecision => inThisWindow(eventSounds.replied(messageId, inView));
export const notificationsRead = eventSounds.notificationsRead;

export function notificationSound(entry: NotificationSoundEntry, viewing: boolean): SoundDecision {
  const key = entry.id ?? `${entry.kind}:${entry.groupId ?? entry.threadId}`;
  const settled = (outcome: PlayOutcome): SoundDecision => {
    if (outcome !== "elsewhere") {
      acknowledge(key);
      return outcome;
    }
    return acknowledged(key) ? "silenced" : awaitLeader(key);
  };
  const decision = eventSounds.notified(entry, viewing);
  return typeof decision === "string" ? settled(decision) : decision.then(settled);
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
  window.addEventListener("pagehide", closing);
  setInterval(stillOpen, SOUND_WINDOW_HEARTBEAT_MS);
}
