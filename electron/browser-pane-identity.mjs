// Which user agent a bot's browser pane presents. Electron's own, with only the app's product token taken out, is
// the default: Cloudflare's full-page check and Turnstile refuse a Chromium UA without Electron's token, and Google
// refuses sign-in from any identity that claims another browser. Client hints are never touched: Chromium's own
// (Chromium and a GREASE brand, no Google Chrome brand) already match Electron's UA.

/** "native": Electron's UA without the app token. "cleaned": also without `Electron/`, for a person who needs it. */
export const PANE_IDENTITY_MODES = Object.freeze(["native", "cleaned"]);

/**
 * Sites with their own rule. `identity`: "electron" is Electron's UA without the app token in either mode,
 * "no-electron-token" drops `Electron/` (in native mode only), "chrome-shaped" is the cleaned UA. `where`: "request"
 * changes only the request header; "tab" also the page's own `navigator.userAgent`. Add a site only after a reproduced
 * failure.
 */
export const PANE_IDENTITY_RULES = Object.freeze([
  // Google refuses sign-in from an identity claiming another browser. Subresources a sign-in page loads count too.
  Object.freeze({ hosts: Object.freeze(["accounts.google.com", "accounts.youtube.com"]), subdomains: false, identity: "electron", where: "request", referrer: true }),
  // Teams' server sends a request with Electron's UA to a blank page; its page script accepts Electron.
  Object.freeze({ hosts: Object.freeze(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]), subdomains: false, identity: "no-electron-token", where: "request", referrer: false }),
  // Chase's sign-in script sends any Electron UA to its "System Requirements" page.
  Object.freeze({ hosts: Object.freeze(["chase.com"]), subdomains: true, identity: "chrome-shaped", where: "tab", referrer: false }),
]);

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Every product token between the engine comment and `Chrome/`: the app's own name and version. */
export function withoutAppToken(userAgent) {
  return String(userAgent).replace(/(\(KHTML, like Gecko\)\s+)(?:[^\s()]+\s+)*?(Chrome\/)/, "$1$2");
}

export function withoutElectronToken(userAgent) {
  return String(userAgent).replace(/\s+Electron\/\S+/, "");
}

export function paneIdentityMode(value) {
  return value === "cleaned" ? "cleaned" : "native";
}

/** The pane's own UA: its session's, and so every page's and worker's unless a rule says otherwise. */
export function paneBaseUserAgent(electronUserAgent, mode) {
  const native = withoutAppToken(electronUserAgent);
  return paneIdentityMode(mode) === "cleaned" ? withoutElectronToken(native) : native;
}

function ruleFor(host) {
  if (!host) return null;
  return PANE_IDENTITY_RULES.find((rule) => rule.hosts.some((name) => host === name || (rule.subdomains && host.endsWith(`.${name}`)))) ?? null;
}

function identityOf(rule, electronUserAgent, mode) {
  const native = withoutAppToken(electronUserAgent);
  if (rule.identity === "electron") return native;
  if (rule.identity === "chrome-shaped") return withoutElectronToken(native);
  return paneIdentityMode(mode) === "native" ? withoutElectronToken(native) : paneBaseUserAgent(electronUserAgent, mode);
}

/** The User-Agent header of one request: `resourceType` and `referrer` as Electron's onBeforeSendHeaders reports them. */
export function paneRequestUserAgent(electronUserAgent, mode, { url, referrer = "", resourceType = "" }) {
  const rule = ruleFor(hostOf(url));
  if (rule) return identityOf(rule, electronUserAgent, mode);
  const from = ruleFor(hostOf(referrer));
  if (from?.referrer && resourceType !== "mainFrame") return identityOf(from, electronUserAgent, mode);
  return paneBaseUserAgent(electronUserAgent, mode);
}

/** The UA a tab's page itself reports while its main frame is at `url`. */
export function paneTabUserAgent(electronUserAgent, mode, url) {
  const rule = ruleFor(hostOf(url));
  return rule?.where === "tab" ? identityOf(rule, electronUserAgent, mode) : paneBaseUserAgent(electronUserAgent, mode);
}
