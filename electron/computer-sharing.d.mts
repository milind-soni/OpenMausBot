export interface SharedFolder { id: string; name: string; path: string; write: boolean; /** The person's whole home folder. */ home?: boolean }
export interface SharingState {
  enabled: boolean;
  folders: SharedFolder[];
  terminal: boolean;
  computer: boolean;
  /** Lent to a server of the person's own, which they allowed here: no maintainer flag, and Pause holds it. */
  own?: boolean;
  /** Lending is paused from the OpenMausBot icon's menu or Settings. */
  paused?: boolean;
  connected?: boolean;
  /** Why it is not connected: "paused", or "not-own" / "machine-changed" once lending to that server ended. */
  problem?: string;
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
  /** Lent Clouds that haven't accepted this computer yet (asleep ones excluded). */
  waiting?: string[];
  using: string[];
  paused: boolean;
  /** The pause (or a Resume) could not be saved: sharing stays stopped, and Pause retries the save. */
  pauseError?: string;
  terminal?: boolean;
  /** The menu shows the Clouds' terminal switch: a Cloud of the person's own is signed in here. */
  terminalSwitch?: boolean;
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
/** The sign-in a server answers with (/api/auth/session) is this desktop's admin pairing on a server of the person's own. */
export function ownServerSession(auth: unknown): boolean;
export function validSharedOperation(operation: unknown, computerId: string): boolean;
export function createComputerSharing(options: {
  file: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  environments: () => Workspace[];
  /** This computer's own OpenMausBot installs, by environment id: what an MCP server kept for it on a Cloud names. */
  localEnvironments?: () => string[];
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
  /** The ports this app's own OpenMausBot server is on now: a lent MCP server is never reached there. */
  serverPorts?: () => number[];
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
  /** `env` is a server of the person's own, checked now: its identity, else null. */
  ownServer(env: Workspace): Promise<Identity | null>;
  /** A server of the person's own whose pairing here was never asked about: its identity, for the popup; null once asked;
   * false when it is not a server of the person's own. */
  ownOffer(env: Workspace): Promise<Identity | null | false>;
  /** The person allowed a server of their own to use this computer. */
  lendOwn(env: Workspace, input: Partial<Pick<SharingState, "folders" | "terminal" | "computer">>): Promise<SharingState>;
  /** Not now: nothing is lent, and this pairing is not asked again. */
  declineOwn(env: Workspace, identity: Identity): void;
  forget(env: Workspace): void;
  cloudState(env: Workspace | null | undefined): CloudLendingState;
  /** The folders lent to My Cloud, for Files' copies of them (electron/lent-folders.mjs). */
  lentToCloud(env: Workspace | null | undefined): { lendingId: string; folders: Array<{ id: string; path: string; name: string; write: boolean }>; protectedPaths: string[]; paused?: true } | { off: true };
  /** Another account takes over: lending to this account's Clouds stops, and goes on if it comes back. */
  leaveAccount(accountId: string | null): void;
  /** Lending's last requests have been answered or have timed out; a Cloud's answer can re-issue its session cookie. */
  goodbyesDone(): Promise<unknown>;
  lendingToCloud(): boolean;
  /** A server is using this computer now: a job running on it, or its browsing going through this computer. */
  busy(): boolean;
  saveCloud(env: Workspace, input: { folders: unknown; screen?: boolean; internet?: boolean; chrome?: boolean; terminal?: boolean }, version?: number): Promise<CloudLendingState>;
  /** The move's project folders, lent to My Cloud with editing; rejects while that can't happen yet. */
  lendProjects(paths: string[], place?: { id: string; origin: string; name: string } | null): Promise<void>;
  paused(): boolean;
  /** Stops every Cloud, across restarts too, until resume(); pauseError reports a pause that could not be saved. */
  pause(): void;
  resume(): Promise<void> | undefined;
  /** Whether every Cloud of the signed-in account's own may run commands here as this user, across restarts too. */
  lendTerminal(on: boolean): Promise<void> | undefined;
  screenChanged(): Promise<void>;
  cloudChanged(): void;
  start(options?: { maintainer?: boolean }): void;
  close(): void;
};
export function sharedCuaConnection(connection: unknown): { mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | null;
