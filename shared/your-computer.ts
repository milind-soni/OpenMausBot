// The person's own computer (their screen, their apps, the browsers they are signed in to) is never covered by an approval
// level, "Just do it" included: before a bot first touches it in a turn, the person is asked once, in these words. The
// English mirrors src/locales/en.json `approval.yourComputer.*` exactly (a test holds them together): the server has no i18n.

/** What a bot's first call on the person's computer names, cleaned for a sentence they read. */
export interface YourComputerCall {
  /** The app's everyday name: "Chrome", "Safari", "Keynote". */
  app?: string;
  /** A host name only, never a path or query: "calendar.google.com". */
  site?: string;
}

export const YOUR_COMPUTER_WORDS = {
  "approval.yourComputer.browserSite": "I need to use your {app} where you're signed in to {site}. Allow once?",
  "approval.yourComputer.browser": "I need to use your {app} where you're signed in. Allow once?",
  "approval.yourComputer.site": "I need to use your browser where you're signed in to {site}. Allow once?",
  "approval.yourComputer.app": "I need to use {app} on your computer. Allow once?",
  "approval.yourComputer.screen": "I need to use your computer's screen for this. Allow once?",
  "approval.yourComputer.detail": "{name} would see your screen and click and type on it, for this request only.",
} as const;

export type YourComputerKey = keyof typeof YOUR_COMPUTER_WORDS;

/** The card's tool name: no engine has a tool by this name, and "Always allow" is never offered for it. */
export const YOUR_COMPUTER_TOOL = "use_your_computer";

/** A failed turn's line starts with this when the desktop app's own driver is not ready; the app adds the permission fix. */
export const THIS_COMPUTER_NOT_READY = "OpenMausBot can't use this computer yet — ";

const BROWSERS: Record<string, string> = {
  chrome: "Chrome", "google chrome": "Chrome", chromium: "Chromium", safari: "Safari", firefox: "Firefox",
  "mozilla firefox": "Firefox", edge: "Edge", "microsoft edge": "Edge", msedge: "Edge", brave: "Brave", "brave browser": "Brave",
  arc: "Arc", opera: "Opera", vivaldi: "Vivaldi",
};

const BUNDLES: Record<string, string> = {
  "com.google.chrome": "Chrome", "com.google.chrome.beta": "Chrome", "com.google.chrome.canary": "Chrome",
  "org.chromium.chromium": "Chromium", "com.apple.safari": "Safari", "com.apple.safaritechnologypreview": "Safari",
  "org.mozilla.firefox": "Firefox", "com.microsoft.edgemac": "Edge", "com.brave.browser": "Brave",
  "company.thebrowser.browser": "Arc", "com.operasoftware.opera": "Opera", "com.vivaldi.vivaldi": "Vivaldi",
};

/** An app name a person would recognise, or nothing: at most three words of letters, digits and a few joiners, so a
 * bot cannot write a sentence of its own into the question. */
export function cleanAppName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\.(?:app|exe)$/i, "");
  if (!name || name.length > 28 || name.split(" ").length > 3 || !/^[\p{L}\p{N}](?:[\p{L}\p{N}&'+-]| (?! ))*$/u.test(name)) return undefined;
  return BROWSERS[name.toLowerCase()] ?? name;
}

/** A bare host name, without "www.", or nothing: never a path, a query, a port or anything a page could fill with words. */
export function cleanSiteName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 253) return undefined;
  const host = value.trim().toLowerCase().replace(/^www\./, "");
  return /^(?=.{1,100}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : undefined;
}

function siteOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? cleanSiteName(parsed.hostname) : undefined;
  } catch {
    return undefined;
  }
}

function appOfBundle(bundle: unknown): string | undefined {
  if (typeof bundle !== "string") return undefined;
  const known = BUNDLES[bundle.trim().toLowerCase()];
  if (known) return known;
  const last = bundle.trim().split(".").pop() ?? "";
  return /^[A-Za-z][A-Za-z0-9]{1,30}$/.test(last) ? cleanAppName(last.charAt(0).toUpperCase() + last.slice(1)) : undefined;
}

/** From one MCP tools/call frame, what it would open: launch_app's app and first web address, or a page it navigates to. */
export function describeComputerCall(frame: unknown): YourComputerCall {
  const params = (frame as { params?: { name?: unknown; arguments?: Record<string, unknown> } } | null)?.params;
  const args = params?.arguments;
  if (!args || typeof args !== "object") return {};
  const app = params?.name === "launch_app" ? appOfBundle(args.bundle_id) ?? cleanAppName(args.name) : undefined;
  const urls = Array.isArray(args.urls) ? args.urls : [];
  const site = urls.map(siteOf).find(Boolean) ?? siteOf(args.url);
  return { ...(app ? { app } : {}), ...(site ? { site } : {}) };
}

/** The question for this call, as a catalog key and its values. */
export function yourComputerQuestion(call: YourComputerCall = {}): { key: YourComputerKey; params: Record<string, string> } {
  const app = cleanAppName(call.app);
  const site = cleanSiteName(call.site);
  const browser = app && Object.values(BROWSERS).includes(app) ? app : undefined;
  if (browser && site) return { key: "approval.yourComputer.browserSite", params: { app: browser, site } };
  if (browser) return { key: "approval.yourComputer.browser", params: { app: browser } };
  if (site) return { key: "approval.yourComputer.site", params: { site } };
  if (app) return { key: "approval.yourComputer.app", params: { app } };
  return { key: "approval.yourComputer.screen", params: {} };
}

export function yourComputerText(key: YourComputerKey, params: Record<string, string>): string {
  return YOUR_COMPUTER_WORDS[key].replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}
