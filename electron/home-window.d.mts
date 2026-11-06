/** What this computer's screen says while the window can't show the place. `reason`: the Admin's words on why My Cloud
 * doesn't answer, in English; `cause`: the same as a code the page says in its own language; `machine`: a plan
 * problem's state; `other`: another MausBot Cloud account is signed in; `name`: the team whose Cloud is being opened
 * (absent for My Cloud). */
export type HomeView = { name?: string } & (
  | { screen: "opening" | "waking" | "moving" }
  /** The Admin is setting it up (or a brand-new one's name isn't found yet, at `checking`): the step it reports. */
  | { screen: "setup"; step?: import("./cloud-home.mjs").CloudSetupStep; slow?: true }
  | { screen: "offline"; reason?: string; cause?: "host" | "no_answer" }
  | { screen: "signin"; other?: true }
  /** `member`: a team's User, who can't subscribe or pay for it and is sent to its owner. */
  | { screen: "plan"; machine: "stopped" | "payment-problem" | "failed"; member?: true }
  /** A Cloud the session's list says isn't running, so nothing looks up its address: it has ended (`deleteAt`: when its kept
   * files are deleted), its checkout wasn't finished, or its payment has a problem; `removable` while its owner may take it
   * off their list. */
  | { screen: "ended" | "checkout" | "payment"; deleteAt?: number; removable?: true });

/** The window onto My Cloud once it is the person's home (preload `home`). */
export interface HomeBridge {
  /** This computer's screen only. */
  state(): Promise<HomeView>;
  onState(callback: (view: HomeView) => void): () => void;
  /** This computer's screen only: look again now. */
  retry(): Promise<HomeView>;
  /** This computer's screen only, once the person said yes there: the Cloud it shows leaves their list (absent: an older app). */
  remove?(): Promise<import("./cloud-account.mjs").CloudRemoveOutcome>;
  /** This device's MausBot Cloud sign-in, again; on My Cloud's page only from the person's click. */
  signIn(): Promise<void>;
  /** My Cloud's own page only: its session ended, so the app signs it in again by itself. */
  repair(): Promise<void>;
  /** My Cloud's own page only: the window reloaded it just now for its newer version. */
  updating?: boolean;
}

export type Home = ({ kind: "computer" } | { kind: "cloud"; origin: string } | { kind: "signin"; other?: true })
  /** This computer's copy is frozen by a move to a server of the person's own, whose marker names it: that server, and
   * its name. The copy's own page has nothing to show, so the window goes back to it (`reopen`). */
  & { frozenPlace?: { origin: string | null; place: string } };
/** A place the window shows: My Cloud, or a team's Cloud or another Cloud of the person's own (`own`), from the verified session. */
export type HomePlace = { kind: "cloud"; origin: string } | { kind: "team" | "own"; id: string; name: string; role: string | null; origin: string };
/** What to open: My Cloud, a team's Cloud, another Cloud of the person's own, or (null) the place remembered from last time. */
export type HomeAsk = "cloud" | { team: string; name?: string } | { cloud: string; name?: string } | null;
export type RememberedPlace = (({ team: string } | { cloud: string }) & { name?: string; origin?: string }) | null;
export declare function otherPlace(place: unknown): boolean;
/** This computer's screen for a listed Cloud that isn't running (or its setup's step); null for one that opens. */
export declare function cloudScreen(cloud: import("./cloud-list.mjs").CloudListEntry | null | undefined): HomeView | null;

export declare const HOME_SCREEN_PATH: string;
export declare const LOOK_MS: number;
export declare const OPEN_MS: number;
export declare const RETRY_MS: readonly number[];
export declare const QUIET_MS: number;
export declare const VERSION_EVERY_MS: number;
export declare const SPLASH_HANDOFF_MS: number;
export declare const UPDATING_MS: number;
export declare const SPLASH_TEXT: Readonly<{ opening: string; waking: string }>;
export declare const TEAM_RENEW_MS: number;
export declare const TEAM_RENEW_EARLY_MS: number;
export declare const TEAM_RENEW_RETRY_MS: number;
export declare const FRESH_MS: number;
export declare const NAME_WAIT_MS: number;
export declare const NAME_RETRY_MS: readonly number[];
export function nameNotFound(code: number): boolean;
export function createReadyClock(input?: { store?: { read(): unknown; write(value: unknown): void } | null; now?(): number }): { seen(state: unknown): void; fresh(origin: string | null): boolean };
export function splashText(status: "opening" | "waking", name?: string | null, t?: (key: string, params?: Record<string, string | number>) => string): string;
export function placeOf(input: { ask?: HomeAsk; remembered?: RememberedPlace; state?: any }): { kind: "cloud"; left?: string | null } | { kind: "team" | "own"; id: string; name: string; role: string | null; origin: string | null; machine: any };

