// PostHog usage analytics + the email → person identity link.
// The phc_ token is a write-only public key (safe to ship in the client).
// Only the named events below are sent — autocapture is OFF on purpose:
// it would ship the $el_text of clicked elements, and the sidebar/option
// cards render model output and message previews, so it would leak fragments
// of private conversations to a third party. Email submissions call
// identify(), so PostHog's Persons tab doubles as the collected-email list.
import posthog from "posthog-js";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

// Analytics are on by default; Settings → General turns them off. The choice
// lives in localStorage because it has to be readable BEFORE init() runs: an
// opted-out install must never call posthog.init(), so no request — not even
// the library's own — leaves the machine. Once running, opting out routes
// through opt_out_capturing(), which also drops anything already queued.
const OPT_OUT_KEY = "omb-analytics-opt-out";

let ready = false;

// The choice as made in THIS process, which outranks storage. Without it a
// rejected write silently loses an opt-out: the setter would swallow the
// error, the next analyticsEnabled() would read nothing and answer true, and
// a later initAnalytics() would start the client the user just switched off.
// Storage is how the choice survives a restart, not where it lives.
let choice: boolean | undefined;

/** False once the user has opted out on this machine. */
export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true; // storage unreadable → behave like a fresh install
  }
}

/** What flipping the switch has to do, given the new setting and whether the
 * client is already running. A plain function so the decision can be checked
 * without standing up an analytics client to observe. */
export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

/** Flip the setting and act on it immediately, in both directions. */
export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled; // before persisting: the decision must not depend on it
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {
    /* it will not survive a restart, but it holds for this session */
  }
  switch (optAction(enabled, ready)) {
    case "opt-out":
      posthog.opt_out_capturing(); // also drops whatever is still queued
      break;
    case "opt-in":
      posthog.opt_in_capturing();
      break;
    case "init":
      initAnalytics(); // first opt-in of a session that started opted out
      break;
    case "none":
      break;
  }
}

export function initAnalytics() {
  if (ready || !analyticsEnabled()) return;
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: false, // never capture clicked-element text (conversation leak)
    capture_pageview: false, // single-window desktop app — no page routes
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  // opt_out_capturing() persists in PostHog's own storage, so after
  // opt-out → restart → opt-in the client would boot opted out and drop
  // every capture below while the switch says on. Clear the stale flag
  // before the first capture of the session.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  ready = true;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  // one-time install marker — app_first_open counts installs (the closest
  // truth to "downloads that mattered"; raw download counts live on the
  // GitHub release assets)
  if (!localStorage.getItem("omb-installed")) {
    localStorage.setItem("omb-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!ready || !analyticsEnabled()) return;
  posthog.capture(event, props);
}

// Checked here as well as in track(): this is the one call that would send a
// personal identifier, so it must not depend on opt_out_capturing() alone.
// The address is still stored locally in the profile either way — opting out
// stops it from being reported, not from being used.
export function identifyEmail(email: string) {
  if (!ready || !analyticsEnabled()) return;
  posthog.identify(email, { email });
  posthog.capture("email_submitted");
}

// first-run email gate state
const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
