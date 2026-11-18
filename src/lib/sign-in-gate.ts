import { analyticsSurface, initAnalytics, track } from "@/lib/analytics";

const SIGN_IN_GATE = ["signed_out", "session_ended", "team_left", "service_trust"] as const;
export type SignInGate = (typeof SIGN_IN_GATE)[number];

/** The desktop app's own page opened on its sign-in page instead of the app, where nothing else is tracked. A server's
 * page sends nothing here: its sign-in page is where anyone not signed in lands. */
export function signInGateShown(reason: SignInGate): void {
  if (analyticsSurface() !== "local") return;
  void initAnalytics();
  track("sign_in_gate", { reason: SIGN_IN_GATE.includes(reason) ? reason : "other" });
}
