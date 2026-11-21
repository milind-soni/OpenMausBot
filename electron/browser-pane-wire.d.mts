// Types for browser-pane-wire.mjs as the server uses it (server/browser/pane). Keep in step with the implementation.
type CdpParams = Record<string, unknown>;
type Base = { type: "openmausbot:browser-pane" };

export type PaneToMain = Base & (
  | { op: "hello" }
  /** `egress`: the loopback port of the profile's egress gate; every request of its panes goes through it.
   * `downloads`: the folder every download of its panes is saved in, never asked of the person.
   * `identity`: browserEngine.paneIdentity, the user agent its panes present. */
  | { op: "open"; browser: string; partition: string; egress: number; downloads: string; identity: "native" | "cleaned" }
  | { op: "cancel-download"; browser: string; guid: string }
  | { op: "create"; browser: string; req: number; url: string; background?: boolean }
  | { op: "cdp"; browser: string; req: number; tab: string; method: string; params: CdpParams; session?: string }
  | { op: "front" | "close-tab"; browser: string; tab: string }
  | { op: "close"; browser: string }
  | { op: "erase"; partition: string }
  | { op: "resolved"; req: number; browser: string | null }
  /** A sign-in import's cookies, written into a pane's partition by the main process. */
  | { op: "set-cookies"; req: number; partition: string; cookies: PaneCookie[] }
  | { op: "cookie-sources-result"; req: number; sources: CookieSource[] }
  | { op: "cookie-import-result"; req: number; result: CookieImportResult }
  | { op: "cookie-offer-result"; req: number; offered: boolean; reason?: string }
  | { op: "hold-result"; req: number; held: boolean }
);

/** Electron's cookies.set details. */
export interface PaneCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

export interface CookieSource {
  id: string;
  name: string;
  engine: "chromium" | "firefox" | "safari";
  profiles: Array<{ id: string; name: string }>;
}

/** Counts and a reason code only: never a cookie. */
export type CookieImportResult =
  | { ok: true; site: string; imported: number; sessionOnly: number; skipped: Partial<Record<string, number>> }
  | { ok: false; reason: string };

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
  | { op: "cookies-set"; req: number; written: number; refused: number }
  /** The person, at the app's own window, asks: which browsers can be imported from, whether a site can, and to do it. */
  | { op: "cookie-sources"; req: number }
  | { op: "cookie-offer"; req: number; botId: string; threadId: string | null; site: string }
  | { op: "cookie-import"; req: number; botId: string; threadId: string | null; site: string; source: string; profile: string }
  /** The person takes the tab the panel shows from the bot, or hands it back; every hold ends when the window goes. */
  | { op: "hold"; req: number; botId: string; threadId: string | null; browser: string; tab: string; held: boolean }
  | { op: "let-go" }
  | { op: "download"; browser: string; tab: string; guid: string; state: "begin" | "inProgress" | "completed" | "canceled"; url?: string; name?: string; received?: number; total?: number; path?: string }
);

export declare const PANE_MESSAGE: "openmausbot:browser-pane";
export declare const PANE_TABS_PER_BROWSER: number;
export declare const PANE_PARTITION: RegExp;
export declare function paneMessageToMain(raw: unknown): PaneToMain | null;
export declare function paneMessageToServer(raw: unknown): PaneToServer | null;

