export interface SharedFolder { id: string; name: string; path: string; write: boolean; /** The person's whole home folder. */ home?: boolean }
export interface SharingState {
  enabled: boolean;
  folders: SharedFolder[];
  terminal: boolean;
  computer: boolean;
  connected?: boolean;
  error?: string;
}
interface Workspace { id: string; name: string; origin: string }
interface Identity { sessionId: string; environmentId: string }
export interface LendingActivityEntry {
  at: number;
  server: string;
  origin: string;
  action: string;
  detail: string;
  ok: boolean;
  error?: string;
}
/** What this computer lends to a Cloud of the person's own. */
export interface CloudLendingState {
  enabled: boolean;
  folders: SharedFolder[];
  /** Apps and screen. */
  screen: boolean;
  /** Its internet connection, for the bots' browsers on My Cloud. */
  internet: boolean;
  /** Its Chrome, for the bots on My Cloud. */
  chrome: boolean;
  /** Lent and connected with Chrome: whether My Cloud reaches it yet. */
  chromeLink?: "on" | "connecting" | "unsupported";
  /** Lent and connected with the internet connection: whether My Cloud's browsing goes through it yet. */
  link?: "on" | "connecting" | "unsupported";
  /** An action from the Cloud is running on this computer right now. */
  busy: boolean;
  connected?: boolean;
  /** Why lending is not connected. */
  problem?: "connect-first" | "not-cloud" | "waiting" | "paused" | "asleep" | "signed-out" | "account-changed" | "machine-changed";
  error?: string;
  /** Commands may be run on this computer as the person. */
  terminal?: boolean;
}
/** Computer control's state as lending reads it. */
export interface ScreenStatus {
  ready: boolean;
  lent: boolean;
  reason: "starting" | "permissions" | "blocked" | "off" | "not-running" | "unsupported" | null;
  fix: "start" | "allow" | null;
  message?: string;
}
/** A bot on one of the person's own Clouds needs this computer and can't use it now. */
export interface ComputerAsk {
  id: string;
  need: "screen" | "folders" | "terminal";
  reason: string;
  bot: string;
  why?: string;
  state: "asking" | "turning-on" | "failed";
  /** Taps on the card's Turn on so far. */
  turnOn: number;
}
/** What lending tells the menu-bar item: the Clouds lent to (while paused, the ones it would lend to) and using it now. */
export interface LendingSummary {
  lending: string[];
  clouds: string[];
  using: string[];
  paused: boolean;
  terminal?: boolean;
  busy: { env: string; action: string } | null;
  /** Computer control's latest state, null until it is first read. */
  screen: ScreenStatus | null;
}
export interface AutomaticGrant { folders: SharedFolder[]; screen: boolean; internet: true; chrome: true; terminal: false }
export type CloudLendingVerdict = { allow: true } | { pause: string } | { stop: "signed-out" | "account-changed" | "machine-changed" };
export function cloudLendingVerdict(binding: { accountId: string; origin: string } | null | undefined, current: { status: string; accountId: string | null; origin: string | null } | null, env: { origin: string } | null | undefined): CloudLendingVerdict;
/** The person said no to lending this Cloud before lending was automatic, so lending starts Paused. */
export function saidNo(record: { enabled?: boolean; cloud?: unknown; internet?: boolean; stopped?: { reason?: string } } | null | undefined): boolean;
export function automaticGrant(input: { kept?: SharedFolder[]; home?: SharedFolder | null; screen?: boolean; projects?: SharedFolder[] }): AutomaticGrant;
export function lendsAsWanted(record: unknown, wanted: AutomaticGrant): boolean;
export function isHomeFolder(target: string): Promise<boolean>;
export function existingFolders<T>(folders: unknown[], validate: (folders: unknown[]) => Promise<T[]>): Promise<T[]>;
export function validateSharedFolders(folders: unknown, options?: { homeEdits?: boolean }): Promise<SharedFolder[]>;
export function validSharedOperation(operation: unknown, computerId: string): boolean;
export function createComputerSharing(options: {
  file: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  environments: () => Workspace[];
  enabled?: () => Promise<boolean>;
  protectedPaths?: string[];
  /** The desktop's cua connection, or why it did not start (`reason` stays on this computer). */
  cuaConnection: () => Promise<{ mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | { mode: "unavailable"; reason: string } | null>;
  hostControl?: (id: string, signal: AbortSignal) => Promise<{ renew(): Promise<unknown>; release(): Promise<unknown> }>;
  /** The OS reports the screen locked: a screen action is refused with the fix instead of failing in the driver. */
  screenLocked?: () => boolean;
  /** Seconds since the person last touched this computer, or null when the system cannot tell: while they are using it,
   * a lent screen call that would take their mouse, keyboard or front window waits, and background calls run. */
  idleSeconds?: () => number | null;
  /** Home directory whose credential and autostart locations are protected. */
  home?: string;
  activityFile?: string;
  /** The verified Cloud sign-in: { status, accountId, origin }; status "restoring" while a saved sign-in is read. */
  /** The MausBot Cloud sign-in as `env`'s lending checks it (its own address for another Cloud of the person's own), else My Cloud's. */
  cloud?: (env?: Workspace | null) => { status: string; accountId: string | null; origin: string | null } | null;
  /** Signs this app back in to the person's own Cloud after its session there ended; true when it did. */
  reconnect?: ((origin: string) => Promise<boolean> | boolean) | null;
  now?: () => number;
  /** My Cloud's power gate: lending to it waits, calling nothing, while it sleeps. */
  power?: import("./cloud-power.mjs").CloudPowerGate;
  /** `busy.action` is "internet" while a Cloud's browsing goes through this computer. */
  onChange?: (summary: LendingSummary) => void;
  /** The device link's sign-in for My Cloud, as the poll's fetch carries it (its session cookie). */
  linkHeaders?: (env: Workspace) => Record<string, string> | Promise<Record<string, string>>;
  WebSocket?: typeof globalThis.WebSocket;
  /** The Chrome door's options, for tests: an object with `open` stands in for the door. */
  chrome?: Parameters<typeof import("./device-chrome.mjs").createChromeDoor>[0];
  /** This computer's own check on each connection, for tests: how it looks names up and connects. */
  egress?: Omit<NonNullable<Parameters<typeof import("./device-egress.mjs").createDeviceEgress>[0]>, "seenAs">;
  /** The saved server that is the person's own My Cloud: the move's project folders are lent to it. */
  myCloud?: () => Workspace | null;
  /** The saved servers that are the verified session's own Clouds, never a Team Cloud: each is lent this computer by itself. */
  ownClouds?: () => Workspace[];
  /** Computer control's state; its `lent` says whether apps and screen are lent: computer control works, or only macOS's
   * permissions are missing. */
  screen?: () => boolean | ScreenStatus | Promise<boolean | ScreenStatus>;
  /** A Cloud's bot needs apps and screen while computer control isn't running: asks macOS for what it lacks. */
  askForScreen?: (connection: unknown) => void;
  /** This app's own prompt for an ask: "turn-on", "not-now", or null when it didn't show or `signal` closed it. */
  prompt?: (env: Workspace, ask: ComputerAsk, signal: AbortSignal) => Promise<"turn-on" | "not-now" | null>;
  /** Starts computer control again; its state after. */
  startScreen?: () => Promise<ScreenStatus | null>;
  /** Turns on running commands once the person confirms it on this computer; true when they did. */
  confirmTerminal?: () => Promise<boolean>;
  log?: (line: string) => void;
}): {
  state(id: string): SharingState;
  activity(id?: string, limit?: number): LendingActivityEntry[];
  identity(env: Workspace): Promise<Identity>;
  observe(env: Workspace): Promise<Identity | null>;
  decline(env: Workspace, identity: Identity): void;
  save(env: Workspace, input: Pick<SharingState, "folders" | "terminal" | "computer">, identity: Identity): Promise<SharingState>;
  revoke(env: Workspace): SharingState;
  forget(env: Workspace): void;
  cloudState(env: Workspace | null | undefined): CloudLendingState;
  /** The folders lent to My Cloud, for Files' copies of them (electron/lent-folders.mjs). */
  lentToCloud(env: Workspace | null | undefined): { lendingId: string; folders: Array<{ id: string; path: string; name: string; write: boolean }>; protectedPaths: string[]; paused?: true } | { off: true };
  lendingToCloud(): boolean;
  /** A server is using this computer now: a job running on it, or its browsing going through this computer. */
  busy(): boolean;
  saveCloud(env: Workspace, input: { folders: unknown; screen?: boolean; internet?: boolean; chrome?: boolean; terminal?: boolean }, version?: number): Promise<CloudLendingState>;
  /** The move's project folders, lent to My Cloud with editing; rejects while that can't happen yet. */
  lendProjects(paths: string[], place?: { id: string; origin: string; name: string } | null): Promise<void>;
  paused(): boolean;
  /** Every Cloud stops using this computer, across restarts too, until resume(). */
  pause(): void;
  resume(): Promise<void> | undefined;
  screenChanged(): Promise<void>;
  cloudChanged(): void;
  start(options?: { maintainer?: boolean }): void;
  close(): void;
};
export function sharedCuaConnection(connection: unknown): { mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | null;
