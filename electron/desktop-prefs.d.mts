export { DESKTOP_PORTS } from "./desktop-ports.mjs";
export declare const DESKTOP_NOTICES: readonly string[];
export interface DesktopNoticesState {
  /** Notices this desktop has shown and someone closed, on whichever page of its window; This computer's own workspace
   * record counts too (an earlier close of the What's new popup). */
  seen: string[];
  /** This desktop sells MausBot Cloud: the installed app, not a branded build, not connected to another computer. */
  cloud: boolean;
}
/** On every page this desktop's window shows: this computer's, My Cloud's or another saved server's. */
export interface DesktopNoticesBridge {
  state(): Promise<DesktopNoticesState>;
  seen(id: string): Promise<void>;
}
/** The desktop's own switch, the same on every port its page is served from. */
export interface DesktopAnalyticsBridge {
  /** null until a choice is saved; a server's page is told only false, when this desktop turned analytics off. */
  enabled(): boolean | null;
  /** This computer's page only. */
  set?(enabled: boolean): Promise<void>;
}
/** The app's language on this computer, one pick for every page its window shows. */
export interface DesktopLanguageBridge {
  /** A locale code, "" to follow the system, or null until one is picked on this computer. */
  choice(): string | null;
  set(language: string): Promise<boolean>;
  /** A pick made on another page of this desktop. */
  onChange(listener: (language: string) => void): () => void;
}
export interface DesktopPrefs {
  seen(): string[];
  markSeen(id: string): void;
  analytics(): boolean | null;
  setAnalytics(enabled: boolean): void;
  language(): string | null;
  /** False for anything that is not a locale code or "". */
  setLanguage(language: unknown): boolean;
  /** Random, made and saved on first use. */
  installId(): string;
  updatesConsent(): import("./updates-consent.mjs").UpdatesConsentRecord | null;
  /** False, and nothing saved, for a record updates-consent.mjs would not read back. */
  setUpdatesConsent(value: unknown): boolean;
  /** True until switched off. */
  talkShortcut(): boolean;
  setTalkShortcut(enabled: boolean): void;
  talkKey(): import("./talk-shortcut.mjs").TalkKeyId;
  /** False, and nothing saved, for anything but a key id in talk-keys.mjs. */
  setTalkKey(id: unknown): boolean;
  /** The Quick asks chat made on this server (keyed by its data folder), null until one is saved. */
  quickAsksChat(server: string): { botId: string; threadId: string } | null;
  setQuickAsksChat(server: string, chat: { botId: string; threadId: string }): void;
  /** False until the person hides the window's rail of places. */
  railHidden(): boolean;
  setRailHidden(hidden: boolean): void;
  /** True until the person turns the window's frame off. */
  windowFrame(): boolean;
  setWindowFrame(on: boolean): void;
}
/** The window's frame, this desktop's choice, as Settings reads and changes it. */
export interface WindowFrameState {
  on: boolean;
  /** The choice changes this window only when the app starts again (Windows). */
  restart: boolean;
}
type Files = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync" | "renameSync" | "rmSync">;
export declare function jsonFile(file: string, files?: Files): { read(): unknown; write(value: unknown): void };
export declare function createDesktopPrefs(options: { read(): unknown; write(value: unknown): void }): DesktopPrefs;
export declare function registerDesktopPrefs(options: {
  /** Used instead of making a store from read/write. */
  prefs?: DesktopPrefs;
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void; on(channel: string, listener: (event: { returnValue?: unknown }) => void): void };
  read(): unknown;
  write(value: unknown): void;
  page(event: unknown): "local" | "cloud" | "server" | null;
  cloudOffered(): Promise<boolean>;
  localConfig?(): unknown;
  languageChanged?(language: string, sender: unknown): void;
  /** The window's frame: `made()`, the frame the window was made with (null before it is); `restarts`, a change waits for
   * the app to start again; `changed()`, the pages hear it. */
  frame?: { made(): boolean | null; restarts: boolean; changed(): void } | null;
  /** The MausBot Cloud sign-in client: with it, the product-updates question is asked and its answer kept here. */
  cloudAccount?(): import("./updates-consent.mjs").UpdatesConsentClient | null;
  now?: () => number;
}): import("./updates-consent.mjs").UpdatesConsent | null;
