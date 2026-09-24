// PostHog usage analytics — OFF unless a project token is supplied at build
// time (VITE_POSTHOG_TOKEN). When it is set: explicit product-funnel events
// plus click autocapture only; typed text (prompts, keys) is never captured.
// The SDK is loaded lazily so builds without a token don't ship it.
import type { PostHog } from "posthog-js";

const TOKEN = import.meta.env.VITE_POSTHOG_TOKEN?.trim() ?? "";
const CONSENT_KEY = "gbs-usage-analytics";

let posthog: PostHog | null = null;
let started = false;

export const analyticsEnabled = TOKEN.length > 0;

export function usageAnalyticsEnabled(): boolean {
  try {
    return analyticsEnabled && typeof localStorage !== "undefined" && localStorage.getItem(CONSENT_KEY) === "true";
  } catch {
    return false;
  }
}

export function setUsageAnalyticsEnabled(enabled: boolean): boolean {
  if (enabled && !analyticsEnabled) return false;
  try {
    localStorage.setItem(CONSENT_KEY, String(enabled));
  } catch {
    return false;
  }
  if (enabled) {
    if (posthog) posthog.opt_in_capturing();
    else initAnalytics();
  } else {
    posthog?.opt_out_capturing();
  }
  return true;
}

export function initAnalytics() {
  if (started || !usageAnalyticsEnabled()) return;
  started = true;
  void import("posthog-js").then(({ default: client }) => {
    if (!usageAnalyticsEnabled()) {
      started = false;
      return;
    }
    client.init(TOKEN, {
      api_host: "https://us.i.posthog.com",
      autocapture: { dom_event_allowlist: ["click"] },
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      capture_pageview: false, // single-window desktop app — no page routes
      person_profiles: "identified_only",
      persistence: "localStorage",
      opt_out_capturing_by_default: true,
    });
    posthog = client;
    client.opt_in_capturing();
    const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
    // one-time install marker — app_first_open counts installs
    if (!localStorage.getItem("gbs-installed")) {
      localStorage.setItem("gbs-installed", new Date().toISOString());
      client.capture("app_first_open", { platform });
    }
    client.capture("app_opened", { platform });
  }).catch(() => { started = false; });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (usageAnalyticsEnabled()) posthog?.capture(event, props);
}

// first-run email gate state
const GATE_KEY = "gbs-email-gate";
export function emailGateDone(): boolean {
  try {
    return Boolean(typeof localStorage !== "undefined" && localStorage.getItem(GATE_KEY));
  } catch {
    return false;
  }
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(GATE_KEY, status);
    }
  } catch {}
}