export function homeOf(input: { journal?: any; frozenCloud?: string | true | null; state?: any }): Home;
export function noWayHome(worked: Home, state?: any): boolean;
export function routeOf(url: string, origin: string): string | null;

interface WindowLike { isDestroyed(): boolean; webContents: { id: number; getURL(): string; reload(): void; mainFrame?: unknown } }
type Timers = { set(work: () => void, ms: number): unknown; clear(timer: unknown): void; every(work: () => void, ms: number): unknown };

export interface HomeWindow {
  show(options?: { open?: "phone" | null; place?: HomeAsk }): Promise<unknown>;
  openProfile(id: string): Promise<boolean>;
  profile(): string | null;
  cancel(): void;
  openCloud(open?: "phone" | null): Promise<unknown>;
  /** Remove from list from this computer's screen: the Cloud it shows leaves the person's list. */
  remove(): Promise<import("./cloud-account.mjs").CloudRemoveOutcome>;
  asking(): boolean;
  refresh(): Promise<Home>;
  view(): HomeView;
  cloudOrigin(): string | null;
  /** The origin of the place the window shows (a team's Cloud, or My Cloud), else null. */
  placeOrigin(): string | null;
  current(): Home;
  shown(): HomePlace | null;
  retry(): Promise<unknown>;
  signIn(): Promise<void>;
  repair(): Promise<void>;
  changed(): Promise<void>;
  responded(details: { url: string; statusCode: number; webContentsId?: number }): void;
  navigated(url: string): void;
  failed(url: string, code?: number): boolean;
  homePage(event: unknown): boolean;
  /** Asked once by the home page as it loads: the window reloaded it just now for its newer version. */
  updating(event: unknown): boolean;
  screenPage(event: unknown): boolean;
  /** Signs the team on screen in again now, without moving the page. */
  renew(): Promise<void>;
  close(): void;
}

export function createHomeWindow(deps: {
  journal(): unknown;
  frozen(): Promise<{ frozen: boolean; cloud?: string; place?: string } | null>;
  account(): { state(): any; power(): any; wakeHome(): Promise<unknown>; setWaking(on: boolean): void; pairHome(cloudId?: string | null): Promise<{ origin: string; code: string; expiresAt: number }>;
    pairTeam?(teamId: string): Promise<{ origin: string; code: string; expiresAt: number }>; signInAgain(): Promise<unknown>; begin(): Promise<unknown>; signOut?(): Promise<unknown>; reopen?(): Promise<unknown>;
    hideCloud?(cloudId: string): Promise<{ outcome: import("./cloud-account.mjs").CloudRemoveOutcome }> } | null;
  restored?(): Promise<unknown>;
  window(): WindowLike | null;
  ensureWindow(): void;
  localOrigin(): string;
  cookieFetch: (url: string, init?: RequestInit) => Promise<Response>;
  power: { asleep(): boolean; hold(): void; woke(): void };
  go(url: string, origin: string | null, place: HomePlace | null): unknown;
  reopen?(place: { origin: string | null; place: string }, still?: () => boolean): Promise<boolean>;
  showLocal(leaving: boolean): unknown;
  clean?: import("./clean-workspace.mjs").CleanWorkspace | null;
  remembered?(): RememberedPlace;
  remember?(place: { team: string } | { cloud: string } | null): void;
  left?(name: string): void;
  drop?(place: { kind: "team" | "own"; id: string; name: string }): void;
  splash?(): { status(text: string): void } | null;
  lastInput?(): number;
  publish?(view: HomeView): void;
  /** Home as worked out changed: this computer, My Cloud (`origin`), or the sign-in screen. */
  rehomed?(home: Home): void;
  versionEveryMs?: number;
  quietMs?: number;
  now?(): number;
  timers?: Timers;
  hosts?(): { clearHostResolverCache(): Promise<void>; resolveHost(host: string, options?: { cacheUsage?: "allowed" | "staleAllowed" | "disallowed" }): Promise<{ endpoints: unknown[] }> } | null;
  readyStore?: { read(): unknown; write(value: unknown): void } | null;
  log?(line: string): void;
  t?(key: string, params?: Record<string, string | number>): string;
}): HomeWindow;

export function installHomeWindowIpc(deps: {
  ipcMain: { handle(channel: string, handler: (event: any, ...args: any[]) => unknown): void; on(channel: string, listener: (event: any) => void): void };
  homeWindow: HomeWindow;
  cloudPage(event: unknown): "local" | "cloud" | null;
}): void;
