import type { CloudMoveCheck, CloudSendOutcome, CloudSendSession, CloudSendSnapshot } from "./cloud-send.mjs";

interface CloudTarget { origin: string; grant(): Promise<{ origin: string; code: string }> }

export function openOwnerSession(target: CloudTarget, fetchImpl: typeof fetch, options?: { label?: string; background?: boolean }): Promise<CloudSendSession>;

export function installCloudSend(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  cloudPage(event: unknown): "local" | "cloud" | null;
  server(): { postMessage(message: unknown): void } | null | undefined;
  local(route: string, init?: { method?: string }): Promise<Response>;
  home(): CloudTarget | null;
  cookieFetch: typeof fetch;
  reconnect(origin: string): Promise<boolean>;
  power: { asleep(): boolean };
  file(): string;
  window(): { isDestroyed(): boolean; webContents: { send(channel: string, value: unknown): void; mainFrame: { url: string } } } | null;
  localOrigin(): string;
  fetch?: typeof fetch;
  engineWaitMs?: number;
  space?: { disk(): unknown; grow(sizeGb: number): Promise<unknown> };
  move?: () => { view(): unknown; seen(): unknown; retry(): Promise<unknown> } | null;
  /** The one session every pass of the move uses (move-session.mjs). */
  moveSession?: { open(target: CloudTarget): Promise<CloudSendSession> };
}): {
  receive(proc: unknown, message: unknown): boolean;
  move(options?: { final?: boolean }): Promise<CloudSendOutcome>;
  check(): Promise<CloudMoveCheck>;
  switches(): Record<string, boolean>;
  snapshot(): CloudSendSnapshot;
  publish(): void;
};
