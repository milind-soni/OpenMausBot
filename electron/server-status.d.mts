export declare const RECONNECT: Readonly<{ baseMs: number; capMs: number; healthyMs: number; cantReachAfterMs: number; timeoutMs: number; refocusMs: number }>;

/** How a server saved by hand was installed, as its descriptor says, so the update command fits it. */
export type ServerInstall = "npx" | "global" | "docker" | "source";
/** checking: the first look; connected; reconnecting / cantReach: a passing problem (cantReach after two minutes);
 * signedOut: it needs a new pairing code; insecure: a public http address, never contacted. */
export type ServerState = "checking" | "connected" | "reconnecting" | "cantReach" | "signedOut" | "insecure";
/** One saved server's row in Settings → Servers. `since`: when this state began (ms). `behind`: an older release than this app. */
export interface ServerStatus { id: string; state: ServerState; since: number; version: string | null; behind: boolean; install: ServerInstall | null }

export declare function reconnectDelay(attempt: number, random?: () => number): number;
export declare function versionBehind(server: string | null | undefined, app: string): boolean;
