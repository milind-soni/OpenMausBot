import type { DesktopPrefs } from "./desktop-prefs.mjs";

export type TalkKeyId = "ctrl-opt-space" | "ctrl-shift-space" | "opt-shift-space";
export interface TalkShortcutState {
  /** False hides the setting and lets the key go: not macOS with Apple speech, this desktop is a remote client, or this
   * computer's bots moved to My Cloud (its own copy is frozen). */
  available: boolean;
  enabled: boolean;
  key: TalkKeyId;
  keys: { id: TalkKeyId; label: string }[];
  /** On, but another app holds the key. */
  taken: boolean;
}
export interface TalkShortcutChange { enabled?: boolean; key?: TalkKeyId }
/** What the setting says before the shortcut is set up, or when setting it up failed. */
export declare const TALK_SHORTCUT_UNAVAILABLE: Readonly<TalkShortcutState>;
export interface TalkShortcutBridge {
  state(): Promise<TalkShortcutState>;
  set(change: TalkShortcutChange): Promise<TalkShortcutState>;
}
export declare function createTalkShortcut(options: {
  globalShortcut: { register(accelerator: string, handler: () => void): boolean; unregister(accelerator: string): void };
  prefs: Pick<DesktopPrefs, "talkShortcut" | "setTalkShortcut" | "talkKey" | "setTalkKey">;
  available(): boolean;
  onPress(): void;
}): {
  state(): TalkShortcutState;
  set(change: { enabled?: unknown; key?: unknown }): TalkShortcutState;
  /** Takes or lets go of the key when `available()` changed since the key was last set up. */
  refresh(): void;
  releaseModifiers(): string[];
  close(): void;
};
type Sender = { on(event: string, listener: () => void): unknown; removeListener(event: string, listener: () => void): unknown };
export declare function createCallPresence(): { set(sender: Sender, active: boolean): void; active(): boolean };
