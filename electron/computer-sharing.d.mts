export interface SharedFolder { id: string; name: string; path: string; write: boolean; /** The person's whole home folder, lent after an explicit warning. */ home?: boolean }
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
/** What this computer lends to the person's own Cloud (Settings → MausBot Cloud). */
export interface CloudLendingState {
  enabled: boolean;
  folders: SharedFolder[];
  /** Apps and screen. */
  screen: boolean;
  /** Its internet connection, for the bots' browsers on My Cloud. */
  internet: boolean;
  /** Lent and connected with the internet connection: whether My Cloud's browsing goes through it yet. */
  link?: "on" | "connecting" | "unsupported";
  /** An action from the Cloud is running on this computer right now. */
  busy: boolean;
  connected?: boolean;
  /** Why lending is not connected, for localized copy. */
  problem?: "connect-first" | "not-cloud" | "waiting" | "paused" | "asleep" | "signed-out" | "account-changed" | "machine-changed" | "access-off";
  error?: string;
  /** Lent through Settings → Servers → Computer access rather than this switch; that grant may include the terminal. */
  via?: "access";
  /** Commands may be run on this computer: ticked in Settings (only while lent), or part of a Computer access grant. */
  terminal?: boolean;
  /** Why and when lending last stopped, kept across restarts: "you" (the switch or Stop lending), or what stopped it. */
  stopped?: { reason: string; at: number };
}
export interface CloudLendingSnapshot {
  /** Signed in to OMB Cloud with a known machine saved under Servers. */
  available: boolean;
  /** This app's local computer control (and OS permissions) is ready. */
  screenAvailable: boolean;
  state?: CloudLendingState;
  activity?: LendingActivityEntry[];
}
export interface CloudLendingBridge {
  state(): Promise<CloudLendingSnapshot>;
  chooseFolder(): Promise<SharedFolder | null>;
  save(input: { folders: SharedFolder[]; screen: boolean; internet?: boolean; terminal?: boolean }): Promise<CloudLendingSnapshot>;
  stop(): Promise<CloudLendingSnapshot>;
}
export type CloudLendingVerdict = { allow: true } | { pause: string } | { stop: "signed-out" | "account-changed" | "machine-changed" };
export function cloudLendingVerdict(binding: { accountId: string; origin: string } | null | undefined, current: { status: string; accountId: string | null; origin: string | null } | null, env: { origin: string } | null | undefined): CloudLendingVerdict;
export function isHomeFolder(target: string): Promise<boolean>;
export function validateSharedFolders(folders: unknown): Promise<SharedFolder[]>;
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
  /** Home directory whose credential and autostart locations are protected. */
  home?: string;
  activityFile?: string;
  /** The verified Cloud sign-in: { status, accountId, origin }; status "restoring" while a saved sign-in is read. */
  cloud?: () => { status: string; accountId: string | null; origin: string | null } | null;
  /** Signs this app back in to the person's own Cloud after its session there ended; true when it did. */
  reconnect?: ((origin: string) => Promise<boolean> | boolean) | null;
  now?: () => number;
  /** My Cloud's power gate: lending to it waits, calling nothing, while it sleeps. */
  power?: import("./cloud-power.mjs").CloudPowerGate;
  /** `busy.action` is "internet" while My Cloud's browsing goes through this computer. */
  onChange?: (summary: { lending: string[]; busy: { env: string; action: string } | null }) => void;
  /** The device link's sign-in for My Cloud, as the poll's fetch carries it (its session cookie). */
  linkHeaders?: (env: Workspace) => Record<string, string> | Promise<Record<string, string>>;
  WebSocket?: typeof globalThis.WebSocket;
  /** This computer's own check on each connection, for tests: how it looks names up and connects. */
  egress?: Omit<NonNullable<Parameters<typeof import("./device-egress.mjs").createDeviceEgress>[0]>, "seenAs">;
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
  lendingToCloud(): boolean;
  saveCloud(env: Workspace, input: { folders: unknown; screen?: boolean; internet?: boolean; terminal?: boolean }): Promise<CloudLendingState>;
  cloudChanged(): void;
  start(options?: { maintainer?: boolean }): void;
  close(): void;
};
export function sharedCuaConnection(connection: unknown): { mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | null;
