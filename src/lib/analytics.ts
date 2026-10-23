// The phc_ token is a write-only public key, safe to ship in the client.
// posthog-js loads on demand: a static import would put ~240 kB into the startup bundle.
import type { CaptureResult, PostHog } from "posthog-js";
import { DESKTOP_PORTS } from "../../electron/desktop-ports.mjs";
import { appVersion } from "@/lib/app-links";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

// Read before init(): an opted-out install must never call posthog.init(), so no request leaves the machine.
const OPT_OUT_KEY = "omb-analytics-opt-out";
// The desktop app's own page is served on whichever of its ports was free, and each port has its own storage.
const desktopSwitch = () => globalThis.window?.ogb?.desktopAnalytics;

/** False on the desktop app's own page while the app keeps no switch and the page is not on its first port, whose
 * storage may hold an opt-out saved before the app kept the switch. */
export function analyticsChoiceKnown(): boolean {
  const desktop = desktopSwitch();
  return !desktop?.set || desktop.enabled() !== null || globalThis.location?.port === String(DESKTOP_PORTS[0]);
}

let client: PostHog | undefined;
let loading: Promise<void> | undefined;
let pending: Array<(ph: PostHog) => void> = [];

// Outranks storage, so a rejected write cannot lose an opt-out.
let choice: boolean | undefined;

export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  const desktop = desktopSwitch()?.enabled();
  if (typeof desktop === "boolean") return desktop;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true;
  }
}

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled;
  void desktopSwitch()?.set?.(enabled).catch(() => {});
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {
  }
  if (!enabled) pending = [];
  switch (optAction(enabled, client !== undefined)) {
    case "opt-out":
      client?.opt_out_capturing();
      break;
    case "opt-in":
      client?.opt_in_capturing({ captureEventName: false });
      break;
    case "init":
      void initAnalytics();
      break;
    case "none":
      break;
  }
}

function keepStoredOptOut() {
  const desktop = desktopSwitch();
  if (!desktop?.set || desktop.enabled() !== null) return;
  try {
    if (localStorage.getItem(OPT_OUT_KEY) !== "1") return;
  } catch {
    return;
  }
  void desktop.set(false).catch(() => {});
}

export function initAnalytics(): Promise<void> {
  keepStoredOptOut();
  if (client || !analyticsEnabled()) return Promise.resolve();
  loading ??= import("posthog-js")
    .then(({ default: posthog }) => start(posthog))
    .catch(() => {
      pending = [];
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

function start(posthog: PostHog) {
  if (!analyticsEnabled()) {
    pending = [];
    return;
  }
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: false, // never capture clicked-element text (conversation leak)
    capture_pageview: false,
    person_profiles: "identified_only",
    persistence: "localStorage",
    // PostHog's remote config `surveys: false` still fetches surveys.js.
    disable_surveys: true,
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    before_send: withoutLocation,
    // Security: posthog-js 1.415 posts /flags on load and every 5 minutes, even after opt_out_capturing(), with the stored
    // person properties (the first page's URL and referrer), and before_send never sees it. The app reads no flags.
    advanced_disable_flags: true,
  });
  // Security: posthog-js 1.415 stores the first page's URL and referrer under these keys while save_referrer or
  // save_campaign_params is on, and keeps them after both are turned off.
  for (const key of ["$initial_person_info", "$initial_referrer_info", "$initial_campaign_params"]) posthog.unregister(key);
  // opt_out_capturing() persists in PostHog's own storage, so a later opt-in would boot opted out.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
  client = posthog;
  posthog.register({ app_version: appVersion(), surface: analyticsSurface() });
  const platform = pagePlatform();
  if (!localStorage.getItem("omb-installed")) {
    localStorage.setItem("omb-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
  watchActiveDays();
  for (const call of pending.splice(0)) call(posthog);
}

function pagePlatform() {
  return navigator.userAgent.includes("Electron") ? "desktop" : "browser";
}

const ACTIVE_DAY_KEY = "omb-analytics-active-day";
const ACTIVE_CHECK_MS = 10 * 60_000;

function localDay(now = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

let activeDay: string | undefined;

function claimActiveDay(day: string): boolean {
  if (activeDay === day) return false;
  try {
    if (localStorage.getItem(ACTIVE_DAY_KEY) === day) return false;
  } catch {}
  activeDay = day;
  try {
    localStorage.setItem(ACTIVE_DAY_KEY, day);
  } catch {}
  return true;
}

function sendAppActive() {
  if (!client || !analyticsEnabled() || globalThis.document?.visibilityState !== "visible") return;
  if (claimActiveDay(localDay())) client.capture("app_active", { platform: pagePlatform() });
}

function watchActiveDays() {
  if (!globalThis.document) return;
  sendAppActive();
  document.addEventListener("visibilitychange", sendAppActive);
  window.addEventListener("focus", sendAppActive);
  setInterval(() => {
    if (document.hasFocus()) sendAppActive();
  }, ACTIVE_CHECK_MS);
}

// Security: posthog-js 1.415 adds the page's address to every event and person update: URL, host, path, referrer and
// campaign parameters, again as $initial_* and $session_entry_* copies. On a Cloud page that is the tenant's host, and
// query strings carry ids, so none of it may leave.
const LOCATION = new Set([
  "current_url", "url", "host", "pathname", "prev_pageview_pathname", "referrer", "referring_domain", "search_engine",
  "ph_keyword", "gad_source", "mc_cid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "fbclid", "msclkid", "twclid",
  "li_fat_id", "igshid", "ttclid", "rdt_cid", "epik", "qclid", "sccid", "irclid", "_kx",
]);

export function locationProperty(key: string): boolean {
  const base = key.replace(/^\$/, "").replace(/^(?:initial_|session_entry_)/, "");
  return base.startsWith("utm_") || LOCATION.has(base);
}

function dropLocation(record: unknown) {
  if (!record || typeof record !== "object") return;
  for (const key of Object.keys(record)) if (locationProperty(key)) delete (record as Record<string, unknown>)[key];
}

export function withoutLocation(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  for (const part of [event.properties, event.$set, event.$set_once, event.properties?.$set, event.properties?.$set_once]) dropLocation(part);
  return event;
}

export function analyticsSurface(): "local" | "server" {
  return globalThis.window?.ogb?.environments ? "local" : "server";
}

function whenReady(call: (ph: PostHog) => void) {
  if (!analyticsEnabled()) return;
  if (client) call(client);
  else if (loading) pending.push(call);
}

export function track(event: string, props?: Record<string, unknown>) {
  whenReady((ph) => ph.capture(event, props));
}

// Sends a personal identifier, so it is gated on analyticsEnabled(), not on opt_out_capturing() alone.
export function identifyEmail(email: string, { submitted = true }: { submitted?: boolean } = {}) {
  whenReady((ph) => {
    ph.identify(email, { email });
    if (submitted) ph.capture("email_submitted");
  });
}

const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
