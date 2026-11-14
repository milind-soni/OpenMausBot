export type CloudColor = "blue" | "teal" | "purple" | "orange" | "red" | "yellow";
export declare const CLOUD_COLORS: readonly CloudColor[];
export declare const DEFAULT_CLOUD_COLOR: CloudColor;
export declare const CLOUD_NAME_MAX: number;
export declare const CLOUD_COLOR_HEX: Readonly<Record<CloudColor, string>>;
export declare function cleanCloudName(value: unknown): string | null;
export declare function cleanCloudColor(value: unknown): CloudColor | null;
export declare function colorDotIcons<T extends { addRepresentation(options: { scaleFactor: number; dataURL: string }): void; isEmpty(): boolean }>(nativeImage: { createEmpty(): T }): (color: unknown) => T | null;
export interface CloudLookRecord { accountId: string; name: string; color: CloudColor }
export declare function lookFile(file: () => string, fs: { readFileSync(path: string, encoding: "utf8"): string; writeFileSync(path: string, data: string, options: { mode: number }): void }): { read(): CloudLookRecord | null; write(value: CloudLookRecord): void };
export declare function createCloudLook(options: {
  store: { read(): CloudLookRecord | null; write(value: CloudLookRecord): void };
  accountId(): string | null;
  homeEntry(): { origin: string; name: string; color?: string } | null;
  saveEntry(origin: string, look: { name: string; color: CloudColor }): void;
}): { pending(): { name: string; color: CloudColor } | null; current(): { name: string; color: CloudColor }; save(name: string, color: string): { name: string; color: CloudColor } };
export declare function createCloudReadyNotice(options: {
  Notification: { isSupported(): boolean; new (options: { title: string; body: string }): { on(event: "click", listener: () => void): void; show(): void } };
  focused(): boolean; sheetOpen(): boolean; name(): string; open(): void;
  /** Told once the notification is shown (main marks the checkout done). */
  shown?(): void;
  t?(key: string, params?: Record<string, string | number>): string;
}): (state: unknown) => boolean;
export declare function installCloudBuy(options: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  guard(channel: string, handler: (...args: any[]) => unknown): (...args: any[]) => unknown;
  client(): import("./cloud-account.mjs").CloudAccountClient;
  offersReady(): Promise<boolean>;
  clipboard: { writeText(text: string): void };
  look: { current(): { name: string; color: CloudColor }; save(name: string, color: string): { name: string; color: CloudColor } };
}): { sheetOpen(): boolean };
export declare function cloudLinkOpensSheet(state: import("./cloud-account.mjs").CloudAccountState | null | undefined): boolean;
