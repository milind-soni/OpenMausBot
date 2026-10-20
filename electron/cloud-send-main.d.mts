import type { CloudLoginsState } from "./cloud-logins.mjs";
import type { CloudSendSession, CloudSendSnapshot } from "./cloud-send.mjs";

interface CloudTarget { origin: string; grant(): Promise<{ origin: string; code: string }> }

export function openOwnerSession(target: CloudTarget, fetchImpl: typeof fetch, label?: string): Promise<CloudSendSession>;
export function loginsView(snapshot: CloudSendSnapshot): CloudLoginsState;
export function chatsArrive(snapshot: CloudSendSnapshot, botId: string, sendsChats?: boolean): boolean;

export function installCloudSend(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  localOnly<T extends (...args: any[]) => unknown>(channel: string, handler: T): T;
  cloudPage(event: unknown): "local" | "cloud" | null;
  server(): { postMessage(message: unknown): void } | null | undefined;
  local(route: string): Promise<Response>;
  home(): CloudTarget | null;
  cookieFetch: typeof fetch;
  reconnect(origin: string): Promise<boolean>;
  power: { asleep(): boolean };
  file(): string;
  window(): { isDestroyed(): boolean; webContents: { send(channel: string, value: unknown): void; mainFrame: { url: string } } } | null;
  localOrigin(): string;
  openSettings(): void;
  fetch?: typeof fetch;
  bringChats?: (() => Promise<{ phase: string; action?: string; brought?: { conversations: number; messages: number }; error?: { message?: string } }>) | null;
  keepUpToDate?: boolean;
}): {
  receive(proc: unknown, message: unknown): boolean;
  chatsArrive(botId: string): boolean;
  menu(): { waiting: { bots: number; total: number } | null; onSend(): void; onOpen(): void };
};
