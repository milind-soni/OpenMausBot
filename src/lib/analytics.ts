// PostHog usage analytics — OFF unless a project token is supplied at build
// time (VITE_POSTHOG_TOKEN). When it is set: explicit product-funnel events
// plus click autocapture only; typed text (prompts, keys) is never captured.
// The SDK is loaded lazily so builds without a token don't ship it.
import type { PostHog } from "posthog-js";

const TOKEN = import.meta.env.VITE_POSTHOG_TOKEN?.trim() ?? "";

let posthog: PostHog | null = null;
let started = false;

export const analyticsEnabled = TOKEN.length > 0;

export function initAnalytics() {
  if (started || !analyticsEnabled) return;
  started = true;
  void import("posthog-js").then(({ default: client }) => {
    client.init(TOKEN, {
      api_host: "https://us.i.posthog.com",
      autocapture: { dom_event_allowlist: ["click"] },
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      capture_pageview: false, // single-window desktop app — no page routes
      person_profiles: "identified_only",
      persistence: "localStorage",
    });
    posthog = client;
    const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
    // one-time install marker — app_first_open counts installs
    if (!localStorage.getItem("gbs-installed")) {
      localStorage.setItem("gbs-installed", new Date().toISOString());
      client.capture("app_first_open", { platform });
    }
    client.capture("app_opened", { platform });
  }).catch(() => {});
}

export function track(event: string, props?: Record<string, unknown>) {
  posthog?.capture(event, props);
}

export function identifyEmail(email: string) {
  if (!posthog) return;
  posthog.identify(email, { email });
  posthog.capture("email_submitted");
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
