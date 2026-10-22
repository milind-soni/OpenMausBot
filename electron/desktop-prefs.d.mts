export { DESKTOP_PORTS } from "./desktop-ports.mjs";
export declare const DESKTOP_NOTICES: readonly string[];
export interface DesktopNoticesState {
  /** Notices this desktop has shown and someone closed, on whichever page of its window; This computer's own workspace
   * record counts too (an earlier close of the popup, or the welcome's Cloud beat). */
  seen: string[];
  /** This desktop sells MausBot Cloud: the installed app, not a branded build, not connected to another computer. */
  cloud: boolean;
}
/** On every page this desktop's window shows: this computer's, My Cloud's or another saved server's. */
export interface DesktopNoticesBridge {
  state(): Promise<DesktopNoticesState>;
  seen(id: string): Promise<void>;
  /** True the first time today the notice counts as shown on this desktop. */
  shown(id: string): Promise<boolean>;
}
/** The desktop's own switch, the same on every port its page is served from. */
export interface DesktopAnalyticsBridge {
  /** null until a choice is saved; a server's page is told only false, when this desktop turned analytics off. */
  enabled(): boolean | null;
  /** This computer's page only. */
  set?(enabled: boolean): Promise<void>;
}
/**
 * The language main draws its menus, tray, dialogs and notifications in. This computer's page and My Cloud's own page
 * only; a server's page never has it.
 */
export interface DesktopLanguageBridge {
  /** A language pack's code, such as "pt-br"; "" follows the system. A code with no pack changes nothing. */
  set(code: string): Promise<void>;
}
export interface DesktopPrefs {
  seen(): string[];
  markSeen(id: string): void;
  shown(id: string): boolean;
  analytics(): boolean | null;
  setAnalytics(enabled: boolean): void;
  language(): string | null;
  setLanguage(code: string): void;
}
type Files = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync" | "renameSync" | "rmSync">;
export declare function jsonFile(file: string, files?: Files): { read(): unknown; write(value: unknown): void };
export declare function createDesktopPrefs(options: { read(): unknown; write(value: unknown): void; now?: () => number }): DesktopPrefs;
export declare function registerDesktopPrefs(options: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void; on(channel: string, listener: (event: { returnValue?: unknown }) => void): void };
  read?(): unknown;
  write?(value: unknown): void;
  prefs?: DesktopPrefs;
  page(event: unknown): "local" | "cloud" | "server" | null;
  cloudOffered(): Promise<boolean>;
  localConfig?(): unknown;
  /** A page set the app's language; "" for the system's. */
  onLanguage?(code: string): void;
  now?: () => number;
}): void;
