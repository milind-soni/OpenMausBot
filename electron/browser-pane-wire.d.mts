// Types for browser-pane-wire.mjs as the server uses it (server/browser/pane). Keep in step with the implementation.
type CdpParams = Record<string, unknown>;
type Base = { type: "openmausbot:browser-pane" };

export type PaneToMain = Base & (
  | { op: "hello" }
  /** `egress`: the loopback port of the profile's egress gate; every request of its panes goes through it.
   * `downloads`: the folder every download of its panes is saved in, never asked of the person. */
  | { op: "open"; browser: string; partition: string; egress: number; downloads: string }
  | { op: "cancel-download"; browser: string; guid: string }
  | { op: "create"; browser: string; req: number; url: string; background?: boolean }
  | { op: "cdp"; browser: string; req: number; tab: string; method: string; params: CdpParams; session?: string }
  | { op: "front" | "close-tab"; browser: string; tab: string }
  | { op: "close"; browser: string }
  | { op: "erase"; partition: string }
  | { op: "resolved"; req: number; browser: string | null }
);

/** `target`: the page's main frame id, which a CDP client takes as its target id. */
export type PaneToServer = Base & (
  | { op: "hello" }
  | { op: "opened"; browser: string; version: string; userAgent: string }
  /** `reason` "no-window": no app window can host a pane now. */
  | { op: "failed"; browser: string; error: string; reason?: "no-window" }
  | { op: "created"; browser: string; req: number; tab: string; target: string; url: string; title: string }
  | { op: "answer"; browser: string; req: number; result?: CdpParams; error?: { message: string; code?: number } }
  | { op: "event"; browser: string; tab: string; method: string; params: CdpParams; session?: string }
  | { op: "tab"; browser: string; tab: string; target: string; url: string; title: string; opener?: string }
  | { op: "tab-gone"; browser: string; tab: string; crashed?: boolean }
  | { op: "closed"; browser: string; reason: string }
  | { op: "input"; browser: string; tab?: string }
  | { op: "which"; req: number; botId: string; threadId: string | null }
  | { op: "download"; browser: string; tab: string; guid: string; state: "begin" | "inProgress" | "completed" | "canceled"; url?: string; name?: string; received?: number; total?: number; path?: string }
);

export declare const PANE_MESSAGE: "openmausbot:browser-pane";
export declare const PANE_TABS_PER_BROWSER: number;
export declare const PANE_PARTITION: RegExp;
export declare function paneMessageToMain(raw: unknown): PaneToMain | null;
export declare function paneMessageToServer(raw: unknown): PaneToServer | null;
export declare const PANE_UA_HOSTS: Map<string, "electron">;
export declare function paneUserAgent(userAgent: string, host?: string, hosts?: ReadonlyMap<string, "electron">): string;
