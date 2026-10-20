import type { OneWorkspaceView, RosterBot, RosterRoom, SideRoster, WorkspaceSide } from "../shared/one-workspace.ts";

export const ROSTER_FRESH_MS: number;
export const READ_WAIT_MS: number;
export const OPEN_FOR_MS: number;
export const PICTURE_MAX_BYTES: number;
export const AUTOMATIONS_FRESH_MS: number;
export const CHATS_PER_LOOK: number;
export function automationCounts(...bodies: unknown[]): Map<string, number>;
export function threadTimes(body: unknown): Map<string, Map<string, number>>;
export function unsharedCounts(cloud: ReadonlyArray<{ id: string; at: number }>, computer: ReadonlyArray<{ id: string; at: number }>): { cloud: number; computer: number };

export function otherSide(side: WorkspaceSide): WorkspaceSide;
export function rosterBot(bot: unknown): RosterBot | null;
export function rosterRoom(group: unknown): RosterRoom | null;
export function parseRoster(body: unknown): Pick<SideRoster, "bots" | "rooms" | "sections">;

interface PowerGate { asleep(): boolean; hold?(): void }
interface CloudTarget { origin: string; name: string }

export interface OneWorkspace {
  together(): boolean;
  setTogether(on: boolean): void;
  possible(): boolean;
  available(): boolean;
  peek(page: WorkspaceSide): OneWorkspaceView | null;
  view(page: WorkspaceSide): Promise<OneWorkspaceView | null>;
  open(page: WorkspaceSide, target: unknown): { side: WorkspaceSide };
  cancelOpen(): void;
  take(page: WorkspaceSide): string | null;
}

export function createOneWorkspace(deps: {
  store: { read(): unknown; write(value: unknown): void };
  cloud(): CloudTarget | null;
  readCloud(route: string): Promise<Response>;
  readLocal(route: string): Promise<Response>;
  power?: PowerGate;
  localDefault?(): boolean;
  twinHome?(): WorkspaceSide;
  reason?(): string | null;
  chatsArrive?(botId: string): boolean;
  now?(): number;
  readWaitMs?: number;
  onChange?(): void;
}): OneWorkspace;

export interface OneWorkspaceMenu {
  together?: { cloudId: string; label: string; detail: string; on: boolean; onToggle(): void };
}

export function oneWorkspaceMenu(one: OneWorkspace, entry: { id: string; name: string } | null | undefined, onToggle: () => void): OneWorkspaceMenu;

export function installOneWorkspace(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  page(event: unknown): "local" | "cloud" | null;
  window(): { isDestroyed(): boolean; webContents: { send(channel: string, value: unknown): void; mainFrame: { url: string } } } | null;
  localOrigin(): string;
  file(): string;
  cloud(): CloudTarget | null;
  cookieFetch: typeof fetch;
  reconnect(origin: string): Promise<boolean>;
  power: PowerGate;
  local(route: string): Promise<Response>;
  localDefault(): boolean;
  twinHome(): WorkspaceSide;
  reason?(): string | null;
  chatsArrive?(botId: string): boolean;
  goCloud(): Promise<unknown>;
  goLocal(): Promise<unknown>;
  files?: typeof import("node:fs");
}): {
  menu(entry: { id: string; name: string } | null | undefined): OneWorkspaceMenu;
  one: OneWorkspace;
};
